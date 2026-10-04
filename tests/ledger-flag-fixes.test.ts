// Fixes from the first live ledger-mode run (2026-10-04): flag flood, review
// loop, stale concept labels after a spec rename, and flag visibility.

import { describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addFlag,
  addFlagResult,
  applyEdits,
  emptyRegister,
  registerForPrompt,
  resolveFlag,
  sameLocation,
  syncFromSpec,
  type FlagInput,
} from '../src/ledger/register.js';
import { automaticTrigger, reviewNotice, type TriggerInput } from '../src/ledger/reviewer.js';
import { renderFlagsFile } from '../src/ledger/flags-file.js';
import { emptyLedgerState } from '../src/ledger/state.js';
import { LedgerRuntime } from '../src/ledger/runtime.js';
import { defaultConfig, type LedgerConfig } from '../src/ledger/config.js';
import type { JsonCallResult } from '../src/ledger/model-call.js';

// The pair the live run raised twice (F1, F2 in the vole/fox session).
const c1Flag = (quoteA: string, question: string): FlagInput => ({
  concept: 'P2 Voles',
  type: 6,
  a: { loc: 'MEMENTO.md#C1', quote: quoteA },
  b: { loc: 'MEMENTO.md#R1', quote: 'Years 5-10: V 0.9-50' },
  question,
});

describe('flag dedup against open flags', () => {
  it('treats the same anchors or nearby lines in the same file as one place', () => {
    expect(sameLocation('MEMENTO.md#C1', 'memento.md#c1')).toBe(true);
    expect(sameLocation('MEMENTO.md#C1', 'MEMENTO.md#C2')).toBe(false);
    expect(sameLocation('R/model.R:40', './R/model.R:42-44')).toBe(true);
    expect(sameLocation('R/model.R:40', 'R/model.R:44')).toBe(false);
    expect(sameLocation('R/model.R:40', 'R/fit.R:40')).toBe(false);
    expect(sameLocation('R/model.R', 'R/model.R')).toBe(true);
    expect(sameLocation('R/model.R', 'R/model.R:3')).toBe(false);
  });

  it('merges a re-raised question with other quotes into the open flag', () => {
    const reg = emptyRegister();
    expect(addFlag(reg, c1Flag('expected bounded oscillations', 'Is C1 passed?'), 1)?.id).toBe(
      'F1'
    );
    const r = addFlagResult(
      reg,
      c1Flag('C1 status: passed for R1', 'Does passed rest on the min/max only?'),
      2
    );
    expect(r).toEqual({ flag: null, repeatOf: 'F1' });
    // reversed sides and a differently spelled concept are the same question
    const rev = c1Flag('x', 'y');
    [rev.a, rev.b] = [rev.b!, rev.a];
    expect(addFlagResult(reg, { ...rev, concept: 'p2 voles' }, 3).repeatOf).toBe('F1');
    // one side at the same place also counts
    expect(addFlagResult(reg, { ...c1Flag('z', 'q'), b: null }, 4).repeatOf).toBe('F1');
    expect(reg.flags).toHaveLength(1);
    expect(reg.flags[0]).toMatchObject({ repeats: 3, lastRaisedTurn: 4 });
  });

  it('keeps flags at other places or on other concepts', () => {
    const reg = emptyRegister();
    addFlag(reg, c1Flag('a', 'q'), 1);
    expect(
      addFlag(reg, { ...c1Flag('a', 'q'), b: { loc: 'MEMENTO.md#A1', quote: 'b' } }, 2)?.id
    ).toBe('F2');
    expect(addFlag(reg, { ...c1Flag('a', 'q'), concept: 'P3 Foxes' }, 2)?.id).toBe('F3');
  });

  it('honours the reviewer naming an open flag, but not a resolved one', () => {
    const reg = emptyRegister();
    addFlag(reg, c1Flag('a', 'q'), 1);
    addFlag(reg, { ...c1Flag('a', 'q'), concept: 'P3 Foxes' }, 1);
    const elsewhere: FlagInput = {
      concept: 'P1 Food',
      type: 1,
      a: { loc: 'R/model.R:10', quote: 'f' },
      question: 'q',
    };
    expect(addFlagResult(reg, { ...elsewhere, sameAs: 'F2' }, 2).repeatOf).toBe('F2');
    expect(addFlagResult(reg, { ...elsewhere, sameAs: 'F2 (repeat)' }, 2).repeatOf).toBe('F2');
    resolveFlag(reg, 'F1', 'dismiss');
    expect(addFlagResult(reg, { ...elsewhere, sameAs: 'F1' }, 3).flag?.id).toBe('F3');
  });

  it('a resolved flag still suppresses only its exact evidence', () => {
    const reg = emptyRegister();
    addFlag(reg, c1Flag('a', 'q'), 1);
    resolveFlag(reg, 'F1', 'intended');
    expect(addFlagResult(reg, c1Flag('a', 'q2'), 2)).toEqual({ flag: null, suppressed: true });
    expect(addFlag(reg, c1Flag('changed evidence', 'q'), 2)?.id).toBe('F2');
  });
});

