/**
 * Ledger-mode reviewer: input builder, output parsing and verification,
 * trigger logic. Pure functions; the model call lives in model-call.ts and
 * the orchestration in runtime.ts.
 */

import {
  splitSections,
  verifyQuote,
  type Snapshot,
  type SnapshotDiff,
  renderHunks,
} from './checks.js';
import { registerForPrompt, type FlagInput, type Register, type RegisterEdit } from './register.js';

// ---------- input ----------

export function numberLines(text: string): string {
  const lines = text.split(/\r?\n/);
  const width = String(lines.length).length;
  return lines.map((l, i) => `${String(i + 1).padStart(width)}| ${l}`).join('\n');
}

/**
 * [Model Files] with 1-based line numbers. Files are included whole from the
 * smallest up; once the budget runs out, the remaining (largest) files are
 * truncated, and the block says so.
 */
export function buildModelFilesBlock(snapshot: Snapshot, maxChars: number): string {
  const files = Object.keys(snapshot).sort(
    (a, b) => snapshot[a].length - snapshot[b].length || a.localeCompare(b)
  );
  const parts: string[] = ['[Model Files]'];
  if (files.length === 0) parts.push('(no files match files.modelFiles)');
  let budget = maxChars;
  const truncated: string[] = [];
  const included: Array<[string, string]> = [];
  for (const f of files) {
    const body = numberLines(snapshot[f]);
    if (body.length <= budget) {
      included.push([f, body]);
      budget -= body.length;
    } else if (budget > 200) {
      const cut = body.slice(0, budget);
      included.push([f, cut.slice(0, cut.lastIndexOf('\n')) + '\n…(truncated)']);
      truncated.push(f);
      budget = 0;
    } else {
      truncated.push(f);
    }
  }
  included.sort(([a], [b]) => a.localeCompare(b));
  for (const [f, body] of included) parts.push(`=== ${f}`, body);
  if (truncated.length) {
    parts.push(`NOTE: truncated or omitted to fit ${maxChars} chars: ${truncated.join(', ')}`);
  }
  return parts.join('\n') + '\n';
}

export interface ReviewerInputs {
  spec: string | null;
  register: Register;
  ledger: string | null;
  snapshot: Snapshot;
  /** Model-file changes since the last review; null on the first review. */
  editsSinceReview: SnapshotDiff | null;
  agentSummary: string | null;
  note?: string;
  maxModelFileChars: number;
  inputs: string[];
}

export function buildReviewerPrompt(i: ReviewerInputs): string {
  const want = (k: string) => i.inputs.includes(k);
  const blocks: string[] = [];
  if (want('model_spec')) blocks.push(`[Model Spec]\n${i.spec ?? '(absent)'}\n`);
  if (want('model_register')) blocks.push(registerForPrompt(i.register));
  if (want('ledger')) blocks.push(`[Ledger]\n${i.ledger ?? '(absent)'}\n`);
  if (want('model_files')) blocks.push(buildModelFilesBlock(i.snapshot, i.maxModelFileChars));
  if (want('model_edits')) {
    blocks.push(
      i.editsSinceReview
        ? renderHunks(i.editsSinceReview)
        : '[Model Edits]\n(first review: no earlier snapshot)\n'
    );
  }
  if (want('agent_summary')) {
    blocks.push(
      `[Agent Summary]\n(The working agent's own description. A claim to test, not a source of truth.)\n${
        i.agentSummary ?? '(none)'
      }\n`
    );
  }
  if (i.note) blocks.push(`[Human Note]\n${i.note}\n`);
  return blocks.join('\n');
}

const SUMMARY_MARKERS =
  /\b(model|compartment|transmission|force of infection|FOI|equation|likelihood|prior|state|flow|rate)s?\b/i;

/** The most recent assistant text that describes the model; falls back to the last one. */
export function pickAgentSummary(assistantTexts: string[], maxChars = 4000): string | null {
  const texts = assistantTexts.filter((t) => t.trim().length > 0);
  if (texts.length === 0) return null;
  const hit = [...texts].reverse().find((t) => SUMMARY_MARKERS.test(t)) ?? texts[texts.length - 1];
  return hit.length > maxChars ? hit.slice(0, maxChars) + '\n…(truncated)' : hit;
}

// ---------- output ----------

/** Extract the JSON object from a reply: strips fences and surrounding prose. */
export function parseJsonObject(text: string): unknown | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

interface Side {
  loc: string;
  quote: string;
}

export interface ReviewerFlag {
  concept: string;
  type: number;
  a: Side;
  b?: Side | null;
  argument?: string;
  question: string;
}

