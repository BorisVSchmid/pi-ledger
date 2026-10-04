// src/ledger/checks.ts
//
// Deterministic checks for ledger mode. Pure functions plus small file I/O.
// No Pi imports: compiles and tests on its own.
//
//  D1/D2  parseLedgerLine, ledgerClaimMismatch
//  D3     lockedSectionsChanged
//  D4     snapshotFiles, diffSnapshots  (model-file snapshot at turn start, diff at turn end)
//  D5     cjkRatio
//  all LLM findings: verifyQuote, locInHunks
//  input: buildLedgerBlock, renderHunks

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

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

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
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

/** True if "file:line" falls inside a hunk's new-line range (or file matches with no line). */
export function locInHunks(loc: string, hunks: Hunk[]): boolean {
  const m = /^(.+?)(?::(\d+))?$/.exec(loc.trim());
  if (!m) return false;
  const file = m[1].replace(/\\/g, '/');
  const line = m[2] ? Number(m[2]) : null;
  return hunks.some(
    (h) => h.file === file && (line === null || (line >= h.newStart && line <= h.newEnd))
  );
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

// ---------- [Ledger File] block ----------

export interface LedgerBlock {
  text: string;
  content: string | null;
  hash: string | null;
  changedSincePrevious: boolean | null;
}

export async function buildLedgerBlock(opts: {
  cwd: string;
  file?: string;
  previousHash?: string | null;
  maxChars?: number;
}): Promise<LedgerBlock> {
  const file = path.resolve(opts.cwd, opts.file ?? 'MEMENTO.md');
  const maxChars = opts.maxChars ?? 8000;
  let content: string;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch {
    return {
      text: `[Ledger File]\npath: ${file}\nstatus: NOT FOUND\n`,
      content: null,
      hash: null,
      changedSincePrevious: null,
    };
  }
  const hash = hashText(content);
  const changed = opts.previousHash == null ? null : hash !== opts.previousHash;
  const truncated = content.length > maxChars;
  const body = truncated ? content.slice(0, maxChars) : content;
  const header = [
    '[Ledger File]',
    `path: ${file}`,
    `hash: ${hash}`,
    `changed since previous turn: ${changed === null ? 'unknown' : changed ? 'yes' : 'no'}`,
    truncated ? `content (first ${maxChars} chars):` : 'content:',
  ].join('\n');
  return { text: `${header}\n${body.trimEnd()}\n`, content, hash, changedSincePrevious: changed };
}
