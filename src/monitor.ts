/**
 * The per-turn monitor: deterministic checks, no model call.
 *
 *  D1/D2  the reply's "Ledger:" line exists and matches whether MEMENTO.md changed
 *  D3     Acceptance and Checks are append-only
 *  D4     model-file snapshot at turn start, diff at turn end (input for the reviewer)
 *  D5     language drift (CJK characters in the reply or the ledger)
 *
 * Also computes the status line from the ledger (Acceptance, flags, whether
 * the ledger kept up).
 *
 * D1 and D2 steer with fixed templates, never twice for the same ledger state;
 * everything else is a notice. Also home to the file and quote helpers the
 * reviewer uses. Pure functions plus small file I/O; no Pi imports.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Ledger headings whose existing lines may not change. */
export const LOCKED_HEADINGS = ['Acceptance', 'Checks'];
const CJK_RATIO_MAX = 0.01;

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

// ---------- D1/D2: the agent's "Ledger:" line ----------

export interface LedgerLine {
  present: boolean;
  raw: string | null;
  claimsChange: boolean;
}

export function parseLedgerLine(assistantText: string): LedgerLine {
  // Tolerate markdown emphasis around the label ("**Ledger:** ...", "_Ledger_: ...").
  const matches = [...assistantText.matchAll(/^[*_`]*Ledger[*_`]*:[*_`]*\s*(.+?)\s*$/gm)];
  if (matches.length === 0) return { present: false, raw: null, claimsChange: false };
  const raw = matches[matches.length - 1][1].replace(/[*_`]+$/, '').trim();
  // "unchanged", "none", "no change", optionally followed by a reason after a dash or colon.
  const claimsChange = !/^(unchanged|none|no change)\b\.?(\s*([—–:-]|$).*)?$/i.test(raw);
  return { present: true, raw, claimsChange };
}

export type LedgerMismatch = 'LEDGER_CLAIMED_NO_CHANGE' | 'LEDGER_CHANGED_UNCLAIMED' | null;

/** `fileChanged === null` (no baseline yet) never produces a mismatch. */
export function ledgerClaimMismatch(line: LedgerLine, fileChanged: boolean | null): LedgerMismatch {
  if (!line.present || fileChanged === null) return null;
  if (line.claimsChange && !fileChanged) return 'LEDGER_CLAIMED_NO_CHANGE';
  if (!line.claimsChange && fileChanged) return 'LEDGER_CHANGED_UNCLAIMED';
  return null;
}

// ---------- D3: locked (append-only) sections ----------

export function splitSections(md: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current = '(preamble)';
  out.set(current, []);
  for (const line of md.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      current = h[1];
      if (!out.has(current)) out.set(current, []);
      continue;
    }
    out.get(current)!.push(line);
  }
  return out;
}

/** Headings whose existing lines were edited or removed (appends are allowed). */
export function lockedSectionsChanged(
  previousMd: string,
  nextMd: string,
  lockedHeadings: string[]
): string[] {
  const prev = splitSections(previousMd);
  const next = splitSections(nextMd);
  const isLocked = (h: string) =>
    /\(locked\)/i.test(h) || lockedHeadings.some((k) => h.toLowerCase().includes(k.toLowerCase()));
  const violated: string[] = [];
  for (const [heading, prevLines] of prev) {
    if (!isLocked(heading)) continue;
    const nextLines = new Set((next.get(heading) ?? []).map((l) => l.trimEnd()));
    const kept = prevLines.map((l) => l.trimEnd()).filter((l) => l.length > 0);
    if (!next.has(heading) || kept.some((l) => !nextLines.has(l))) violated.push(heading);
  }
  return violated;
}

// ---------- D4: snapshot + diff of model files ----------

export type Snapshot = Record<string, string>; // relative path -> content

/** Minimal glob: **, *, ?, {a,b}. Forward-slash paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      re +=
        '(' +
        glob
          .slice(i + 1, end)
          .split(',')
          .map(escapeRe)
          .join('|') +
        ')';
      i = end;
    } else re += escapeRe(c);
  }
  return new RegExp('^' + re + '$');
}
function escapeRe(s: string): string {
  return s.replace(/[.+^$()|[\]\\]/g, '\\$&');
}
export function matchesAny(filePath: string, globs: string[]): boolean {
  const p = filePath.replace(/\\/g, '/');
  return globs.some((g) => globToRegExp(g.replace(/\\/g, '/')).test(p));
}

/** Reads every file under cwd matching globs (skips node_modules/.git), capped per file. */
export async function snapshotFiles(
  cwd: string,
  globs: string[],
  maxBytesPerFile = 400_000,
  ignore: string[] = []
): Promise<Snapshot> {
  const snap: Snapshot = {};
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(cwd, abs).replace(/\\/g, '/');
      if (ignore.length > 0 && (matchesAny(rel, ignore) || matchesAny(rel + '/', ignore))) continue;
      if (e.isDirectory()) await walk(abs);
      else if (matchesAny(rel, globs)) {
        try {
          const st = await fs.stat(abs);
          if (st.size <= maxBytesPerFile) snap[rel] = await fs.readFile(abs, 'utf8');
        } catch {
          /* unreadable: skip */
        }
      }
    }
  }
  await walk(cwd);
  return snap;
}