export interface ReviewerOutput {
  flags: ReviewerFlag[];
  register_edits: RegisterEdit[];
  restatement: string | null;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isSide = (v: unknown): v is Side =>
  typeof v === 'object' && v !== null && isStr((v as Side).loc) && isStr((v as Side).quote);

/** Shape-check the parsed JSON; malformed items are dropped, not repaired. */
export function coerceReviewerOutput(raw: unknown): ReviewerOutput | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const flags = (Array.isArray(r.flags) ? r.flags : []).filter(
    (f): f is ReviewerFlag =>
      typeof f === 'object' &&
      f !== null &&
      isStr((f as ReviewerFlag).concept) &&
      isStr((f as ReviewerFlag).question) &&
      isSide((f as ReviewerFlag).a) &&
      ((f as ReviewerFlag).b == null || isSide((f as ReviewerFlag).b))
  );
  for (const f of flags) f.type = Number.isFinite(Number(f.type)) ? Number(f.type) : 0;
  const edits = (Array.isArray(r.register_edits) ? r.register_edits : []).filter(
    (e): e is RegisterEdit => {
      if (typeof e !== 'object' || e === null) return false;
      const x = e as Record<string, unknown>;
      if (!isStr(x.concept)) return false;
      if (x.op === 'stated') return isStr(x.value) && isStr(x.source);
      if (x.op === 'realization')
        return isStr(x.loc) && isStr(x.value) && isStr(x.quote) && isStr(x.layer);
      if (x.op === 'remove_realization') return isStr(x.loc);
      return false;
    }
  );
  return {
    flags,
    register_edits: edits,
    restatement: isStr(r.restatement) ? r.restatement : null,
  };
}

// ---------- verification ----------

export interface VerifyContext {
  snapshot: Snapshot;
  ledger: string | null;
  ledgerName: string;
  spec: string | null;
  specName: string;
  /** Lines either side of a cited line in which the quote must appear. */
  window?: number;
}

function quoteNearLine(text: string, from: number, to: number, quote: string, window: number) {
  const lines = text.split(/\r?\n/);
  if (from < 1 || from > lines.length) return false;
  const lo = Math.max(0, from - 1 - window);
  const hi = Math.min(lines.length, to + window);
  return verifyQuote(quote, lines.slice(lo, hi).join('\n'));
}

/**
 * A side verifies if its quote is verbatim (whitespace-normalised) in the
 * artefact its loc names: "file:line[-line]" → that file near that line;
 * "MEMENTO.md#X" → the ledger; "MODEL_SPEC.md#P" → the spec.
 */
