/**
 * The status line: computed from the ledger and the stored state, never judged.
 *
 *   Acceptance 1/3 passed · 2 open flags · ledger current
 *
 * An Acceptance item is a bullet with an id under the "## Acceptance" heading
 * ("- AC1: …"). It counts as passed when the last status line for that id,
 * anywhere in the ledger, says passed and cites a run id ("AC1 status: passed (R12)").
 */

import { splitSections } from './checks.js';
import type { FindingKind } from './monitor.js';
import type { LedgerState } from './state.js';

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
  state: LedgerState;
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

  const open = state.register.flags.filter((f) => f.status === 'open').length;
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
