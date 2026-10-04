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
import { applyEdits, renderRegister, specStatements } from './register.js';

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

    const findings = evaluateTurn({
      assistantText: lastAssistantText(ctx),
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
  }

  /** Seed stated meanings from MODEL_SPEC.md (session start). Returns the number of concepts seeded. */
  async seedFromSpec(ctx: ExtensionContext, config: LedgerConfig): Promise<number> {
    const spec = await readTextOrNull(path.resolve(ctx.cwd, config.files.spec));
    if (!spec) return 0;
    const edits = specStatements(spec);
    if (edits.length === 0) return 0;
    applyEdits(this.state().register, edits, this.state().turn);
    this.store.persist();
    await this.exportRegister(ctx, config);
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
