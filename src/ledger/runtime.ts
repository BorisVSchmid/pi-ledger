/**
 * Ledger-mode runtime: the I/O around the pure monitor.
 *
 *  before_agent_start → take the turn baseline (MEMENTO.md + model-file snapshot)
 *  tool_call (bash)   → append matching run commands to runs.jsonl
 *  agent_settled      → D1–D5 + injection, route, steer or notify, write FLAGS.md, persist
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { LedgerConfig } from './config.js';
import {
  diffSnapshots,
  hashText,
  snapshotFiles,
  type Snapshot,
  type SnapshotDiff,
} from './checks.js';
import { evaluateTurn, routeFindings, type FindingKind } from './monitor.js';
import { addNotice, bump, LedgerStateStore, type LedgerState } from './state.js';
import { renderFlagsFile } from './flags-file.js';
import {
  addFlagResult,
  applyEdits,
  renderRegister,
  specStatements,
  syncFromSpec,
  type Flag,
} from './register.js';
import { callJson } from './model-call.js';
import { COMPACTION_NOTE_PROMPT, LEDGER_TURN_PROMPT, REVIEWER_PROMPT } from './prompts.js';
import {
  automaticTrigger,
  buildReviewerPrompt,
  buildTurnPrompt,
  coerceTurnFindings,
  verifyTurnFindings,
  coerceReviewerOutput,
  coerceStaleItems,
  pickAgentSummary,
  renderCompactionNote,
  reviewNotice,
  verifyReview,
  verifyStaleItems,
  type ReviewReason,
  type VerifyContext,
} from './reviewer.js';

/** Snapshot of model files at the last review, so [Model Edits] spans all turns since. */
const REVIEW_SNAPSHOT_FILE = '.pi/supervisor-review-snapshot.json';
export const COMPACTION_NOTE_TYPE = 'supervisor-compaction-note';

/** A project may override a built-in prompt with .pi/<name>. */
async function loadPrompt(cwd: string, name: string, builtin: string): Promise<string> {
  return (await readTextOrNull(path.join(cwd, '.pi', name)))?.trim() || builtin;
}

/** Text of the last user message on the branch. */
export function lastUserText(ctx: ExtensionContext): string {
  const entries = ctx.sessionManager.getBranch() as Array<{
    type: string;
    message?: { role?: string; content?: unknown };
  }>;
  for (let i = entries.length - 1; i >= 0; i--) {
    const m = entries[i].message;
    if (entries[i].type !== 'message' || m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .filter((b: { type?: string }) => b?.type === 'text')
        .map((b: { text?: string }) => b.text ?? '')
        .join('\n');
    }
    return '';
  }
  return '';
}

/** Visible text of every assistant message on the branch, oldest first. */
export function assistantTexts(ctx: ExtensionContext): string[] {
  const out: string[] = [];
  for (const entry of ctx.sessionManager.getBranch() as Array<{
    type: string;
    message?: { role?: string; content?: unknown };
  }>) {
    if (entry.type !== 'message' || entry.message?.role !== 'assistant') continue;
    const c = entry.message.content;
    if (typeof c === 'string') out.push(c);
    else if (Array.isArray(c)) {
      out.push(
        c
          .filter((b: { type?: string }) => b?.type === 'text')
          .map((b: { text?: string }) => b.text ?? '')
          .join('\n')
      );
    }
  }
  return out;
}

interface Baseline {
  ledger: string | null;
  snapshot: Snapshot;
}

export async function readTextOrNull(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** Visible text of the last assistant message on the branch (text blocks only). */
export function lastAssistantText(ctx: ExtensionContext): string {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type: string; message?: { role?: string; content?: unknown } };
    if (entry.type !== 'message' || entry.message?.role !== 'assistant') continue;
    const content = entry.message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((b: { type?: string }) => b?.type === 'text')
        .map((b: { text?: string }) => b.text ?? '')
        .join('\n');
    }
    return '';
  }
  return '';
}

/** True if any command segment starts with one of the configured run commands. */
export function matchRunCommand(command: string, runCommands: string[]): boolean {
  return command
    .split(/&&|\|\||;|\n/)
    .map((seg) => seg.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, ''))
    .some((seg) => {
      const first = seg.split(/\s+/)[0] ?? '';
      const base = first.split('/').pop() ?? '';
      return runCommands.some((rc) => base === rc || first === rc);
    });
}