export interface Hunk {
  file: string;
  /** 1-based line range in the NEW file covered by this hunk (context included). */
  newStart: number;
  newEnd: number;
  oldStart: number;
  oldEnd: number;
  /** Lines prefixed with ' ', '-', '+'. */
  lines: string[];
}

/** Line diff via LCS; returns hunks with `context` lines around changes. */
export function diffLines(file: string, oldText: string, newText: string, context = 2): Hunk[] {
  const a = oldText.split(/\r?\n/);
  const b = newText.split(/\r?\n/);
  // LCS table (fine for source files; guard very large inputs)
  const n = a.length,
    m = b.length;
  if (n * m > 4_000_000) {
    return [
      {
        file,
        newStart: 1,
        newEnd: m,
        oldStart: 1,
        oldEnd: n,
        lines: ['(file too large to diff; whole file changed)'],
      },
    ];
  }
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  type Op = { t: ' ' | '-' | '+'; i: number; j: number; s: string };
  const ops: Op[] = [];
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) (ops.push({ t: ' ', i, j, s: a[i] }), i++, j++);
    else if (dp[i + 1][j] >= dp[i][j + 1]) (ops.push({ t: '-', i, j, s: a[i] }), i++);
    else (ops.push({ t: '+', i, j, s: b[j] }), j++);
  }
  while (i < n) (ops.push({ t: '-', i, j, s: a[i] }), i++);
  while (j < m) (ops.push({ t: '+', i, j, s: b[j] }), j++);

  const hunks: Hunk[] = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === ' ') {
      k++;
      continue;
    }
    const start = Math.max(0, k - context);
    let end = k;
    let lastChange = k;
    while (end < ops.length && end - lastChange <= context) {
      if (ops[end].t !== ' ') lastChange = end;
      end++;
    }
    end = Math.min(ops.length, lastChange + context + 1);
    const slice = ops.slice(start, end);
    const newIdx = slice.filter((o) => o.t !== '-').map((o) => o.j);
    const oldIdx = slice.filter((o) => o.t !== '+').map((o) => o.i);
    hunks.push({
      file,
      newStart: (newIdx[0] ?? slice[0].j) + 1,
      newEnd: (newIdx[newIdx.length - 1] ?? slice[0].j) + 1,
      oldStart: (oldIdx[0] ?? slice[0].i) + 1,
      oldEnd: (oldIdx[oldIdx.length - 1] ?? slice[0].i) + 1,
      lines: slice.map((o) => o.t + o.s),
    });
    k = end;
  }
  return hunks;
}

export interface SnapshotDiff {
  changed: string[];
  added: string[];
  removed: string[];
  hunks: Hunk[];
}

export function diffSnapshots(before: Snapshot, after: Snapshot, context = 2): SnapshotDiff {
  const out: SnapshotDiff = { changed: [], added: [], removed: [], hunks: [] };
  for (const f of Object.keys(after)) {
    if (!(f in before)) {
      out.added.push(f);
      out.hunks.push(...diffLines(f, '', after[f], context));
    } else if (before[f] !== after[f]) {
      out.changed.push(f);
      out.hunks.push(...diffLines(f, before[f], after[f], context));
    }
  }
  for (const f of Object.keys(before)) if (!(f in after)) out.removed.push(f);
  return out;
}

/** The [Model Edits] block: hunks with real line ranges. */
export function renderHunks(d: SnapshotDiff, maxChars = 20_000): string {
  const parts: string[] = ['[Model Edits]'];
  if (d.removed.length) parts.push(`removed files: ${d.removed.join(', ')}`);
  for (const h of d.hunks) {
    parts.push(
      `### ${h.file}  (new lines ${h.newStart}-${h.newEnd}; old ${h.oldStart}-${h.oldEnd})`
    );
    parts.push(...h.lines);
  }
  let text = parts.join('\n') + '\n';
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…(truncated)\n';
  return text;
}

// ---------- D5: language drift ----------

export function cjkRatio(text: string): number {
  const chars = [...text.replace(/\s+/g, '')];
  if (chars.length === 0) return 0;
  const cjk = chars.filter((c) => /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/.test(c));
  return cjk.length / chars.length;
}