describe('register block in the reviewer prompt', () => {
  it('lists open flags with their questions first and never truncates them', () => {
    const reg = emptyRegister();
    for (let i = 0; i < 40; i++) {
      applyEdits(
        reg,
        [
          {
            op: 'realization',
            concept: `P${i} concept`,
            layer: 'code',
            loc: `R/m.R:${i}`,
            value: 'v'.repeat(200),
            quote: 'q',
          },
        ],
        1
      );
    }
    addFlag(reg, c1Flag('a', 'Is C1 passed on the min/max only?'), 1);
    addFlag(reg, { ...c1Flag('a', 'Deliberate?'), concept: 'P3 Foxes' }, 1);
    resolveFlag(reg, 'F2', 'intended', 'yes');
    const block = registerForPrompt(reg, 1000);
    expect(block.indexOf('openFlags')).toBeLessThan(block.indexOf('concepts:'));
    expect(block).toMatch(/"question": "Is C1 passed on the min\/max only\?"/);
    expect(block).toMatch(/"status": "intended"[\s\S]*"reason": "yes"/);
    expect(block).toMatch(/…\(truncated\)\n$/);
    const flagsPart = block.slice(0, block.indexOf('concepts:'));
    expect(flagsPart).not.toMatch(/truncated/);
  });
});

describe('review trigger', () => {
  const base: TriggerInput = {
    turn: 5,
    lastReviewTurn: 4,
    turnDiff: null,
    modelEditsSinceReview: false,
    register: emptyRegister(),
    registerGrewLastReview: true,
    ledgerBefore: '## Next\n- fit\n',
    ledgerAfter: '## Next\n- fit\n',
    triggers: { onRegisterChange: true, onBreakpoint: true, idleAfterModelEditsEveryNTurns: 6 },
  };
  const hunk = {
    file: 'R/a.R',
    newStart: 1,
    newEnd: 1,
    oldStart: 1,
    oldEnd: 1,
    lines: ['+x <- 1'],
  };

  it('does not fire on register growth alone (an unchanged turn)', () => {
    expect(automaticTrigger(base)).toBeNull();
  });

  it('fires when the turn edits a model file after the register grew, or edits the spec', () => {
    const diff = { changed: ['R/a.R'], added: [], removed: [], hunks: [hunk] };
    expect(automaticTrigger({ ...base, turnDiff: diff })).toBe('register_change');
    expect(automaticTrigger({ ...base, turnDiff: diff, registerGrewLastReview: false })).toBeNull();
    expect(automaticTrigger({ ...base, specChanged: true })).toBe('register_change');
  });
});

