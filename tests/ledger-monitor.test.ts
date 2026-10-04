import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateTurn,
  ledgerClaimMismatch,
  parseLedgerLine,
  routeFindings,
  snapshotFiles,
  type Finding,
} from '../src/monitor.js';
import { LedgerRuntime } from '../src/runtime.js';
import { defaultConfig, type LedgerConfig } from '../src/config.js';

const LEDGER = `# Q
## Acceptance (locked)
- AC1: held-out 2019-2021
## Assumptions
- A1: closed population
## Checks (locked, written before the run)
- C1: R4 should show peak in July; fails if peak outside Jun-Aug
## Next
- fit model
`;

const base = {
  assistantText: 'Did the fit.\nLedger: unchanged',
  ledgerBefore: LEDGER,
  ledgerAfter: LEDGER,
  modelDiff: null,
};
const kinds = (fs: Finding[]) => fs.map((f) => f.kind);

describe('ledger line parsing (D1)', () => {
  it('accepts plain, bold, and reasoned "unchanged" lines', () => {
    expect(parseLedgerLine('x\nLedger: unchanged')).toMatchObject({
      present: true,
      claimsChange: false,
    });
    expect(parseLedgerLine('x\n**Ledger:** unchanged')).toMatchObject({
      present: true,
      claimsChange: false,
    });
    expect(parseLedgerLine('Ledger: unchanged — nothing new')).toMatchObject({
      claimsChange: false,
    });
    expect(parseLedgerLine('Ledger: A2 — added immigration')).toMatchObject({ claimsChange: true });
    expect(parseLedgerLine('Ledger: unchangeable things noted').claimsChange).toBe(true);
  });

  it('a null baseline never produces a D2 mismatch', () => {
    expect(ledgerClaimMismatch(parseLedgerLine('Ledger: A2 added'), null)).toBeNull();
  });
});

describe('evaluateTurn', () => {
  it('reports nothing for a clean turn', () => {
    expect(evaluateTurn(base)).toEqual([]);
  });

  it('D1 fires when the line is missing, and only when a ledger exists', () => {
    expect(kinds(evaluateTurn({ ...base, assistantText: 'Did the fit.' }))).toEqual([
      'LEDGER_LINE_MISSING',
    ]);
    expect(
      evaluateTurn({ ...base, assistantText: 'Did it.', ledgerBefore: null, ledgerAfter: null })
    ).toEqual([]);
  });

  it('D2 fires in both directions', () => {
    const changed = LEDGER + '- A2: immigration allowed\n';
    expect(kinds(evaluateTurn({ ...base, assistantText: 'Ledger: A2 added' }))).toEqual([
      'LEDGER_CLAIMED_NO_CHANGE',
    ]);
    expect(kinds(evaluateTurn({ ...base, ledgerAfter: changed }))).toEqual([
      'LEDGER_CHANGED_UNCLAIMED',
    ]);
    expect(
      evaluateTurn({ ...base, ledgerAfter: changed, assistantText: 'Ledger: A2 added' })
    ).toEqual([]);
    // unknown baseline: no D2
    expect(evaluateTurn({ ...base, ledgerBefore: undefined, assistantText: 'Ledger: A2' })).toEqual(
      []
    );
  });

  it('D3 fires on an edited Checks line but not on an appended status line', () => {
    const edited = LEDGER.replace('fails if peak outside Jun-Aug', 'fails if peak outside May-Sep');
    expect(
      kinds(evaluateTurn({ ...base, ledgerAfter: edited, assistantText: 'Ledger: C1' }))
    ).toEqual(['LOCKED_SECTION_EDITED']);
    const appended = LEDGER.replace('Jun-Aug\n', 'Jun-Aug\n- C1 status: passed (R4)\n');
    expect(
      evaluateTurn({ ...base, ledgerAfter: appended, assistantText: 'Ledger: C1 passed' })
    ).toEqual([]);
  });

  it('D5 fires on CJK drift in the reply or the ledger additions', () => {
    expect(
      kinds(evaluateTurn({ ...base, assistantText: '模型拟合完成，结果良好。\nLedger: unchanged' }))
    ).toEqual(['LANGUAGE_DRIFT']);
    const drift = LEDGER + '- O1: 峰值在七月\n';
    expect(
      kinds(evaluateTurn({ ...base, ledgerAfter: drift, assistantText: 'Ledger: O1' }))
    ).toEqual(['LANGUAGE_DRIFT']);
  });
});

describe('routeFindings', () => {
  const opts = { ledgerHash: 'h1' };

  it('steers once per (kind, ledger hash) and never repeats', () => {
    const f: Finding[] = [{ kind: 'LEDGER_LINE_MISSING', detail: '' }];
    const first = routeFindings(f, { ...opts, steerHistory: [] });
    expect(first.steer?.text).toMatch(/^Ledger check:/);
    const again = routeFindings(f, { ...opts, steerHistory: [first.steer!.key] });
    expect(again.steer).toBeNull();
    expect(again.suppressedSteers).toBe(1);
  });

  it('routes non-steer findings to notices', () => {
    const r = routeFindings([{ kind: 'LOCKED_SECTION_EDITED', detail: '## Checks' }], {
      ...opts,
      steerHistory: [],
    });
    expect(r.steer).toBeNull();
    expect(r.notices).toHaveLength(1);
  });
});

