/**
 * Reviewer flags: a flat list of questions for the human.
 *
 * A flag names a concept (as the reviewer labelled it, normally a spec
 * heading such as "P1 transmission"), one or two quoted locations, and a
 * question. It is open until the human closes it (`/flag <id> close`) or sends
 * it to the agent (`/flag <id> send`). A re-raised question is merged into the
 * open flag it repeats; closed evidence is never raised again.
 * Pure functions; no Pi imports.
 */

export interface Side {
  loc: string; // "file:line[-line]", "MEMENTO.md#D2", "MODEL_SPEC.md#P1"
  quote: string; // verbatim, verified before storage
}

export interface Flag {
  id: string;
  concept: string;
  /** 1-6 code-level types, 7-10 conceptual types, 0 injection (see the reviewer prompt). */
  type: number;
  a: Side;
  b: Side | null;
  question: string;
  argument: string;
  status: 'open' | 'sent' | 'closed';
  reason?: string;
  turn: number;
  /** Times a later review raised the same issue again (merged into this flag). */
  repeats?: number;
  lastRaisedTurn?: number;
}

export interface FlagStore {
  flags: Flag[];
  nextFlag: number;
  /** Evidence keys of closed flags; a finding with the same key is dropped. */
  suppressed: string[];
  /** The reviewer's last ten-line restatement of the model, for the human to compare. */
  restatement?: { text: string; turn: number };
}

export function emptyFlags(): FlagStore {
  return { flags: [], nextFlag: 1, suppressed: [] };
}

export interface FlagInput {
  concept: string;
  type: number;
  a: Side;
  b?: Side | null;
  question: string;
  argument?: string;
  /** The reviewer's own statement that this repeats an open flag ("F3"). */
  sameAs?: string;
}

const live = (f: Flag) => f.status === 'open' || f.status === 'sent';
const sidesOf = (f: { a: Side; b?: Side | null }) => [f.a, ...(f.b ? [f.b] : [])];

/**
 * Concepts compare by spec id when they have one, so "P3 Foxes" and
 * "P3 Seed store" (a renamed heading) are the same concept.
 */
export function conceptKey(name: string): string {
  const id = /^(P\d+)\b/i.exec(name.trim())?.[1];
  return id ? id.toUpperCase() : name.trim().replace(/\s+/g, ' ').toLowerCase();
}

const normalizeQuote = (q: string) => q.replace(/\s+/g, ' ').trim().toLowerCase();
/** "R/herd.R:42" -> "R/herd.R"; "MEMENTO.md#D2" stays. */
const locFile = (loc: string) => loc.trim().replace(/:\d+(?:-\d+)?$/, '');

/**
 * Evidence key: concept plus file and quote on each side, order-independent.
 * Keyed on quotes, not line numbers, so it survives lines moving.
 */
export function evidenceKey(concept: string, sides: Side[]): string {
  const parts = sides.map((s) => `${locFile(s.loc)}~${normalizeQuote(s.quote)}`).sort();
  return `${conceptKey(concept)}|${parts.join('|')}`;
}

/** Lines either side within which two "file:line" locations count as the same place. */
const LINE_SLACK = 3;

/** Same ledger/spec anchor, or same file with line ranges within LINE_SLACK. */
export function sameLocation(x: string, y: string): boolean {
  const norm = (l: string) => l.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const a = norm(x);
  const b = norm(y);
  if (a.includes('#') || b.includes('#')) return a === b;
  const parse = (l: string) => {
    const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(l);
    return m
      ? { file: m[1], from: Number(m[2]), to: Number(m[3] ?? m[2]) }
      : { file: l, from: null, to: null };
  };
  const p = parse(a);
  const q = parse(b);
  if (p.file !== q.file) return false;
  if (p.from === null || q.from === null) return p.from === q.from;
  return p.from <= q.to! + LINE_SLACK && q.from <= p.to! + LINE_SLACK;
}