// ---------- quote verification ----------

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
export function verifyQuote(quote: string, haystack: string): boolean {
  const q = normalizeWs(quote);
  if (q.length < 8) return false;
  return normalizeWs(haystack).includes(q);
}

// ---------- the turn ----------

export type FindingKind =
  | 'LEDGER_LINE_MISSING'
  | 'LEDGER_CLAIMED_NO_CHANGE'
  | 'LEDGER_CHANGED_UNCLAIMED'
  | 'LOCKED_SECTION_EDITED'
  | 'LANGUAGE_DRIFT';

export interface Finding {
  kind: FindingKind;
  detail: string;
}

/** Steer templates (brief 5.4). The model never writes steers; these are the only steers. */
export const STEER_TEMPLATES: Partial<Record<FindingKind, string>> = {
  LEDGER_LINE_MISSING:
    'Ledger check: end the turn with a "Ledger:" line stating what changed in MEMENTO.md, or "Ledger: unchanged".',
  LEDGER_CLAIMED_NO_CHANGE:
    'Ledger check: your Ledger line reports a change but MEMENTO.md is unchanged. Make the edit or correct the line.',
  LEDGER_CHANGED_UNCLAIMED:
    'Ledger check: MEMENTO.md changed this turn but the Ledger line says unchanged. State what changed.',
};

export interface TurnInput {
  /** Visible text of the last assistant message (no thinking, no tool output). */
  assistantText: string;
  /** MEMENTO.md at the start of the turn; null if absent; undefined if unknown. */
  ledgerBefore: string | null | undefined;
  /** MEMENTO.md now; null if absent. */
  ledgerAfter: string | null;
  /** Model-file changes made during the turn. */
  modelDiff: SnapshotDiff | null;
}

/** Lines added to `after` that were not in `before` (order-insensitive, good enough for prose). */
export function addedLines(before: string | null | undefined, after: string | null): string[] {
  if (!after) return [];
  const old = new Set((before ?? '').split(/\r?\n/));
  return after.split(/\r?\n/).filter((l) => l.trim().length > 0 && !old.has(l));
}

export function evaluateTurn(input: TurnInput): Finding[] {
  const findings: Finding[] = [];
  const ledgerExists = input.ledgerAfter !== null || (input.ledgerBefore ?? null) !== null;

  // D1, D2: only meaningful when the project keeps a ledger.
  if (ledgerExists) {
    const line = parseLedgerLine(input.assistantText);
    if (!line.present) {
      findings.push({ kind: 'LEDGER_LINE_MISSING', detail: 'no "Ledger:" line in the reply' });
    } else {
      const changed =
        input.ledgerBefore === undefined
          ? null
          : hashText(input.ledgerBefore ?? '') !== hashText(input.ledgerAfter ?? '');
      const mismatch = ledgerClaimMismatch(line, changed);
      if (mismatch) findings.push({ kind: mismatch, detail: `Ledger: ${line.raw}` });
    }
  }

  // D3: append-only sections.
  if (input.ledgerBefore && input.ledgerAfter) {
    for (const heading of lockedSectionsChanged(
      input.ledgerBefore,
      input.ledgerAfter,
      LOCKED_HEADINGS
    )) {
      findings.push({ kind: 'LOCKED_SECTION_EDITED', detail: `## ${heading}` });
    }
  }

  // D5: language drift in the reply and in what was added to the ledger.
  const ledgerAdded = addedLines(input.ledgerBefore, input.ledgerAfter).join('\n');
  for (const [where, text] of [
    ['reply', input.assistantText],
    ['MEMENTO.md', ledgerAdded],
  ] as const) {
    const ratio = cjkRatio(text);
    if (ratio > CJK_RATIO_MAX) {
      findings.push({
        kind: 'LANGUAGE_DRIFT',
        detail: `${where}: ${(ratio * 100).toFixed(1)}% CJK characters`,
      });
    }
  }

  return findings;
}

export interface RoutedFindings {
  /** At most one templated steer for this turn. */
  steer: { kind: FindingKind; text: string; key: string } | null;
  notices: Finding[];
  /** Steers suppressed because the same (kind, ledger hash) was already sent. */
  suppressedSteers: number;
}

/**
 * Route findings. Kinds with a steer template steer once per (kind, ledger
 * hash); everything else is a notice.
 */
export function routeFindings(
  findings: Finding[],
  opts: { steerHistory: string[]; ledgerHash: string | null }
): RoutedFindings {
  const out: RoutedFindings = { steer: null, notices: [], suppressedSteers: 0 };
  for (const f of findings) {
    const template = STEER_TEMPLATES[f.kind];
    if (template) {
      const key = `${f.kind}:${opts.ledgerHash ?? 'none'}`;
      if (opts.steerHistory.includes(key) || out.steer) {
        out.suppressedSteers++;
        continue;
      }
      out.steer = { kind: f.kind, text: template, key };
    } else {
      out.notices.push(f);
    }
  }
  return out;
}

