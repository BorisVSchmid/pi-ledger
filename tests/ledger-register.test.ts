import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addFlag,
  applyEdits,
  emptyRegister,
  resolveFlag,
  specStatements,
  type FlagInput,
} from '../src/ledger/register.js';
import { flagCommand, metricsText } from '../src/ledger/commands.js';
import { LedgerRuntime } from '../src/ledger/runtime.js';
import { defaultConfig } from '../src/ledger/config.js';

const SPEC = readFileSync(
  join(__dirname, '..', 'ledger-mode-brief', 'templates', 'MODEL_SPEC.template.md'),
  'utf8'
);

const flagInput = (aLine: number, bLine: number): FlagInput => ({
  concept: 'P1 transmission',
  type: 1,
  a: { loc: `R/herd.R:${aLine}`, quote: 'foi <- beta * S * I / N' },
  b: { loc: `R/region.R:${bLine}`, quote: 'foi <- beta * S * I' },
  question: 'Is transmission meant to be frequency-dependent in both places?',
  argument: 'One divides by N, the other does not.',
});

describe('register flags', () => {
  it('creates a flag once and ignores duplicates', () => {
    const reg = emptyRegister();
    expect(addFlag(reg, flagInput(42, 88), 1)?.id).toBe('F1');
    expect(addFlag(reg, flagInput(42, 88), 2)).toBeNull();
    expect(reg.flags).toHaveLength(1);
  });

  it('intended suppresses re-flagging, with reversed and shifted locations', () => {
    const reg = emptyRegister();
    addFlag(reg, flagInput(42, 88), 1);
    resolveFlag(reg, 'f1', 'intended', 'deliberate: regional model is density-dependent');
    expect(reg.flags[0].status).toBe('intended');
    // shifted lines
    expect(addFlag(reg, flagInput(45, 90), 3)).toBeNull();
    // reversed sides
    const reversed = flagInput(45, 90);
    [reversed.a, reversed.b] = [reversed.b!, reversed.a];
    expect(addFlag(reg, reversed, 3)).toBeNull();
    // different concept spelling resolves to the same concept
    expect(addFlag(reg, { ...flagInput(1, 2), concept: 'P1 Transmission' }, 3)).toBeNull();
    // changed evidence is a new question
    expect(
      addFlag(
        reg,
        { ...flagInput(42, 88), b: { loc: 'R/region.R:88', quote: 'foi <- beta * I' } },
        4
      )
    ).not.toBeNull();
  });

  it('send does not suppress', () => {
    const reg = emptyRegister();
    addFlag(reg, flagInput(1, 2), 1);
    resolveFlag(reg, 'F1', 'send');
    expect(reg.suppressed).toEqual([]);
  });
});

describe('spec seeding', () => {
  it('reads one stated value per P heading from the template', () => {
    const edits = specStatements(SPEC);
    expect(edits.map((e) => e.concept)).toEqual([
      'P1 Transmission',
      'P2 External introduction',
      'P3 Demography',
    ]);
    const reg = applyEdits(emptyRegister(), edits, 0);
    expect(reg.concepts['P1 Transmission'].stated).toEqual({
      value: 'formulation: frequency-dependent  (FOI = β · I / N)',
      source: 'spec',
    });
    // a reviewer edit with a differently spelled name lands on the same concept
    applyEdits(
      reg,
      [
        {
          op: 'realization',
          concept: 'P1 transmission',
          layer: 'code',
          loc: 'R/herd.R:42',
          value: 'frequency-dependent',
          quote: 'foi <- beta * S * I / N',
        },
      ],
      1
    );
    expect(Object.keys(reg.concepts)).toHaveLength(3);
    expect(reg.concepts['P1 Transmission'].realizations).toHaveLength(1);
  });
});

describe('/flag command', () => {
  let cwd: string;
  let branch: any[];
  let pi: any;
  let ctx: any;
  const config = { ...defaultConfig(), mode: 'ledger' as const };

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'pi-ledger-flag-'));
    branch = [];
    pi = {
      appendEntry: vi.fn((customType: string, data: unknown) =>
        branch.push({ type: 'custom', customType, data: JSON.parse(JSON.stringify(data)) })
      ),
      sendUserMessage: vi.fn(),
    };
    ctx = { cwd, ui: { notify: vi.fn() }, sessionManager: { getBranch: () => branch } };
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('lists, resolves and sends flags; only send steers', async () => {
    const rt = new LedgerRuntime(pi);
    rt.load(ctx);
    addFlag(rt.state().register, flagInput(42, 88), 1);
    addFlag(rt.state().register, { ...flagInput(1, 2), concept: 'P2 external' }, 1);

    expect(await flagCommand('', ctx, pi, rt, config)).toMatch(/F1[\s\S]*F2/);
    expect(await flagCommand('F1 intended deliberate', ctx, pi, rt, config)).toMatch(/intended/);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(await flagCommand('F2 send', ctx, pi, rt, config)).toMatch(/sent/);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage.mock.calls[0][0]).toMatch(/^Ledger check: possible inconsistency/);
    expect(await flagCommand('F9 send', ctx, pi, rt, config)).toMatch(/No flag F9/);

    const flags = readFileSync(join(cwd, '.pi', 'FLAGS.md'), 'utf8');
    expect(flags).toMatch(/Open questions \(0\)/);
    expect(readFileSync(join(cwd, '.pi', 'model-register.md'), 'utf8')).toMatch(/F1 \[intended\]/);
    expect(metricsText(rt)).toMatch(/intended 1/);

    // state survives a reload
    const rt2 = new LedgerRuntime(pi);
    rt2.load(ctx);
    expect(rt2.state().register.flags.map((f) => f.status)).toEqual(['intended', 'sent']);
  });

  it('seeds the register from MODEL_SPEC.md and exports it', async () => {
    writeFileSync(join(cwd, 'MODEL_SPEC.md'), SPEC);
    const rt = new LedgerRuntime(pi);
    rt.load(ctx);
    expect(await rt.seedFromSpec(ctx, config)).toBe(3);
    expect(readFileSync(join(cwd, '.pi', 'model-register.md'), 'utf8')).toMatch(
      /## P1 Transmission\nstated: formulation: frequency-dependent/
    );
  });
});