describe('snapshotFiles ignore globs', () => {
  it('skips ignored directories', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-ledger-snap-'));
    mkdirSync(join(dir, 'R'), { recursive: true });
    mkdirSync(join(dir, 'renv', 'R'), { recursive: true });
    writeFileSync(join(dir, 'R', 'a.R'), 'x <- 1\n');
    writeFileSync(join(dir, 'renv', 'R', 'b.R'), 'y <- 1\n');
    const snap = await snapshotFiles(dir, ['**/*.R'], 400_000, ['**/renv/**']);
    expect(Object.keys(snap)).toEqual(['R/a.R']);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('LedgerRuntime', () => {
  let cwd: string;
  let config: LedgerConfig;
  let branch: any[];
  let pi: any;
  let ctx: any;
  let notify: ReturnType<typeof vi.fn>;

  const reply = (text: string) =>
    branch.push({
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'pi-ledger-rt-'));
    config = defaultConfig();
    config.files.modelFiles = ['R/**/*.R'];
    branch = [];
    notify = vi.fn();
    pi = {
      appendEntry: vi.fn((customType: string, data: unknown) =>
        branch.push({ type: 'custom', customType, data: JSON.parse(JSON.stringify(data)) })
      ),
      sendUserMessage: vi.fn(),
    };
    ctx = { cwd, ui: { notify }, sessionManager: { getBranch: () => branch } };
    writeFileSync(join(cwd, 'MEMENTO.md'), LEDGER);
    mkdirSync(join(cwd, 'R'));
    writeFileSync(join(cwd, 'R', 'model.R'), 'foi <- beta * I / N\n');
  });

  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('makes no review on a turn without edits', async () => {
    const rt = new LedgerRuntime(pi);
    rt.callModel = vi.fn();
    rt.load(ctx);
    await rt.onAgentStart(ctx, config);
    reply('Ledger: unchanged');
    await rt.onSettled(ctx, config);
    expect(rt.callModel).not.toHaveBeenCalled();
  });

  it('steers on a missing Ledger line once, then never again for the same ledger', async () => {
    const rt = new LedgerRuntime(pi);
    rt.load(ctx);
    await rt.onAgentStart(ctx, config);
    reply('Fitted the model.');
    await rt.onSettled(ctx, config);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage.mock.calls[0][0]).toMatch(/end the turn with a "Ledger:" line/);

    await rt.onAgentStart(ctx, config);
    reply('Still no line.');
    await rt.onSettled(ctx, config);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(rt.state().metrics['steer.suppressed']).toBe(1);
  });

  it('does not blame the agent for edits made between turns', async () => {
    const rt = new LedgerRuntime(pi);
    rt.load(ctx);
    await rt.onAgentStart(ctx, config);
    reply('Ledger: unchanged');
    await rt.onSettled(ctx, config);
    // human edits MEMENTO.md while idle
    writeFileSync(join(cwd, 'MEMENTO.md'), LEDGER + '- A2: human note\n');
    await rt.onAgentStart(ctx, config);
    reply('Ledger: unchanged');
    await rt.onSettled(ctx, config);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it('starts a review after a model edit and writes notices to FLAGS.md', async () => {
    const rt = new LedgerRuntime(pi);
    rt.callModel = vi.fn().mockResolvedValue({ ok: false, error: 'offline', model: null });
    rt.load(ctx);
    await rt.onAgentStart(ctx, config);
    writeFileSync(join(cwd, 'R', 'model.R'), 'foi <- beta * I / N\nfoi2 <- beta * I\n');
    writeFileSync(
      join(cwd, 'MEMENTO.md'),
      LEDGER.replace('fails if peak outside Jun-Aug', 'fails if peak outside May-Sep')
    );
    reply('Ledger: C1 widened');
    await rt.onSettled(ctx, config);
    await rt.pending;
    expect(rt.callModel).toHaveBeenCalledTimes(1);
    expect(rt.state().metrics['review.edit']).toBe(1);
    const flags = readFileSync(join(cwd, '.pi', 'FLAGS.md'), 'utf8');
    expect(flags).toMatch(/LOCKED_SECTION_EDITED/);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/LOCKED_SECTION_EDITED/), 'warning');
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it('restores state from the session', async () => {
    const rt = new LedgerRuntime(pi);
    rt.load(ctx);
    await rt.onAgentStart(ctx, config);
    reply('no line');
    await rt.onSettled(ctx, config);
    const rt2 = new LedgerRuntime(pi);
    rt2.load(ctx);
    expect(rt2.state().turn).toBe(1);
    expect(rt2.state().steerHistory).toHaveLength(1);
    expect(rt2.state().lastTurnFindings).toEqual(['LEDGER_LINE_MISSING']);
    expect(existsSync(join(cwd, '.pi', 'FLAGS.md'))).toBe(false);
  });
});