/** Same concept, and every location of the smaller side set is among the other's. */
function overlaps(f: Flag, concept: string, sides: Side[]): boolean {
  if (conceptKey(f.concept) !== conceptKey(concept)) return false;
  const mine = sidesOf(f).map((s) => s.loc);
  const theirs = sides.map((s) => s.loc);
  const [small, large] = mine.length <= theirs.length ? [mine, theirs] : [theirs, mine];
  return small.every((l) => large.some((m) => sameLocation(l, m)));
}

export interface AddFlagResult {
  /** The new flag, or null if the input was a repeat or closed evidence. */
  flag: Flag | null;
  /** Id of the open (or sent) flag the input was merged into. */
  repeatOf?: string;
  suppressed?: boolean;
}

export function addFlag(store: FlagStore, input: FlagInput, turn: number): AddFlagResult {
  const sides = sidesOf(input);
  const key = evidenceKey(input.concept, sides);
  if (store.suppressed.includes(key)) return { flag: null, suppressed: true };

  const sameAs = /\bF\d+\b/i.exec(input.sameAs ?? '')?.[0].toUpperCase();
  const repeat =
    (sameAs && store.flags.find((f) => live(f) && f.id === sameAs)) ||
    store.flags.find((f) => live(f) && evidenceKey(f.concept, sidesOf(f)) === key) ||
    store.flags.find((f) => live(f) && overlaps(f, input.concept, sides));
  if (repeat) {
    repeat.repeats = (repeat.repeats ?? 0) + 1;
    repeat.lastRaisedTurn = turn;
    return { flag: null, repeatOf: repeat.id };
  }

  const flag: Flag = {
    id: `F${store.nextFlag++}`,
    concept: input.concept.trim(),
    type: input.type,
    a: input.a,
    b: input.b ?? null,
    question: input.question,
    argument: input.argument ?? '',
    status: 'open',
    turn,
  };
  store.flags.push(flag);
  return { flag };
}

export function findFlag(store: FlagStore, id: string): Flag | undefined {
  return store.flags.find((f) => f.id.toLowerCase() === id.toLowerCase());
}

/** Short close reasons, so a reason costs a word to type. */
export const CLOSE_PRESETS: Record<string, string> = {
  intended: 'intended (a deliberate choice)',
  'not-an-issue': 'not an issue',
  fixed: 'fixed',
};

export const CLOSE_USAGE =
  'A reason is required: /flag <id> close intended | not-an-issue | fixed | dup F<n> | <your own words>';

/**
 * The reason recorded for `/flag <id> close <words>`. A preset word expands
 * ("fixed in fit.R" -> "fixed: in fit.R"); `dup F<n>` must name another flag;
 * anything else is kept as typed. The reason is always the human's words:
 * closed flags reach the reviewer as the human's verdict.
 */
export function closeReason(
  store: FlagStore,
  flag: Flag,
  words: string[]
): { reason: string } | { error: string } {
  const [first = '', ...more] = words;
  const tail = more.join(' ');
  const key = first.toLowerCase();
  if (!first) return { error: CLOSE_USAGE };
  if (key === 'dup' || key === 'duplicate') {
    const [ref = '', ...note] = more;
    const other = findFlag(store, ref);
    if (!other || other === flag) return { error: `dup needs another flag id, e.g. dup F1.` };
    return { reason: [`duplicate of ${other.id}`, note.join(' ')].filter(Boolean).join(': ') };
  }
  const preset = CLOSE_PRESETS[key];
  if (preset) return { reason: tail ? `${preset}: ${tail}` : preset };
  return { reason: words.join(' ') };
}

/** Close a flag; its evidence is never raised again. */
export function closeFlag(store: FlagStore, f: Flag, reason?: string): void {
  f.status = 'closed';
  if (reason) f.reason = reason;
  const key = evidenceKey(f.concept, sidesOf(f));
  if (!store.suppressed.includes(key)) store.suppressed.push(key);
}

