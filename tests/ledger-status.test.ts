import { describe, expect, it } from 'vitest';
import { acceptanceSummary, statusDetail, statusLine } from '../src/ledger/status.js';
import { emptyLedgerState } from '../src/ledger/state.js';

const LEDGER = `# Vole fit

## Acceptance (locked)

- AC1: RMSE on held-out years 2012-2013 below 0.4
- AC2: peaks follow mast years with a one-year lag
- AC3: no parameter at a bound
- AC1 status: passed (R7)

## Observed

- O1: lag recovered — R9
- AC2 status: passed (R9)
- AC2 status: failed (R11)
- AC3 status: passed
`;

describe('acceptanceSummary', () => {
  it('reads items and takes the last status line per id', () => {
    const acc = acceptanceSummary(LEDGER);
    expect(acc.present).toBe(true);
    expect(acc.items.map((i) => [i.id, i.status, i.run])).toEqual([
      ['AC1', 'passed', 'R7'],
      ['AC2', 'failed', 'R11'],
      // "passed" without a run id stays open.
      ['AC3', 'open', null],
    ]);
  });

  it('reports a missing section', () => {
    expect(acceptanceSummary('# Q\n## Next\n- fit\n').present).toBe(false);
    expect(acceptanceSummary(null).present).toBe(false);
  });
});

describe('statusLine', () => {
  const state = () => {
    const s = emptyLedgerState();
    s.turn = 3;
    s.register.flags.push(
      { id: 'F1', status: 'open' } as never,
      { id: 'F2', status: 'open' } as never,
      { id: 'F3', status: 'dismissed' } as never
    );
    return s;
  };

  it('summarises acceptance, flags and ledger state', () => {
    expect(statusLine({ ledgerText: LEDGER, ledgerName: 'MEMENTO.md', state: state() })).toBe(
      'Acceptance 1/3 passed, 1 failed · 2 open flags · ledger current'
    );
  });

  it('says the ledger is behind after a ledger finding, and when a review runs', () => {
    const s = state();
    s.lastTurnFindings = ['LEDGER_LINE_MISSING'];
    expect(
      statusLine({ ledgerText: LEDGER, ledgerName: 'MEMENTO.md', state: s, reviewing: true })
    ).toBe('Acceptance 1/3 passed, 1 failed · 2 open flags · ledger behind · reviewing…');
  });

  it('handles a missing ledger and an unchecked one', () => {
    const s = emptyLedgerState();
    expect(statusLine({ ledgerText: null, ledgerName: 'MEMENTO.md', state: s })).toBe(
      'no Acceptance · 0 open flags · no MEMENTO.md'
    );
    expect(statusLine({ ledgerText: LEDGER, ledgerName: 'MEMENTO.md', state: s })).toMatch(
      /ledger not checked yet$/
    );
  });

  it('lists items in the detail view', () => {
    expect(statusDetail(LEDGER)).toContain('AC1 passed (R7): RMSE on held-out years');
  });
});