export class LedgerRuntime {
  readonly store: LedgerStateStore;
  private baseline: Baseline | null = null;
  /** Model-file changes of the last completed turn (input for reviewer triggers). */
  lastTurnDiff: SnapshotDiff | null = null;
  /** Snapshot at the end of the last turn; the next turn's baseline if none was taken. */
  private lastSnapshot: Snapshot | null = null;

  /** Injectable for tests. */
  callModel: typeof callJson = callJson;
  /** The review currently running, if any (one at a time). */
  pending: Promise<unknown> | null = null;
  /** The compaction note currently running, if any. */
  pendingNote: Promise<unknown> | null = null;
  /** The optional per-turn model check currently running, if any. */
  pendingTurn: Promise<unknown> | null = null;

  constructor(private pi: ExtensionAPI) {
    this.store = new LedgerStateStore(pi);
  }

  state(): LedgerState {
    return this.store.get();
  }

  load(ctx: ExtensionContext): void {
    this.store.load(ctx);
    this.baseline = null;
    this.lastTurnDiff = null;
    this.lastSnapshot = null;
  }

  private ledgerPath(ctx: ExtensionContext, config: LedgerConfig): string {
    return path.resolve(ctx.cwd, config.files.ledger);
  }

  snapshot(ctx: ExtensionContext, config: LedgerConfig): Promise<Snapshot> {
    return snapshotFiles(ctx.cwd, config.files.modelFiles, 400_000, config.files.ignore);
  }

  /** Take the baseline once per run; queued prompts before settlement keep the first one. */
  async onAgentStart(ctx: ExtensionContext, config: LedgerConfig): Promise<void> {
    if (this.baseline) return;
    const [ledger, snapshot] = await Promise.all([
      readTextOrNull(this.ledgerPath(ctx, config)),
      this.snapshot(ctx, config),
    ]);
    this.baseline = { ledger, snapshot };
  }

