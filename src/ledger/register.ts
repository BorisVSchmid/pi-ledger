// src/ledger/register.ts
//
// Provided with the design brief; changed here: concept names resolve onto
// existing keys, and flag suppression is keyed on quotes, not line numbers.
//
// The model register: the supervisor's memory of what the model is, at the
// level of concepts. One entry per concept (process, quantity, assumption),
// each with its stated meaning and every place it is realised: code, priors,
// data preparation, interpretation, ledger, spec. Updated by small edits per
// review (never rewritten); persisted in the session; exported as markdown.
// Pure functions; no Pi imports.

export type Layer = 'code' | 'prior' | 'data' | 'interpretation' | 'ledger' | 'spec' | 'text';

export interface Realization {
  layer: Layer;
  loc: string; // "file:line", "MEMENTO.md#D2", "MODEL_SPEC.md#P1", ...
  value: string; // the abstraction / meaning used there
  quote: string; // verbatim evidence (verified before storage)
  turn: number;
}

export interface ConceptEntry {
  /** What the concept is meant to be, and who said so. */
  stated?: { value: string; source: string };
  realizations: Realization[];
  flags: string[];
}

export interface Flag {
  id: string;
  concept: string;
  /** 1-6 code-level types, 7-10 conceptual types (see REVIEWER.md). */
  type: number;
  a: { loc: string; quote: string };
  b: { loc: string; quote: string } | null;
  question: string;
  argument: string; // short chain of reasoning from the reviewer
  status: 'open' | 'intended' | 'dismissed' | 'sent';
  reason?: string;
  turn: number;
}

export interface Register {
  concepts: Record<string, ConceptEntry>;
  flags: Flag[];
  nextFlag: number;
  suppressed: string[];
  /** Reviewer's last ten-line restatement of the model, for the human to compare. */
  restatement?: { text: string; turn: number };
}

export function emptyRegister(): Register {
  return { concepts: {}, flags: [], nextFlag: 1, suppressed: [] };
}

// ---------- edits proposed by the reviewer ----------

export type RegisterEdit =
  | { op: 'stated'; concept: string; value: string; source: string }
  | { op: 'realization'; concept: string; layer: Layer; loc: string; value: string; quote: string }
  | { op: 'remove_realization'; concept: string; loc: string };

/**
 * Map a concept name onto an existing register key. Names that start with the
 * same spec id ("P1 transmission" vs "P1 Transmission") or differ only in case
 * and spacing resolve to the existing key.
 */
export function resolveConcept(reg: Register, name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (reg.concepts[trimmed]) return trimmed;
  const id = /^(P\d+)\b/i.exec(trimmed)?.[1]?.toUpperCase();
  for (const key of Object.keys(reg.concepts)) {
    if (key.toLowerCase() === trimmed.toLowerCase()) return key;
    if (id && /^(P\d+)\b/i.exec(key)?.[1]?.toUpperCase() === id) return key;
  }
  return trimmed;
}

export function applyEdits(reg: Register, edits: RegisterEdit[], turn: number): Register {
  for (const e of edits) {
    const concept = resolveConcept(reg, e.concept);
    const entry = (reg.concepts[concept] ??= { realizations: [], flags: [] });
    if (e.op === 'stated') {
      const authoritative = /^(user|spec)/i.test(e.source);
      if (!entry.stated || authoritative) entry.stated = { value: e.value, source: e.source };
    } else if (e.op === 'realization') {
      const existing = entry.realizations.find((r) => r.loc === e.loc);
      if (existing)
        Object.assign(existing, { layer: e.layer, value: e.value, quote: e.quote, turn });
      else
        entry.realizations.push({
          layer: e.layer,
          loc: e.loc,
          value: e.value,
          quote: e.quote,
          turn,
        });
    } else if (e.op === 'remove_realization') {
      entry.realizations = entry.realizations.filter((r) => r.loc !== e.loc);
    }
  }
  return reg;
}

/** Realizations of a concept whose `value` disagrees with the stated value or with each other. */
export function disagreements(entry: ConceptEntry): string[] {
  const values = new Set(entry.realizations.map((r) => r.value.trim().toLowerCase()));
  if (entry.stated) values.add(entry.stated.value.trim().toLowerCase());
  return values.size > 1 ? [...values] : [];
}

// ---------- flags ----------