/** Steer text for /flag <id> send. Templated; the model never writes steers. */
export function steerTextFor(flag: Flag): string {
  const where = flag.b ? `${flag.a.loc} and ${flag.b.loc}` : flag.a.loc;
  return `Ledger check: possible inconsistency in ${flag.concept} between ${where}. ${flag.question} Reconcile it, or record the difference as a deliberate decision in MEMENTO.md with the reason.`;
}

/** The [Flags] block of the reviewer prompt: what was raised already, never truncated. */
export function flagsForPrompt(store: FlagStore): string {
  const brief = (f: Flag) => ({
    id: f.id,
    concept: f.concept,
    locs: sidesOf(f).map((s) => s.loc),
    question: f.question,
    ...(f.reason ? { reason: f.reason } : {}),
  });
  return [
    '[Flags]',
    `open (raised, waiting for the human; do not raise again):\n${JSON.stringify(store.flags.filter(live).map(brief), null, 1)}`,
    `closed (the human answered these; do not raise again):\n${JSON.stringify(store.flags.filter((f) => f.status === 'closed').map(brief), null, 1)}`,
    '',
  ].join('\n');
}

// ---------- rendering ----------

const oneLine = (s: string) => s.replace(/\r?\n/g, ' ').trim();

export function renderFlag(f: Flag): string[] {
  const again = f.repeats ? ` · raised again ${f.repeats}× (last turn ${f.lastRaisedTurn})` : '';
  const lines = [
    `### ${f.id} · ${f.concept} · type ${f.type} · ${f.status} (turn ${f.turn})${again}`,
  ];
  lines.push(`- A \`${f.a.loc}\`: ${oneLine(f.a.quote)}`);
  if (f.b) lines.push(`- B \`${f.b.loc}\`: ${oneLine(f.b.quote)}`);
  if (f.argument) lines.push(`- Why it may not be deliberate: ${oneLine(f.argument)}`);
  lines.push(`- **${oneLine(f.question)}**`);
  if (f.reason) lines.push(`- Your note: ${oneLine(f.reason)}`);
  return lines;
}

/** .pi/FLAGS.md: open questions, the reviewer's restatement, and the monitor's notices. */
export function renderFlagsFile(
  store: FlagStore,
  notices: Array<{ kind: string; detail: string; turn: number }>
): string {
  const lines: string[] = [
    '# Ledger flags',
    '',
    'Generated by pi-ledger. Edits here are overwritten.',
    'Answer with `/flag <id> close <reason>` or `/flag <id> send`.',
    '',
  ];
  const open = store.flags.filter((f) => f.status === 'open');
  lines.push(`## Open questions (${open.length})`, '');
  if (open.length === 0) lines.push('None.', '');
  for (const f of open) lines.push(...renderFlag(f), '');

  if (store.restatement) {
    lines.push(
      `## The model as the reviewer understands it (turn ${store.restatement.turn})`,
      '',
      store.restatement.text.trim(),
      ''
    );
  }

  lines.push('## Notices', '');
  if (notices.length === 0) lines.push('None.');
  for (const n of [...notices].reverse())
    lines.push(`- turn ${n.turn} · ${n.kind} · ${oneLine(n.detail)}`);
  return lines.join('\n') + '\n';
}

/** Flags from a pi-supervisor-era session (concept register; intended/dismissed statuses). */
export function migrateRegister(old: unknown): FlagStore {
  const store = emptyFlags();
  if (typeof old !== 'object' || old === null) return store;
  const r = old as { flags?: unknown; nextFlag?: unknown; restatement?: FlagStore['restatement'] };
  for (const raw of Array.isArray(r.flags) ? r.flags : []) {
    const f = raw as Flag & { status: string };
    if (!f?.id || !f.a) continue;
    const flag: Flag = { ...f, b: f.b ?? null, status: live(f) ? f.status : 'closed' };
    store.flags.push(flag);
    if (flag.status === 'closed') closeFlag(store, flag, flag.reason);
  }
  store.nextFlag = typeof r.nextFlag === 'number' ? r.nextFlag : store.flags.length + 1;
  if (r.restatement) store.restatement = r.restatement;
  return store;
}