  async onToolCall(
    event: { toolName: string; input: unknown },
    ctx: ExtensionContext,
    config: LedgerConfig
  ): Promise<void> {
    if (event.toolName !== 'bash') return;
    const cmd = (event.input as { command?: unknown })?.command;
    if (typeof cmd !== 'string' || !matchRunCommand(cmd, config.monitor.runCommands)) return;
    const file = path.resolve(ctx.cwd, config.files.runs);
    const line = JSON.stringify({ turn: this.state().turn + 1, ts: Date.now(), cmd, cwd: ctx.cwd });
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, line + '\n', 'utf8');
    } catch {
      // Never block the agent on bookkeeping.
    }
  }

  async onSettled(ctx: ExtensionContext, config: LedgerConfig): Promise<void> {
    const state = this.state();
    state.turn++;

    const ledgerAfter = await readTextOrNull(this.ledgerPath(ctx, config));
    const after = await this.snapshot(ctx, config);
    const baseline = this.baseline;
    this.baseline = null;

    // Without a baseline (extension loaded mid-run), fall back to the end of the last turn.
    const ledgerBefore: string | null | undefined = baseline
      ? baseline.ledger
      : state.previousLedgerHash !== null || state.previousLedgerText !== null
        ? state.previousLedgerText
        : undefined;
    const before = baseline?.snapshot ?? this.lastSnapshot;
    const modelDiff = before ? diffSnapshots(before, after) : null;
    this.lastTurnDiff = modelDiff;
    this.lastSnapshot = after;
    if (modelDiff && modelDiff.hunks.length + modelDiff.removed.length > 0) {
      state.unreviewedEdits = true;
    }

    const assistantText = lastAssistantText(ctx);
    const findings = evaluateTurn({
      assistantText,
      ledgerBefore,
      ledgerAfter,
      modelDiff,
      lockedHeadings: config.monitor.lockedHeadings,
      cjkRatioMax: config.monitor.cjkRatioMax,
    });

    const ledgerHash = ledgerAfter === null ? null : hashText(ledgerAfter);
    const routed = routeFindings(findings, {
      autoSteer: config.routing.autoSteer as FindingKind[],
      steerHistory: config.routing.neverRepeatSteer ? state.steerHistory : [],
      ledgerHash,
    });

    for (const f of findings) bump(state, `finding.${f.kind}`);
    if (routed.suppressedSteers) bump(state, 'steer.suppressed', routed.suppressedSteers);

    let newNotices = 0;
    for (const n of routed.notices) {
      const key = `${n.kind}:${hashText(n.detail)}:${ledgerHash ?? 'none'}`;
      if (addNotice(state, { ...n, turn: state.turn, ts: Date.now() }, key)) {
        newNotices++;
        ctx.ui.notify(`Supervisor: ${n.kind} — ${n.detail}`, 'warning');
      }
    }

    state.previousLedgerText = ledgerAfter;
    state.previousLedgerHash = ledgerHash;

    if (routed.steer) {
      state.steerHistory.push(routed.steer.key);
      bump(state, 'steer.sent');
    }
    this.store.persist();

    if (newNotices > 0) await this.writeFlags(ctx, config);
    if (routed.steer) this.pi.sendUserMessage(routed.steer.text, { deliverAs: 'followUp' });

    const specChanged = await this.checkSpec(ctx, config);

    const reason = automaticTrigger({
      turn: state.turn,
      lastReviewTurn: state.lastReviewTurn,
      turnDiff: modelDiff,
      modelEditsSinceReview: state.unreviewedEdits,
      register: state.register,
      registerGrewLastReview: state.registerGrewLastReview,
      specChanged,
      ledgerBefore,
      ledgerAfter,
      triggers: config.reviewer.triggers,
    });
    if (reason) this.startReview(ctx, config, reason);

    if (config.turnModel && !this.pendingTurn) {
      const input = {
        ledger: ledgerAfter,
        ledgerBefore,
        userText: lastUserText(ctx),
        assistantText,
        turnDiff: modelDiff,
      };
      this.pendingTurn = this.turnCheck(ctx, config, input)
        .catch((err) => ctx.ui.notify(`Supervisor: turn check failed (${String(err)})`, 'warning'))
        .finally(() => {
          this.pendingTurn = null;
        });
    }
  }

  /** Optional per-turn model check (turnModel): verified findings become TURN_FINDING notices. */
  async turnCheck(
    ctx: ExtensionContext,
    config: LedgerConfig,
    input: Parameters<typeof buildTurnPrompt>[0]
  ): Promise<void> {
    const state = this.state();
    const result = await this.callModel(ctx, {
      model: config.turnModel,
      fallbackModel: null,
      systemPrompt: await loadPrompt(ctx.cwd, 'LEDGER_TURN.md', LEDGER_TURN_PROMPT),
      userPrompt: buildTurnPrompt(input),
    });
    const findings = result.ok ? coerceTurnFindings(result.json) : undefined;
    if (!findings) {
      bump(state, 'turn_check.failed');
      this.store.persist();
      return;
    }
    const turnText = `${input.userText}\n${input.assistantText}`;
    const { kept, dropped } = verifyTurnFindings(findings, turnText, input.turnDiff, input.ledger);
    bump(state, 'turn_check.dropped_unverified', dropped);
    let added = 0;
    for (const f of kept) {
      const detail = `${f.kind}: "${f.quote.trim()}"${f.note ? ` — ${f.note.trim()}` : ''}`;
      const key = `TURN_FINDING:${hashText(f.kind + f.quote)}`;
      if (
        addNotice(state, { kind: 'TURN_FINDING', detail, turn: state.turn, ts: Date.now() }, key)
      ) {
        added++;
        bump(state, 'finding.TURN_FINDING');
        ctx.ui.notify(`Supervisor: ${detail}`, 'warning');
      }
    }
    this.store.persist();
    if (added) await this.writeFlags(ctx, config);
  }

  // ---------- reviewer ----------

  private verifyContext(
    config: LedgerConfig,
    snapshot: Snapshot,
    ledger: string | null,
    spec: string | null
  ): VerifyContext {
    return { snapshot, ledger, ledgerName: config.files.ledger, spec, specName: config.files.spec };
  }

  /** Start a review in the background unless one is running. Returns false if busy. */
  startReview(
    ctx: ExtensionContext,
    config: LedgerConfig,
    reason: ReviewReason,
    note?: string
  ): boolean {
    if (this.pending) return false;
    this.pending = this.review(ctx, config, reason, note)
      .catch((err) => ctx.ui.notify(`Supervisor: review failed (${String(err)})`, 'warning'))
      .finally(() => {
        this.pending = null;
      });
    return true;
  }

  async review(
    ctx: ExtensionContext,
    config: LedgerConfig,
    reason: ReviewReason,
    note?: string
  ): Promise<void> {
    const state = this.state();
    const [ledger, spec, snapshot, previous] = await Promise.all([
      readTextOrNull(this.ledgerPath(ctx, config)),
      readTextOrNull(path.resolve(ctx.cwd, config.files.spec)),
      this.snapshot(ctx, config),
      readTextOrNull(path.resolve(ctx.cwd, REVIEW_SNAPSHOT_FILE)),
    ]);
    let before: Snapshot | null = null;
    try {
      before = previous ? (JSON.parse(previous) as Snapshot) : null;
    } catch {
      before = null;
    }

    // Spec renames reach the register before the reviewer sees it.
    if (spec) this.applySpec(spec);

    const userPrompt = buildReviewerPrompt({
      spec,
      register: state.register,
      ledger,
      snapshot,
      editsSinceReview: before ? diffSnapshots(before, snapshot) : null,
      agentSummary: pickAgentSummary(assistantTexts(ctx)),
      note,
      maxModelFileChars: config.reviewer.maxModelFileChars,
      inputs: config.reviewer.inputs,
    });

    ctx.ui.notify(`Supervisor: reviewing the model (${reason})…`, 'info');
    bump(state, `review.${reason}`);
    const result = await this.callModel(ctx, {
      model: config.reviewer.model,
      fallbackModel: config.reviewer.fallbackModel,
      thinking: config.reviewer.thinking,
      systemPrompt: await loadPrompt(ctx.cwd, 'REVIEWER.md', REVIEWER_PROMPT),
      userPrompt,
    });
    const output = result.ok ? coerceReviewerOutput(result.json) : undefined;
    if (!output) {
      bump(state, 'review.failed');
      this.store.persist();
      ctx.ui.notify(
        `Supervisor: review produced nothing usable (${result.ok ? 'unexpected JSON' : result.error}).`,
        'warning'
      );
      return;
    }

    const verified = verifyReview(output, this.verifyContext(config, snapshot, ledger, spec));
    const reg = state.register;
    const sizeBefore = Object.values(reg.concepts).reduce(
      (n, c) => n + 1 + c.realizations.length,
      0
    );
    applyEdits(reg, verified.edits, state.turn);
    const sizeAfter = Object.values(reg.concepts).reduce(
      (n, c) => n + 1 + c.realizations.length,
      0
    );
    const created: Flag[] = [];
    const repeatOf: string[] = [];
    for (const f of verified.flags) {
      const r = addFlagResult(reg, f, state.turn);
      if (r.flag) created.push(r.flag);
      else if (r.repeatOf) repeatOf.push(r.repeatOf);
    }
    if (verified.restatement) reg.restatement = { text: verified.restatement, turn: state.turn };

    state.lastReviewTurn = state.turn;
    state.registerGrewLastReview = sizeAfter > sizeBefore;
    state.unreviewedEdits = false;
    bump(state, 'review.done');
    bump(state, 'review.flags_new', created.length);
    bump(state, 'review.flags_repeat', repeatOf.length);
    bump(state, 'review.flags_dropped_unverified', verified.droppedFlags);
    bump(state, 'review.edits_dropped_unverified', verified.droppedEdits);
    this.store.persist();

    await this.writeFile(ctx, REVIEW_SNAPSHOT_FILE, JSON.stringify(snapshot));
    await this.exportRegister(ctx, config);
    await this.writeFlags(ctx, config);
    ctx.ui.notify(
      reviewNotice(created, repeatOf, verified.droppedFlags),
      created.length ? 'warning' : 'info'
    );
  }

  // ---------- compaction note ----------

  /** After compaction: check the summary against the ledger and add a note if anything is stale. */
  startCompactionNote(ctx: ExtensionContext, config: LedgerConfig, summary: string): void {
    this.pendingNote = this.compactionNote(ctx, config, summary)
      .catch((err) =>
        ctx.ui.notify(`Supervisor: compaction check failed (${String(err)})`, 'warning')
      )
      .finally(() => {
        this.pendingNote = null;
      });
  }

  async compactionNote(
    ctx: ExtensionContext,
    config: LedgerConfig,
    summary: string
  ): Promise<void> {
    const state = this.state();
    const [ledger, spec] = await Promise.all([
      readTextOrNull(this.ledgerPath(ctx, config)),
      readTextOrNull(path.resolve(ctx.cwd, config.files.spec)),
    ]);
    if (!ledger) return;
    const userPrompt = [
      `[Compaction Summary]\n${summary}\n`,
      `[Ledger]\n${ledger}\n`,
      `[Model Spec]\n${spec ?? '(absent)'}\n`,
    ].join('\n');
    const result = await this.callModel(ctx, {
      model: config.reviewer.model,
      fallbackModel: config.reviewer.fallbackModel,
      thinking: config.reviewer.thinking,
      systemPrompt: await loadPrompt(ctx.cwd, 'COMPACTION_NOTE.md', COMPACTION_NOTE_PROMPT),
      userPrompt,
    });
    const items = result.ok ? coerceStaleItems(result.json) : undefined;
    if (!items) {
      bump(state, 'compaction_note.failed');
      this.store.persist();
      return;
    }
    const { kept, dropped } = verifyStaleItems(
      items,
      summary,
      this.verifyContext(config, {}, ledger, spec)
    );
    bump(state, 'compaction_note.items', kept.length);
    bump(state, 'compaction_note.dropped_unverified', dropped);
    this.store.persist();
    if (kept.length === 0) return;
    // No triggerTurn: Pi appends it now when idle, or at the end of the current turn.
    this.pi.sendMessage({
      customType: COMPACTION_NOTE_TYPE,
      content: renderCompactionNote(kept),
      display: true,
      details: { items: kept },
    });
    ctx.ui.notify(
      `Supervisor: ${kept.length} stale item(s) noted after the compaction summary.`,
      'info'
    );
  }

  /**
   * Apply MODEL_SPEC.md to the register: renamed headings rename their concept
   * (and its flags), stated values are updated. Records the spec's hash.
   */
  private applySpec(spec: string): Array<[string, string]> {
    const state = this.state();
    state.specHash = hashText(spec);
    const renames = syncFromSpec(state.register, spec, state.turn);
    if (renames.length) bump(state, 'spec.renames', renames.length);
    return renames;
  }

  /** After a turn: if MODEL_SPEC.md changed, re-sync the register. Returns whether it changed. */
  private async checkSpec(ctx: ExtensionContext, config: LedgerConfig): Promise<boolean> {
    const state = this.state();
    const spec = await readTextOrNull(path.resolve(ctx.cwd, config.files.spec));
    const hash = spec === null ? null : hashText(spec);
    const known = state.specHash;
    if (hash === known) return false;
    state.specHash = hash;
    if (spec !== null) {
      const renames = this.applySpec(spec);
      for (const [from, to] of renames)
        ctx.ui.notify(`Supervisor: concept "${from}" renamed to "${to}" (MODEL_SPEC.md).`, 'info');
      await this.exportRegister(ctx, config);
      if (renames.length) await this.writeFlags(ctx, config);
    }
    this.store.persist();
    // The first sighting of the spec (old state, or extension loaded late) is not an edit.
    return known !== undefined;
  }

  /** Seed stated meanings from MODEL_SPEC.md (session start). Returns the number of concepts seeded. */
  async seedFromSpec(ctx: ExtensionContext, config: LedgerConfig): Promise<number> {
    const spec = await readTextOrNull(path.resolve(ctx.cwd, config.files.spec));
    if (!spec) return 0;
    const renames = this.applySpec(spec);
    const edits = specStatements(spec);
    this.store.persist();
    await this.exportRegister(ctx, config);
    if (renames.length) await this.writeFlags(ctx, config);
    return edits.length;
  }

  async exportRegister(ctx: ExtensionContext, config: LedgerConfig): Promise<void> {
    await this.writeFile(ctx, config.files.register, renderRegister(this.state().register));
  }

  private async writeFile(ctx: ExtensionContext, rel: string, text: string): Promise<void> {
    const file = path.resolve(ctx.cwd, rel);
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text, 'utf8');
    } catch {
      ctx.ui.notify(`Supervisor: could not write ${rel}`, 'warning');
    }
  }

  async writeFlags(ctx: ExtensionContext, config: LedgerConfig): Promise<void> {
    await this.writeFile(ctx, config.files.flags, renderFlagsFile(this.state()));
  }
}
