/**
 * The glue between Pi and the three parts (monitor, reviewer, flags):
 * persisted state, file I/O and model calls.
 *
 *  before_agent_start → take the turn baseline (ledger + model-file snapshot)
 *  agent_settled      → monitor (D1–D5), steer or notify, maybe start a review
 *  review             → reviewer call, verify, merge flags, write .pi/FLAGS.md
 *  session_compact    → compaction note: summary statements that differ from the ledger
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { LedgerConfig } from './config.js';
import {
  diffSnapshots,
  evaluateTurn,
  hashText,
  routeFindings,
  snapshotFiles,
  type FindingKind,
  type Snapshot,
} from './monitor.js';
import {
  addFlag,
  closeFlag,
  closeReason,
  coerceInterpretation,
  interpretationPrompt,
  needsInterpretation,
  emptyFlags,
  findFlag,
  migrateRegister,
  renderFlag,
  renderFlagsFile,
  steerTextFor,
  type Flag,
  type FlagStore,
} from './flags.js';
import { callJson } from './model-session.js';
import {
  buildReviewerPrompt,
  CLOSE_INTERPRETATION_PROMPT,
  coerceDiffItems,
  coerceReviewerOutput,
  COMPACTION_NOTE_PROMPT,
  pickAgentSummary,
  renderCompactionNote,
  REVIEWER_PROMPT,
  reviewNotice,
  verifyDiffItems,
  verifyReview,
  type ReviewReason,
  type VerifyContext,
} from './reviewer.js';

// ---------- state ----------

/** Kept from pi-supervisor so sessions started under the fork still load. */
export const LEDGER_ENTRY_TYPE = 'supervisor-ledger-state';
export const COMPACTION_NOTE_TYPE = 'supervisor-compaction-note';
export const FLAGS_FILE = '.pi/FLAGS.md';
/** Snapshot of model files at the last review, so [Model Edits] spans all turns since. */
const REVIEW_SNAPSHOT_FILE = '.pi/ledger-review-snapshot.json';
const MAX_NOTICES = 200;

export interface Notice {
  kind: FindingKind;
  detail: string;
  turn: number;
  ts: number;
}

export interface LedgerState {
  version: 2;
  /** Set by /ledger on|off; null until then, and the config's autoEnable decides. */
  enabled: boolean | null;
  /** Completed agent runs observed while the ledger was on. */
  turn: number;
  /** Finding kinds of the last observed turn (for the status line). */
  lastTurnFindings: FindingKind[];
  /** The ledger at the end of the last observed turn. */
  previousLedgerHash: string | null;
  previousLedgerText: string | null;
  /** Hash of the spec when last read; null if absent, undefined if never read. */
  specHash?: string | null;
  /** `${kind}:${ledgerHash}` of every steer sent; a key is never sent twice. */
  steerHistory: string[];
  notices: Notice[];
  /** Dedup keys for notices, so the same finding is not reported every turn. */
  noticeKeys: string[];
  flags: FlagStore;
  /** Turn of the last completed review; -1 before the first. */
  lastReviewTurn: number;
  metrics: Record<string, number>;
}

export function emptyLedgerState(): LedgerState {
  return {
    version: 2,
    enabled: null,
    turn: 0,
    lastTurnFindings: [],
    previousLedgerHash: null,
    previousLedgerText: null,
    steerHistory: [],
    notices: [],
    noticeKeys: [],
    flags: emptyFlags(),
    lastReviewTurn: -1,
    metrics: {},
  };
}

/** Read a persisted state, including one written by the pi-supervisor fork (version 1, a register). */
export function restoreState(data: unknown): LedgerState {
  const d = (data ?? {}) as Partial<LedgerState> & { register?: unknown; version?: number };
  const state = { ...emptyLedgerState(), ...d, version: 2 as const };
  if (!d.flags) state.flags = migrateRegister(d.register);
  delete (state as { register?: unknown }).register;
  state.lastTurnFindings ??= [];
  return state;
}