// ---------- status line ----------
//
// Computed from the ledger and the stored state, never judged:
//
//   Acceptance 1/3 passed · 2 open flags · ledger current
//
// An Acceptance item is a bullet with an id under "## Acceptance" ("- AC1: …").
// It counts as passed when the last status line for that id, anywhere in the
// ledger, says passed and cites a run id ("AC1 status: passed (R12)").

export type AcceptanceStatus = 'open' | 'passed' | 'failed';

export interface AcceptanceItem {
  id: string;
  text: string;
  status: AcceptanceStatus;
  /** Run id cited by the last status line, if any. */
  run: string | null;
}

export interface AcceptanceSummary {
  /** False when the ledger has no Acceptance section. */
  present: boolean;
  items: AcceptanceItem[];
}

const ITEM_RE = /^\s*[-*]\s+([A-Za-z]+\d+)\s*:\s*(.*)$/;
const STATUS_RE = /\b([A-Za-z]+\d+)\s+status\s*:\s*(\w+)(.*)$/;
const RUN_RE = /\bR\d+\b/;

export function acceptanceSummary(md: string | null): AcceptanceSummary {
  if (!md) return { present: false, items: [] };
  const sections = splitSections(md);
  const heading = [...sections.keys()].find((h) => /^acceptance\b/i.test(h));
  if (!heading) return { present: false, items: [] };

  const items: AcceptanceItem[] = [];
  for (const line of sections.get(heading)!) {
    const m = ITEM_RE.exec(line);
    if (m && !/^status\b/i.test(m[2])) {
      items.push({ id: m[1], text: m[2].trim(), status: 'open', run: null });
    }
  }

  const byId = new Map(items.map((i) => [i.id.toLowerCase(), i]));
  for (const line of md.split(/\r?\n/)) {
    const m = STATUS_RE.exec(line);
    const item = m && byId.get(m[1].toLowerCase());
    if (!item) continue;
    const word = m[2].toLowerCase();
    const run = RUN_RE.exec(m[3])?.[0] ?? null;
    item.run = run;
    // "passed" without a run id is a claim, not a result.
    item.status = word === 'passed' && run ? 'passed' : word === 'failed' ? 'failed' : 'open';
  }
  return { present: true, items };
}

/** What the status line needs from the plugin's state. */
export interface StatusState {
  turn: number;
  lastTurnFindings: FindingKind[];
  flags: { flags: Array<{ status: string }> };
}

const LEDGER_BEHIND: FindingKind[] = [
  'LEDGER_LINE_MISSING',
  'LEDGER_CLAIMED_NO_CHANGE',
  'LEDGER_CHANGED_UNCLAIMED',
];

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function statusLine(input: {
  ledgerText: string | null;
  ledgerName: string;
  state: StatusState;
  reviewing?: boolean;
}): string {
  const { ledgerText, ledgerName, state } = input;
  const parts: string[] = [];

  const acc = acceptanceSummary(ledgerText);
  if (!acc.present || acc.items.length === 0) parts.push('no Acceptance');
  else {
    const passed = acc.items.filter((i) => i.status === 'passed').length;
    const failed = acc.items.filter((i) => i.status === 'failed').length;
    parts.push(
      `Acceptance ${passed}/${acc.items.length} passed` + (failed ? `, ${failed} failed` : '')
    );
  }

  const open = state.flags.flags.filter((f) => f.status === 'open').length;
  parts.push(plural(open, 'open flag'));

  if (ledgerText === null) parts.push(`no ${ledgerName}`);
  else if (state.turn === 0) parts.push('ledger not checked yet');
  else if (state.lastTurnFindings.some((k) => LEDGER_BEHIND.includes(k)))
    parts.push('ledger behind');
  else if (state.lastTurnFindings.includes('LOCKED_SECTION_EDITED'))
    parts.push('locked section edited');
  else parts.push('ledger current');

  if (input.reviewing) parts.push('reviewing…');
  return parts.join(' · ');
}

/** Multi-line detail for /ledger status. */
export function statusDetail(ledgerText: string | null): string {
  const acc = acceptanceSummary(ledgerText);
  if (!acc.present) return 'The ledger has no Acceptance section.';
  if (acc.items.length === 0) return 'The Acceptance section has no items (e.g. "- AC1: …").';
  return acc.items
    .map((i) => `${i.id} ${i.status}${i.run ? ` (${i.run})` : ''}: ${i.text}`)
    .join('\n');
}