describe('spec heading renames', () => {
  const spec = (p3: string) => `## P2 Voles\n- prey\n\n## P3 ${p3}\n- predator\n`;

  it('renames the concept, its flags and its suppression keys', () => {
    const reg = emptyRegister();
    syncFromSpec(reg, spec('Foxes'), 0);
    addFlag(reg, { ...c1Flag('a', 'q'), concept: 'P3 Foxes' }, 1);
    const a1 = { loc: 'MEMENTO.md#A1', quote: 'closed population' };
    addFlag(reg, { ...c1Flag('b', 'q'), concept: 'P3 foxes', a: a1, b: null }, 1);
    addFlag(
      reg,
      { ...c1Flag('c', 'q'), concept: 'P3 Foxes', a: { loc: 'R/x.R:1', quote: 'c' } },
      1
    );
    expect(reg.flags).toHaveLength(3);
    resolveFlag(reg, 'F2', 'intended');
    const renames = syncFromSpec(reg, spec('Predation (generalist)'), 2);
    expect(renames).toEqual([['P3 Foxes', 'P3 Predation (generalist)']]);
    expect(Object.keys(reg.concepts).sort()).toEqual(['P2 Voles', 'P3 Predation (generalist)']);
    expect(reg.concepts['P3 Predation (generalist)'].stated?.value).toBe('predator');
    expect(new Set(reg.flags.map((f) => f.concept))).toEqual(
      new Set(['P3 Predation (generalist)'])
    );
    expect(reg.suppressed[0]).toMatch(/^p3 predation \(generalist\)\|/);
    // the intended flag stays suppressed under the new name
    expect(
      addFlagResult(reg, { ...c1Flag('b', 'q'), concept: 'P3 Foxes', a: a1, b: null }, 3)
    ).toEqual({
      flag: null,
      suppressed: true,
    });
    // and FLAGS.md shows the new label
    const state = { ...emptyLedgerState(), register: reg };
    expect(renderFlagsFile(state)).toMatch(/F1 · P3 Predation \(generalist\)/);
    expect(renderFlagsFile(state)).not.toMatch(/Foxes/);
  });
});

describe('review notice digest', () => {
  it('lists new flags with their questions and the open flags raised again', () => {
    const text = reviewNotice(
      [
        { id: 'F7', concept: 'P3 Predation', question: 'Is the Holling II response deliberate?' },
        { id: 'F8', concept: 'P1 Food', question: 'q'.repeat(300) },
      ],
      ['F1', 'F1', 'F2'],
      1,
      1
    );
    expect(text).toMatch(
      /^Supervisor review: 2 new question\(s\), 3 repeat\(s\) of open flags, 1 dropped/
    );
    expect(text).toMatch(/F7 · P3 Predation: Is the Holling II response deliberate\?/);
    expect(text).toMatch(/…and 1 more/);
    expect(text).toMatch(/raised again: F1, F2/);
    expect(reviewNotice([], [], 0)).toBe('Supervisor review: 0 new question(s)');
  });
});

// ---------- runtime ----------

const FIXTURE = join(__dirname, 'fixtures', 'ledger', 'base');

function harness() {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-ledger-fix-'));
  cpSync(FIXTURE, cwd, { recursive: true });
  const branch: any[] = [];
  const pi: any = {
    appendEntry: vi.fn((customType: string, data: unknown) =>
      branch.push({ type: 'custom', customType, data: JSON.parse(JSON.stringify(data)) })
    ),
    sendUserMessage: vi.fn(),
    sendMessage: vi.fn(),
  };
  const ctx: any = { cwd, ui: { notify: vi.fn() }, sessionManager: { getBranch: () => branch } };
  const config: LedgerConfig = { ...defaultConfig(), mode: 'ledger' };
  const rt = new LedgerRuntime(pi);
  const replies: JsonCallResult[] = [];
  rt.callModel = vi.fn(async () =>
    replies.length
      ? replies.shift()!
      : ({ ok: true, json: { flags: [], register_edits: [], restatement: null } } as any)
  );
  rt.load(ctx);
  const turn = async (text = 'Ledger: unchanged') => {
    await rt.onAgentStart(ctx, config);
    branch.push({
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });
    await rt.onSettled(ctx, config);
    await rt.pending;
  };
  return { cwd, pi, ctx, config, rt, replies, turn };
}