function normalizeQuote(q: string): string {
  return q.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** "R/herd.R:42" -> "R/herd.R"; "MEMENTO.md#D2" -> "MEMENTO.md#D2". */
function locFile(loc: string): string {
  return loc.trim().replace(/:\d+(?:-\d+)?$/, '');
}

/**
 * Suppression key: concept plus the evidence (file and quote) on each side,
 * order-independent. Keyed on quotes rather than line numbers so that an
 * `intended` flag stays suppressed when lines above it move.
 */
export function suppressionKey(
  concept: string,
  sides: Array<{ loc: string; quote: string }>
): string {
  const parts = sides.map((s) => `${locFile(s.loc)}~${normalizeQuote(s.quote)}`).sort();
  return `${concept.trim().toLowerCase()}|${parts.join('|')}`;
}

function flagSides(f: {
  a: { loc: string; quote: string };
  b?: { loc: string; quote: string } | null;
}) {
  return [f.a, ...(f.b ? [f.b] : [])];
}

export interface FlagInput {
  concept: string;
  type: number;
  a: { loc: string; quote: string };
  b?: { loc: string; quote: string } | null;
  question: string;
  argument?: string;
}

export function addFlag(reg: Register, input: FlagInput, turn: number): Flag | null {
  const concept = resolveConcept(reg, input.concept);
  const key = suppressionKey(concept, flagSides(input));
  if (reg.suppressed.includes(key)) return null;
  const dup = reg.flags.find(
    (f) =>
      (f.status === 'open' || f.status === 'sent') &&
      suppressionKey(f.concept, flagSides(f)) === key
  );
  if (dup) return null;
  const flag: Flag = {
    id: `F${reg.nextFlag++}`,
    concept,
    type: input.type,
    a: input.a,
    b: input.b ?? null,
    question: input.question,
    argument: input.argument ?? '',
    status: 'open',
    turn,
  };
  reg.flags.push(flag);
  const entry = (reg.concepts[concept] ??= { realizations: [], flags: [] });
  entry.flags.push(flag.id);
  return flag;
}

export function resolveFlag(
  reg: Register,
  id: string,
  action: 'intended' | 'dismiss' | 'send',
  reason?: string
): Flag | null {
  const f = reg.flags.find((x) => x.id.toLowerCase() === id.toLowerCase());
  if (!f) return null;
  f.status = action === 'dismiss' ? 'dismissed' : action === 'intended' ? 'intended' : 'sent';
  if (reason) f.reason = reason;
  if (action !== 'send') {
    const key = suppressionKey(f.concept, flagSides(f));
    if (!reg.suppressed.includes(key)) reg.suppressed.push(key);
    const entry = reg.concepts[f.concept];
    if (entry) entry.flags = entry.flags.filter((x) => x !== id);
  }
  return f;
}

/** Steer text for /flag <id> send. Templated; the model never writes steers. */
export function steerTextFor(flag: Flag): string {
  const where = flag.b ? `${flag.a.loc} and ${flag.b.loc}` : flag.a.loc;
  return `Ledger check: possible inconsistency in ${flag.concept} between ${where}. ${flag.question} Reconcile it, or record the difference as a deliberate decision in MEMENTO.md with the reason.`;
}

// ---------- rendering ----------

export function renderRegister(reg: Register): string {
  const L: string[] = ['# Model register (maintained by the reviewer; read-only)', ''];
  if (reg.restatement)
    L.push('## Model as the reviewer understands it', reg.restatement.text.trim(), '');
  const ids = Object.keys(reg.concepts).sort();
  if (ids.length === 0) L.push('_no concepts yet_', '');
  for (const id of ids) {
    const c = reg.concepts[id];
    L.push(`## ${id}`, `stated: ${c.stated ? `${c.stated.value} (${c.stated.source})` : '—'}`);
    for (const r of c.realizations)
      L.push(`${r.layer.padEnd(14)} ${r.loc}  ${r.value}  (turn ${r.turn})`);
    const d = disagreements(c);
    if (d.length) L.push(`disagreement: ${d.join(' | ')}`);
    if (c.flags.length) L.push(`open: ${c.flags.join(', ')}`);
    L.push('');
  }
  const open = reg.flags.filter((f) => f.status === 'open');
  L.push(`## Flags (${open.length} open)`);
  for (const f of reg.flags) {
    L.push(`- ${f.id} [${f.status}] ${f.concept} type ${f.type}`);
    L.push(`    A ${f.a.loc}: ${f.a.quote}`);
    if (f.b) L.push(`    B ${f.b.loc}: ${f.b.quote}`);
    if (f.argument) L.push(`    because: ${f.argument}`);
    L.push(`    ? ${f.question}${f.reason ? `  — ${f.reason}` : ''}`);
  }
  return L.join('\n') + '\n';
}

/** Compact block for the reviewer prompt. */
export function registerForPrompt(reg: Register, maxChars = 6000): string {
  const slim = {
    concepts: Object.fromEntries(
      Object.entries(reg.concepts).map(([k, v]) => [
        k,
        { stated: v.stated, realizations: v.realizations.map(({ quote, ...r }) => r) },
      ])
    ),
    openFlags: reg.flags
      .filter((f) => f.status === 'open')
      .map((f) => ({
        id: f.id,
        concept: f.concept,
        type: f.type,
        locs: [f.a.loc, f.b?.loc].filter(Boolean),
      })),
    intended: reg.flags
      .filter((f) => f.status === 'intended')
      .map((f) => ({
        concept: f.concept,
        locs: [f.a.loc, f.b?.loc].filter(Boolean),
        reason: f.reason,
      })),
  };
  const s = JSON.stringify(slim, null, 1);
  return `[Model Register]\n${s.length > maxChars ? s.slice(0, maxChars) + '\n…(truncated)' : s}\n`;
}

// ---------- spec seeding ----------

/**
 * Stated meanings from MODEL_SPEC.md: one per `## P<n> <name>` heading, value =
 * the first bullet under it. Source "spec", which outranks reviewer-stated values.
 */
export function specStatements(specText: string): RegisterEdit[] {
  const edits: RegisterEdit[] = [];
  let concept: string | null = null;
  for (const line of specText.split(/\r?\n/)) {
    const h = /^##\s+(P\d+\b.*?)\s*$/.exec(line);
    if (h) {
      concept = h[1];
      continue;
    }
    if (/^##\s/.test(line)) {
      concept = null;
      continue;
    }
    const bullet = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (concept && bullet) {
      edits.push({ op: 'stated', concept, value: bullet[1], source: 'spec' });
      concept = null;
    }
  }
  return edits;
}