export function verifySide(side: Side, v: VerifyContext): boolean {
  const loc = side.loc.trim();
  const window = v.window ?? 5;
  const base = (name: string) => name.split('/').pop()!.toLowerCase();
  const anchor = /^(.+?)#/.exec(loc)?.[1];
  if (anchor) {
    const a = base(anchor);
    if (a === base(v.ledgerName)) return !!v.ledger && verifyQuote(side.quote, v.ledger);
    if (a === base(v.specName)) return !!v.spec && verifyQuote(side.quote, v.spec);
    return false;
  }
  const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(loc);
  const file = (m ? m[1] : loc).replace(/\\/g, '/').replace(/^\.\//, '');
  const text = v.snapshot[file];
  if (text === undefined) return false;
  if (!m) return verifyQuote(side.quote, text);
  const from = Number(m[2]);
  const to = m[3] ? Number(m[3]) : from;
  return quoteNearLine(text, from, to, side.quote, window);
}

export interface VerifiedReview {
  flags: FlagInput[];
  edits: RegisterEdit[];
  restatement: string | null;
  droppedFlags: number;
  droppedEdits: number;
}

export function verifyReview(out: ReviewerOutput, v: VerifyContext): VerifiedReview {
  const flags: FlagInput[] = [];
  let droppedFlags = 0;
  for (const f of out.flags) {
    if (verifySide(f.a, v) && (!f.b || verifySide(f.b, v))) {
      flags.push({
        concept: f.concept,
        type: f.type,
        a: f.a,
        b: f.b ?? null,
        question: f.question,
        argument: f.argument,
      });
    } else droppedFlags++;
  }
  const edits: RegisterEdit[] = [];
  let droppedEdits = 0;
  for (const e of out.register_edits) {
    if (e.op === 'realization') {
      if (verifySide({ loc: e.loc, quote: e.quote }, v)) edits.push(e);
      else droppedEdits++;
    } else if (e.op === 'stated') {
      // The reviewer cannot claim authority: user and spec statements come from
      // the spec file and the human, never from a model.
      edits.push({ ...e, source: `reviewer (${e.source})` });
    } else edits.push(e);
  }
  return { flags, edits, restatement: out.restatement, droppedFlags, droppedEdits };
}

// ---------- triggers ----------

export type ReviewReason =
  | 'command'
  | 'register_change'
  | 'breakpoint'
  | 'before_compaction'
  | 'backstop';

export interface TriggerInput {
  turn: number;
  lastReviewTurn: number;
  /** Model-file changes this turn. */
  turnDiff: SnapshotDiff | null;
  /** Model files differ from the last review's snapshot (or no review yet and files changed). */
  modelEditsSinceReview: boolean;
  register: Register;
  /** The last review added a concept or realization. */
  registerGrewLastReview: boolean;
  ledgerBefore: string | null | undefined;
  ledgerAfter: string | null;
  triggers: {
    onRegisterChange: boolean;
    onBreakpoint: boolean;
    idleAfterModelEditsEveryNTurns: number;
  };
}

function touchesConcept(diff: SnapshotDiff, reg: Register): boolean {
  for (const h of diff.hunks) {
    if (h.lines.some((l) => /@concept\b/.test(l))) return true;
    for (const c of Object.values(reg.concepts)) {
      for (const r of c.realizations) {
        const m = /^(.+?):(\d+)/.exec(r.loc);
        if (m && m[1] === h.file && Number(m[2]) >= h.oldStart && Number(m[2]) <= h.oldEnd) {
          return true;
        }
      }
    }
  }
  return false;
}

function sectionChanged(before: string, after: string, heading: RegExp): boolean {
  const pick = (md: string) =>
    [...splitSections(md)]
      .filter(([h]) => heading.test(h))
      .map(([, lines]) =>
        lines
          .map((l) => l.trimEnd())
          .filter(Boolean)
          .join('\n')
      )
      .join('\n');
  return pick(before) !== pick(after);
}

/** Which automatic trigger fires after a turn, if any. One review per turn at most. */
export function automaticTrigger(t: TriggerInput): ReviewReason | null {
  if (t.lastReviewTurn === t.turn) return null;
  if (
    t.triggers.onRegisterChange &&
    ((t.turnDiff && t.turnDiff.hunks.length > 0 && touchesConcept(t.turnDiff, t.register)) ||
      t.registerGrewLastReview)
  ) {
    return 'register_change';
  }
  if (
    t.triggers.onBreakpoint &&
    typeof t.ledgerBefore === 'string' &&
    t.ledgerAfter !== null &&
    (sectionChanged(t.ledgerBefore, t.ledgerAfter, /^next\b/i) ||
      sectionChanged(t.ledgerBefore, t.ledgerAfter, /^checks\b/i))
  ) {
    return 'breakpoint';
  }
  const n = t.triggers.idleAfterModelEditsEveryNTurns;
  if (n > 0 && t.modelEditsSinceReview && t.turn - t.lastReviewTurn >= n) return 'backstop';
  return null;
}

// ---------- compaction note ----------

export interface StaleItem {
  summary_quote: string;
  ref: string;
  ledger_quote: string;
  note: string;
}

export function coerceStaleItems(raw: unknown): StaleItem[] | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const stale = (raw as { stale?: unknown }).stale;
  if (!Array.isArray(stale)) return undefined;
  return stale.filter(
    (s): s is StaleItem =>
      typeof s === 'object' &&
      s !== null &&
      isStr((s as StaleItem).summary_quote) &&
      isStr((s as StaleItem).ref) &&
      isStr((s as StaleItem).ledger_quote) &&
      typeof (s as StaleItem).note === 'string'
  );
}

/** Keep items whose summary quote is in the summary and whose ledger quote is in the cited file. */
export function verifyStaleItems(
  items: StaleItem[],
  summary: string,
  v: VerifyContext
): { kept: StaleItem[]; dropped: number } {
  const kept = items.filter(
    (s) =>
      verifyQuote(s.summary_quote, summary) &&
      verifySide({ loc: s.ref.includes('#') ? s.ref : `${s.ref}#`, quote: s.ledger_quote }, v)
  );
  return { kept, dropped: items.length - kept.length };
}

export function renderCompactionNote(items: StaleItem[]): string {
  const lines = [
    'Supervisor note on the compaction summary above. The summary is unchanged; these statements in it are stale according to the ledger:',
    '',
  ];
  for (const s of items) {
    const note = s.note.trim() ? ` ${s.note.trim()}` : '';
    lines.push(`- "${s.summary_quote.trim()}" —${note} (${s.ref}: "${s.ledger_quote.trim()}")`);
  }
  lines.push('', 'Treat MEMENTO.md as the current record.');
  return lines.join('\n');
}