const fixtureFlag = (question: string, quote = 'beta * I / N') => ({
  concept: 'P1 transmission',
  type: 1,
  a: { loc: 'R/transmission.R:4', quote },
  b: { loc: 'MEMENTO.md#A2', quote: 'frequency-dependent transmission' },
  argument: 'x',
  question,
});

describe('runtime', () => {
  it('a second review re-raising an open flag adds nothing and says so', async () => {
    const h = harness();
    await h.rt.seedFromSpec(h.ctx, h.config);
    h.replies.push({
      ok: true,
      json: { flags: [fixtureFlag('First?')], register_edits: [], restatement: null },
      model: null,
    } as any);
    await h.rt.review(h.ctx, h.config, 'command');
    h.replies.push({
      ok: true,
      json: {
        flags: [fixtureFlag('Reworded?', 'beta * I'), { ...fixtureFlag('Other?'), same_as: 'F1' }],
        register_edits: [],
        restatement: null,
      },
      model: null,
    } as any);
    await h.rt.review(h.ctx, h.config, 'command');
    const reg = h.rt.state().register;
    expect(reg.flags).toHaveLength(1);
    expect(reg.flags[0].repeats).toBe(2);
    expect(h.rt.state().metrics['review.flags_repeat']).toBe(2);
    const notices = h.ctx.ui.notify.mock.calls.map((c: any[]) => c[0]);
    expect(notices).toContainEqual(
      expect.stringMatching(/1 new question[\s\S]*F1 · P1 Transmission: First\?/)
    );
    expect(notices).toContainEqual(
      expect.stringMatching(/0 new question\(s\), 2 repeat[\s\S]*raised again: F1/)
    );
    // the second prompt carried the open flag and its question
    const prompt = (h.rt.callModel as any).mock.calls[1][1].userPrompt;
    expect(prompt).toMatch(/openFlags[\s\S]*"id": "F1"[\s\S]*"question": "First\?"/);
    expect(readFileSync(join(h.cwd, '.pi', 'FLAGS.md'), 'utf8')).toMatch(/raised again 2×/);
    expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
    rmSync(h.cwd, { recursive: true, force: true });
  });

  it('does not review again on unchanged turns after a review grew the register', async () => {
    const h = harness();
    await h.rt.seedFromSpec(h.ctx, h.config);
    h.rt.state().registerGrewLastReview = true;
    h.rt.state().lastReviewTurn = 0;
    await h.turn();
    await h.turn();
    expect(h.rt.callModel).not.toHaveBeenCalled();
    rmSync(h.cwd, { recursive: true, force: true });
  });

  it('a spec heading rename reaches the register and FLAGS.md and triggers a review', async () => {
    const h = harness();
    await h.rt.seedFromSpec(h.ctx, h.config);
    addFlag(h.rt.state().register, { ...fixtureFlag('q'), concept: 'P3 Demography' }, 0);
    await h.turn();
    expect(h.rt.callModel).not.toHaveBeenCalled();

    const specFile = join(h.cwd, 'MODEL_SPEC.md');
    writeFileSync(
      specFile,
      readFileSync(specFile, 'utf8').replace('## P3 Demography', '## P3 Births and deaths')
    );
    await h.turn();
    const reg = h.rt.state().register;
    expect(reg.concepts['P3 Demography']).toBeUndefined();
    expect(reg.concepts['P3 Births and deaths'].stated?.source).toBe('spec');
    expect(reg.flags[0].concept).toBe('P3 Births and deaths');
    expect(readFileSync(join(h.cwd, '.pi', 'FLAGS.md'), 'utf8')).toMatch(
      /F1 · P3 Births and deaths/
    );
    expect(readFileSync(join(h.cwd, '.pi', 'model-register.md'), 'utf8')).not.toMatch(
      /P3 Demography/
    );
    expect(h.rt.state().metrics['review.register_change']).toBe(1);
    rmSync(h.cwd, { recursive: true, force: true });
  });
});
