/**
 * Ledger-mode per-turn monitor (D1–D5 plus injection), code only.
 *
 * `evaluateTurn` is pure: it takes what the turn left behind and returns
 * findings. `routeFindings` decides which findings steer (templated, never
 * repeated) and which become notices. No model is called here.
 */

import {
  cjkRatio,
  hashText,
  ledgerClaimMismatch,
  lockedSectionsChanged,
  parseLedgerLine,
  type SnapshotDiff,
} from './checks.js';

export type FindingKind =
  | 'LEDGER_LINE_MISSING'
  | 'LEDGER_CLAIMED_NO_CHANGE'
  | 'LEDGER_CHANGED_UNCLAIMED'
  | 'LOCKED_SECTION_EDITED'
  | 'LANGUAGE_DRIFT'
  | 'INJECTION'
  | 'TURN_FINDING'
  | 'SUMMARY_STALE';

export interface Finding {
  kind: FindingKind;
  detail: string;
}

/** Steer templates (brief 5.4). The model never writes steers. */
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
  lockedHeadings: string[];
  cjkRatioMax: number;
}

/** Text addressed to the supervisor or reviewer, or a classic instruction override. */
const INJECTION_PATTERNS: RegExp[] = [
  /^[\s>*_#-]*(?:supervisor|reviewer|monitor)\s*[:,]/im,
  /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+instructions\b/i,
  /\b(?:supervisor|reviewer)\s*,?\s+(?:please\s+)?(?:report|flag|ignore)\s+nothing\b/i,
];

export function findInjection(text: string): string | null {
  for (const re of INJECTION_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      const start = text.lastIndexOf('\n', m.index) + 1;
      const end = text.indexOf('\n', m.index + m[0].length);
      return text.slice(start, end === -1 ? undefined : end).trim();
    }
  }
  return null;
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
      input.lockedHeadings
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
    if (ratio > input.cjkRatioMax) {
      findings.push({
        kind: 'LANGUAGE_DRIFT',
        detail: `${where}: ${(ratio * 100).toFixed(1)}% CJK characters`,
      });
    }
  }

  // Injection: text addressed to the supervisor in the reply, the ledger or the model edits.
  const editAdded = (input.modelDiff?.hunks ?? [])
    .flatMap((h) => h.lines.filter((l) => l.startsWith('+')).map((l) => l.slice(1)))
    .join('\n');
  for (const [where, text] of [
    ['reply', input.assistantText],
    ['MEMENTO.md', ledgerAdded],
    ['model files', editAdded],
  ] as const) {
    const hit = findInjection(text);
    if (hit) findings.push({ kind: 'INJECTION', detail: `${where}: "${hit.slice(0, 160)}"` });
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
 * Route findings. Steer kinds listed in `autoSteer` produce a templated steer
 * unless the same (kind, ledger hash) was already sent; everything else is a notice.
 */
export function routeFindings(
  findings: Finding[],
  opts: { autoSteer: FindingKind[]; steerHistory: string[]; ledgerHash: string | null }
): RoutedFindings {
  const out: RoutedFindings = { steer: null, notices: [], suppressedSteers: 0 };
  for (const f of findings) {
    const template = STEER_TEMPLATES[f.kind];
    if (template && opts.autoSteer.includes(f.kind)) {
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