export function bump(state: LedgerState, metric: string, by = 1): void {
  state.metrics[metric] = (state.metrics[metric] ?? 0) + by;
}

function addNotice(state: LedgerState, notice: Notice, key: string): boolean {
  if (state.noticeKeys.includes(key)) return false;
  state.noticeKeys.push(key);
  state.notices.push(notice);
  if (state.notices.length > MAX_NOTICES)
    state.notices.splice(0, state.notices.length - MAX_NOTICES);
  if (state.noticeKeys.length > MAX_NOTICES * 5) state.noticeKeys.splice(0, MAX_NOTICES);
  return true;
}

// ---------- session helpers ----------

type BranchEntry = { type: string; message?: { role?: string; content?: unknown } };

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: { type?: string }) => b?.type === 'text')
    .map((b: { text?: string }) => b.text ?? '')
    .join('\n');
}

/** Visible text of every assistant message on the branch, oldest first. */
export function assistantTexts(ctx: ExtensionContext): string[] {
  return (ctx.sessionManager.getBranch() as BranchEntry[])
    .filter((e) => e.type === 'message' && e.message?.role === 'assistant')
    .map((e) => textOf(e.message!.content));
}

export async function readTextOrNull(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** A project may override a built-in prompt with .pi/<name>. */
const oneLineQuestion = (f: Flag) => f.question.replace(/\s+/g, ' ').trim();

async function loadPrompt(cwd: string, name: string, builtin: string): Promise<string> {
  return (await readTextOrNull(path.join(cwd, '.pi', name)))?.trim() || builtin;
}

interface Baseline {
  ledger: string | null;
  snapshot: Snapshot;
}

export class LedgerRuntime {
  private s: LedgerState = emptyLedgerState();
  private baseline: Baseline | null = null;
  /** Snapshot at the end of the last turn; the next turn's baseline if none was taken. */
  private lastSnapshot: Snapshot | null = null;

  /** Injectable for tests. */
  callModel: typeof callJson = callJson;
  /** The review currently running, if any (one at a time). */
  pending: Promise<unknown> | null = null;
  /** The compaction note currently running, if any. */
  pendingNote: Promise<unknown> | null = null;

  constructor(private pi: ExtensionAPI) {}

  state(): LedgerState {
    return this.s;
  }

  load(ctx: ExtensionContext): void {
    const entries = ctx.sessionManager.getBranch() as Array<{
      type: string;
      customType?: string;
      data?: unknown;
    }>;
    const last = [...entries]
      .reverse()
      .find((e) => e.type === 'custom' && e.customType === LEDGER_ENTRY_TYPE);
    this.s = last ? restoreState(last.data) : emptyLedgerState();
    this.baseline = null;
    this.lastSnapshot = null;
  }

  persist(): void {
    this.pi.appendEntry(LEDGER_ENTRY_TYPE, this.s);
  }

  private file(ctx: ExtensionContext, rel: string): string {
    return path.resolve(ctx.cwd, rel);
  }

  snapshot(ctx: ExtensionContext, config: LedgerConfig): Promise<Snapshot> {
    return snapshotFiles(ctx.cwd, config.files.modelFiles, 400_000, config.files.ignore);
  }

  // ---------- monitor ----------

  /** Take the baseline once per run; queued prompts before settlement keep the first one. */
  async onAgentStart(ctx: ExtensionContext, config: LedgerConfig): Promise<void> {
    if (this.baseline) return;
    const [ledger, snapshot] = await Promise.all([
      readTextOrNull(this.file(ctx, config.files.ledger)),
      this.snapshot(ctx, config),
    ]);
    this.baseline = { ledger, snapshot };
  }

  async onSettled(ctx: ExtensionContext, config: LedgerConfig): Promise<void> {
    const state = this.s;
    state.turn++;

    const ledgerAfter = await readTextOrNull(this.file(ctx, config.files.ledger));
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
    this.lastSnapshot = after;

    const findings = evaluateTurn({
      assistantText: assistantTexts(ctx).at(-1) ?? '',
      ledgerBefore,
      ledgerAfter,
      modelDiff,
    });
    const ledgerHash = ledgerAfter === null ? null : hashText(ledgerAfter);
    const routed = routeFindings(findings, { steerHistory: state.steerHistory, ledgerHash });

    for (const f of findings) bump(state, `finding.${f.kind}`);
    state.lastTurnFindings = findings.map((f) => f.kind);
    if (routed.suppressedSteers) bump(state, 'steer.suppressed', routed.suppressedSteers);

    let newNotices = 0;
    for (const n of routed.notices) {
      const key = `${n.kind}:${hashText(n.detail)}:${ledgerHash ?? 'none'}`;
      if (addNotice(state, { ...n, turn: state.turn, ts: Date.now() }, key)) {
        newNotices++;
        ctx.ui.notify(`Ledger: ${n.kind} — ${n.detail}`, 'warning');
      }
    }
    state.previousLedgerText = ledgerAfter;
    state.previousLedgerHash = ledgerHash;
    if (routed.steer) {
      state.steerHistory.push(routed.steer.key);
      bump(state, 'steer.sent');
    }

    const specChanged = await this.specChanged(ctx, config);
    this.persist();

    if (newNotices > 0) await this.writeFlags(ctx);
    if (routed.steer) this.pi.sendUserMessage(routed.steer.text, { deliverAs: 'followUp' });

    const edited = (modelDiff?.hunks.length ?? 0) + (modelDiff?.removed.length ?? 0) > 0;
    if ((edited || specChanged) && state.lastReviewTurn !== state.turn) {
      this.startReview(ctx, config, 'edit');
    }
  }

  /** Whether the spec changed since it was last read. The first sighting is not a change. */
  private async specChanged(ctx: ExtensionContext, config: LedgerConfig): Promise<boolean> {
    const spec = await readTextOrNull(this.file(ctx, config.files.spec));
    const hash = spec === null ? null : hashText(spec);
    const known = this.s.specHash;
    this.s.specHash = hash;
    return known !== undefined && known !== hash;
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
      .catch((err) => ctx.ui.notify(`Ledger: review failed (${String(err)})`, 'warning'))
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
    const state = this.s;
    const [ledger, spec, snapshot, previous] = await Promise.all([
      readTextOrNull(this.file(ctx, config.files.ledger)),
      readTextOrNull(this.file(ctx, config.files.spec)),
      this.snapshot(ctx, config),
      readTextOrNull(this.file(ctx, REVIEW_SNAPSHOT_FILE)),
    ]);
    let before: Snapshot | null = null;
    try {
      before = previous ? (JSON.parse(previous) as Snapshot) : null;
    } catch {
      before = null;
    }

    ctx.ui.notify(`Ledger: reviewing the model (${reason})…`, 'info');
    bump(state, `review.${reason}`);
    const result = await this.callModel(ctx, {
      model: config.reviewer.model,
      fallbackModel: config.reviewer.fallbackModel,
      thinking: config.reviewer.thinking,
      systemPrompt: await loadPrompt(ctx.cwd, 'REVIEWER.md', REVIEWER_PROMPT),
      userPrompt: buildReviewerPrompt({
        spec,
        flags: state.flags,
        ledger,
        snapshot,
        editsSinceReview: before ? diffSnapshots(before, snapshot) : null,
        agentSummary: pickAgentSummary(assistantTexts(ctx)),
        note,
      }),
    });
    const output = result.ok ? coerceReviewerOutput(result.json) : undefined;
    if (!output) {
      bump(state, 'review.failed');
      this.persist();
      ctx.ui.notify(
        `Ledger: review produced nothing usable (${result.ok ? 'unexpected JSON' : result.error}).`,
        'warning'
      );
      return;
    }

    const verified = verifyReview(output, this.verifyContext(config, snapshot, ledger, spec));
    const created: Flag[] = [];
    const repeatOf: string[] = [];
    for (const f of verified.flags) {
      const r = addFlag(state.flags, f, state.turn);
      if (r.flag) created.push(r.flag);
      else if (r.repeatOf) repeatOf.push(r.repeatOf);
    }
    if (verified.restatement)
      state.flags.restatement = { text: verified.restatement, turn: state.turn };

    state.lastReviewTurn = state.turn;
    bump(state, 'review.done');
    bump(state, 'review.flags_new', created.length);
    bump(state, 'review.flags_repeat', repeatOf.length);
    bump(state, 'review.flags_dropped_unverified', verified.droppedFlags);
    this.persist();

    await this.writeFile(ctx, REVIEW_SNAPSHOT_FILE, JSON.stringify(snapshot));
    await this.writeFlags(ctx);
    ctx.ui.notify(
      reviewNotice(created, repeatOf, verified.droppedFlags),
      created.length ? 'warning' : 'info'
    );
  }

  // ---------- compaction note ----------

  /** After compaction: compare the summary with the ledger and add a note where they differ. */
  startCompactionNote(ctx: ExtensionContext, config: LedgerConfig, summary: string): void {
    this.pendingNote = this.compactionNote(ctx, config, summary)
      .catch((err) => ctx.ui.notify(`Ledger: compaction check failed (${String(err)})`, 'warning'))
      .finally(() => {
        this.pendingNote = null;
      });
  }

  async compactionNote(
    ctx: ExtensionContext,
    config: LedgerConfig,
    summary: string
  ): Promise<void> {
    const state = this.s;
    const [ledger, spec] = await Promise.all([
      readTextOrNull(this.file(ctx, config.files.ledger)),
      readTextOrNull(this.file(ctx, config.files.spec)),
    ]);
    if (!ledger) return;
    const result = await this.callModel(ctx, {
      model: config.reviewer.model,
      fallbackModel: config.reviewer.fallbackModel,
      thinking: config.reviewer.thinking,
      systemPrompt: await loadPrompt(ctx.cwd, 'COMPACTION_NOTE.md', COMPACTION_NOTE_PROMPT),
      userPrompt: [
        `[Compaction Summary]\n${summary}\n`,
        `[Ledger]\n${ledger}\n`,
        `[Model Spec]\n${spec ?? '(absent)'}\n`,
      ].join('\n'),
    });
    const items = result.ok ? coerceDiffItems(result.json) : undefined;
    if (!items) {
      bump(state, 'compaction_note.failed');
      this.persist();
      return;
    }
    const { kept, dropped } = verifyDiffItems(
      items,
      summary,
      this.verifyContext(config, {}, ledger, spec)
    );
    bump(state, 'compaction_note.items', kept.length);
    bump(state, 'compaction_note.dropped_unverified', dropped);
    this.persist();
    if (kept.length === 0) return;
    // No triggerTurn: Pi appends it now when idle, or at the end of the current turn.
    this.pi.sendMessage({
      customType: COMPACTION_NOTE_TYPE,
      content: renderCompactionNote(kept),
      display: true,
      details: { items: kept },
    });
    ctx.ui.notify(
      `Ledger: ${kept.length} statement(s) in the compaction summary differ from the ledger.`,
      'info'
    );
  }

  // ---------- /flag ----------

  /** /flag · /flag <id> · /flag <id> close <reason> · /flag <id> send. Returns the text to show. */
  async flagCommand(args: string, ctx: ExtensionContext, config?: LedgerConfig): Promise<string> {
    const usage = 'Usage: /flag (list) · /flag <id> · /flag <id> close <reason> · /flag <id> send';
    const store = this.s.flags;
    const [id, action, ...rest] = args.trim().split(/\s+/).filter(Boolean);
    if (!id || id === 'list') {
      const open = store.flags.filter((f) => f.status === 'open');
      return open.length
        ? open.map((f) => renderFlag(f).join('\n')).join('\n\n')
        : 'No open flags.';
    }
    const flag = findFlag(store, id);
    if (!flag) return `No flag ${id}. ${usage}`;
    if (!action) return renderFlag(flag).join('\n');
    const verb = action.toLowerCase();
    if (verb !== 'close' && verb !== 'send') return usage;

    if (verb === 'close') {
      let words = rest;
      if (words.length === 0 && ctx.hasUI) {
        const typed = await ctx.ui.input(
          `Why close ${flag.id}? (${oneLineQuestion(flag)})`,
          'why, in a few words'
        );
        words = (typed ?? '').trim().split(/\s+/).filter(Boolean);
        if (words.length === 0) return `${flag.id} not closed: no reason given.`;
      }
      const r = closeReason(words);
      if ('error' in r) return `${flag.id} not closed. ${r.error}`;
      closeFlag(store, flag, r.reason);
      if (config && needsInterpretation(r.reason)) this.startInterpretation(ctx, config, flag);
    } else flag.status = 'sent';
    bump(this.s, `flag.${verb}`);
    this.persist();
    await this.writeFlags(ctx);
    if (verb === 'send') {
      this.pi.sendUserMessage(steerTextFor(flag), { deliverAs: 'followUp' });
      return `${flag.id} sent to the agent.`;
    }
    return `${flag.id} closed (${flag.reason}); the same evidence will not be raised again.`;
  }

  /** Pending close-reason interpretation, if any (exposed for tests). */
  pendingInterpretation: Promise<unknown> | null = null;

  /**
   * After a terse close: a model writes one sentence on what the reason means,
   * stored apart from the reason and labelled as the model's in FLAGS.md and
   * in the reviewer prompt. Runs in the background; a failure leaves the
   * reason alone.
   */
  startInterpretation(ctx: ExtensionContext, config: LedgerConfig, flag: Flag): void {
    const reason = flag.reason;
    const run = async () => {
      const result = await this.callModel(ctx, {
        model: config.reviewer.model,
        fallbackModel: config.reviewer.fallbackModel,
        systemPrompt: await loadPrompt(
          ctx.cwd,
          'CLOSE_INTERPRETATION.md',
          CLOSE_INTERPRETATION_PROMPT
        ),
        userPrompt: interpretationPrompt(flag),
      });
      const text = result.ok ? coerceInterpretation(result.json) : undefined;
      // The human may have re-closed with another reason meanwhile.
      if (!text || flag.reason !== reason || flag.status !== 'closed') {
        bump(this.s, 'flag.interpretation_failed');
        this.persist();
        return;
      }
      flag.interpretation = text;
      bump(this.s, 'flag.interpretation');
      this.persist();
      await this.writeFlags(ctx);
      ctx.ui.notify(
        `${flag.id} (interpretation: ${text}) Re-close with your own words if this is wrong.`,
        'info'
      );
    };
    this.pendingInterpretation = run()
      .catch(() => bump(this.s, 'flag.interpretation_failed'))
      .finally(() => {
        this.pendingInterpretation = null;
      });
  }

  metricsText(): string {
    const s = this.s;
    const count = (status: string) => s.flags.flags.filter((f) => f.status === status).length;
    return [
      `turns observed: ${s.turn}`,
      `flags: ${s.flags.flags.length} (open ${count('open')}, sent ${count('sent')}, closed ${count('closed')})`,
      `notices: ${s.notices.length}`,
      ...Object.entries(s.metrics)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}: ${v}`),
    ].join('\n');
  }

  // ---------- files ----------

  private async writeFile(ctx: ExtensionContext, rel: string, text: string): Promise<void> {
    const file = this.file(ctx, rel);
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text, 'utf8');
    } catch {
      ctx.ui.notify(`Ledger: could not write ${rel}`, 'warning');
    }
  }

  async writeFlags(ctx: ExtensionContext): Promise<void> {
    await this.writeFile(ctx, FLAGS_FILE, renderFlagsFile(this.s.flags, this.s.notices));
  }
}
