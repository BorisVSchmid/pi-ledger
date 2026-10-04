// Flags: dedup, closing, the prompt block, the /flag command and migration
// from pi-supervisor-era sessions. Includes the fixes from the first live run
// (flag flood, review loop, stale concept labels after a spec rename).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addFlag,
  closeFlag,
  closeReason,
  emptyFlags,
  findFlag,
  flagsForPrompt,
  migrateRegister,
  renderFlag,
  sameLocation,
  type FlagInput,
} from '../src/flags.js';
import { reviewNotice } from '../src/reviewer.js';
import { LEDGER_ENTRY_TYPE, LedgerRuntime } from '../src/runtime.js';
import { defaultConfig } from '../src/config.js';
import type { JsonCallResult } from '../src/model-session.js';

// The pair the live run raised twice (F1, F2 in the vole/fox session).
const c1Flag = (quoteA: string, question: string): FlagInput => ({
  concept: 'P2 Voles',
  type: 6,
  a: { loc: 'MEMENTO.md#C1', quote: quoteA },
  b: { loc: 'MEMENTO.md#R1', quote: 'Years 5-10: V 0.9-50' },
  question,
});

describe('flag dedup', () => {
  it('treats the same anchors or nearby lines in the same file as one place', () => {
    expect(sameLocation('MEMENTO.md#C1', 'memento.md#c1')).toBe(true);
    expect(sameLocation('MEMENTO.md#C1', 'MEMENTO.md#C2')).toBe(false);
    expect(sameLocation('R/model.R:40', './R/model.R:42-44')).toBe(true);
    expect(sameLocation('R/model.R:40', 'R/model.R:44')).toBe(false);
    expect(sameLocation('R/model.R:40', 'R/fit.R:40')).toBe(false);
    expect(sameLocation('R/model.R', 'R/model.R')).toBe(true);
    expect(sameLocation('R/model.R', 'R/model.R:3')).toBe(false);
  });

  it('merges a re-raised question into the open flag, also after a spec rename', () => {
    const store = emptyFlags();
    const first = addFlag(store, c1Flag('expected bounded oscillations', 'Is C1 passed?'), 1);
    expect(first.flag?.id).toBe('F1');
    expect(addFlag(store, c1Flag('C1 status: passed for R1', 'Min/max only?'), 2)).toEqual({
      flag: null,
      repeatOf: 'F1',
    });
    // reversed sides, and the concept's spec heading renamed (same P-id)
    const rev = c1Flag('x', 'y');
    [rev.a, rev.b] = [rev.b!, rev.a];
    expect(addFlag(store, { ...rev, concept: 'P2 Bank voles' }, 3).repeatOf).toBe('F1');
    // one side at the same place also counts
    expect(addFlag(store, { ...c1Flag('z', 'q'), b: null }, 4).repeatOf).toBe('F1');
    expect(store.flags).toHaveLength(1);
    expect(store.flags[0]).toMatchObject({ repeats: 3, lastRaisedTurn: 4 });
  });

  it('keeps flags at other places or on other concepts', () => {
    const store = emptyFlags();
    addFlag(store, c1Flag('a', 'q'), 1);
    const elsewhere = { ...c1Flag('a', 'q'), b: { loc: 'MEMENTO.md#A1', quote: 'b' } };
    expect(addFlag(store, elsewhere, 2).flag?.id).toBe('F2');
    expect(addFlag(store, { ...c1Flag('a', 'q'), concept: 'P3 Foxes' }, 2).flag?.id).toBe('F3');
  });

  it('honours the reviewer naming an open flag, but not a closed one', () => {
    const store = emptyFlags();
    addFlag(store, c1Flag('a', 'q'), 1);
    addFlag(store, { ...c1Flag('a', 'q'), concept: 'P3 Foxes' }, 1);
    const elsewhere: FlagInput = {
      concept: 'P1 Food',
      type: 1,
      a: { loc: 'R/model.R:10', quote: 'f' },
      question: 'q',
    };
    expect(addFlag(store, { ...elsewhere, sameAs: 'F2 (repeat)' }, 2).repeatOf).toBe('F2');
    closeFlag(store, findFlag(store, 'F1')!);
    expect(addFlag(store, { ...elsewhere, sameAs: 'F1' }, 3).flag?.id).toBe('F3');
  });

  it('a closed flag suppresses only its exact evidence', () => {
    const store = emptyFlags();
    addFlag(store, c1Flag('a', 'q'), 1);
    closeFlag(store, store.flags[0], 'deliberate');
    expect(addFlag(store, c1Flag('a', 'q2'), 2)).toEqual({ flag: null, suppressed: true });
    expect(addFlag(store, c1Flag('changed evidence', 'q'), 2).flag?.id).toBe('F2');
  });
});

describe('close reasons', () => {
  const store = emptyFlags();
  addFlag(store, c1Flag('a', 'q'), 1);
  addFlag(store, { ...c1Flag('b', 'q'), concept: 'P3 Foxes' }, 1);
  const [f1, f2] = store.flags;
  const reason = (words: string) => closeReason(store, f2, words.split(' ').filter(Boolean));

  it('requires a few words of why; bare verdicts are refused', () => {
    expect(reason('')).toEqual({ error: expect.stringMatching(/^Say why/) });
    expect(reason('intended')).toHaveProperty('error');
    expect(reason('not an')).toHaveProperty('error');
    expect(reason('fixed in fit.R:40')).toEqual({ reason: 'fixed in fit.R:40' });
  });

  it('dup must name another existing flag', () => {
    expect(reason('dup f1')).toEqual({ reason: 'duplicate of F1' });
    expect(reason('dup F1 same C1 range')).toEqual({ reason: 'duplicate of F1: same C1 range' });
    expect(reason('dup')).toHaveProperty('error');
    expect(reason('dup F9')).toHaveProperty('error');
    expect(reason('dup F2')).toHaveProperty('error');
    expect(f1.status).toBe('open');
  });

  it('keeps free text as typed', () => {
    expect(reason('Range is the prior, not data')).toEqual({
      reason: 'Range is the prior, not data',
    });
  });
});

describe('the [Flags] block of the reviewer prompt', () => {
  it('lists open and closed flags with their questions and reasons', () => {
    const store = emptyFlags();
    addFlag(store, c1Flag('a', 'Is C1 passed on the min/max only?'), 1);
    addFlag(store, { ...c1Flag('a', 'Deliberate?'), concept: 'P3 Foxes' }, 1);
    closeFlag(store, store.flags[1], 'yes');
    const block = flagsForPrompt(store);
    expect(block).toMatch(
      /^\[Flags\]\nopen[\s\S]*"question": "Is C1 passed on the min\/max only\?"/
    );
    expect(block).toMatch(/closed[\s\S]*"id": "F2"[\s\S]*"reason": "yes"/);
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
      /^Ledger review: 2 new question\(s\), 3 repeat\(s\) of open flags, 1 dropped/
    );
    expect(text).toMatch(/F7 · P3 Predation: Is the Holling II response deliberate\?/);
    expect(text).toMatch(/…and 1 more/);
    expect(text).toMatch(/raised again: F1, F2/);
    expect(reviewNotice([], [], 0)).toBe('Ledger review: 0 new question(s)');
  });
});

describe('migration from pi-supervisor sessions', () => {
  it('turns intended and dismissed into closed, keeping suppression', () => {
    const base = { argument: '', turn: 1 };
    const store = migrateRegister({
      concepts: { 'P2 Voles': { realizations: [], flags: ['F1'] } },
      flags: [
        { ...c1Flag('a', 'q'), ...base, id: 'F1', status: 'intended' },
        { ...c1Flag('b', 'q'), ...base, id: 'F2', b: null, status: 'open' },
      ],
      nextFlag: 3,
      suppressed: [],
      restatement: { text: 'SIR', turn: 2 },
    });
    expect(store.flags.map((f) => f.status)).toEqual(['closed', 'open']);
    expect(store.nextFlag).toBe(3);
    expect(store.restatement?.text).toBe('SIR');
    expect(addFlag(store, c1Flag('a', 'again'), 3).suppressed).toBe(true);
  });
});

// ---------- runtime ----------

const FIXTURE = join(__dirname, 'fixtures', 'ledger', 'base');

function harness() {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-ledger-flags-'));
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
  const config = defaultConfig();
  const rt = new LedgerRuntime(pi);
  const replies: JsonCallResult[] = [];
  rt.callModel = vi.fn(async () => (replies.length ? replies.shift()! : reply([])));
  rt.load(ctx);
  const turn = async (text = 'Ledger: unchanged', during?: () => void) => {
    await rt.onAgentStart(ctx, config);
    during?.();
    branch.push({
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });
    await rt.onSettled(ctx, config);
    await rt.pending;
  };
  return { cwd, pi, ctx, config, rt, replies, turn, branch };
}

const fixtureFlag = (question: string, quote = 'beta * I / N') => ({
  concept: 'P1 Transmission',
  type: 1,
  a: { loc: 'R/transmission.R:4', quote },
  b: { loc: 'MEMENTO.md#A2', quote: 'frequency-dependent transmission' },
  argument: 'x',
  question,
});

function reply(flags: unknown[]): JsonCallResult {
  return { ok: true, json: { flags, restatement: null }, model: { provider: 'p', modelId: 'm' } };
}

describe('runtime', () => {
  let h: ReturnType<typeof harness>;
  afterEach(() => rmSync(h.cwd, { recursive: true, force: true }));

  it('a second review re-raising an open flag adds nothing and says so', async () => {
    h = harness();
    h.replies.push(reply([fixtureFlag('First?')]));
    await h.rt.review(h.ctx, h.config, 'command');
    h.replies.push(
      reply([fixtureFlag('Reworded?', 'beta * I'), { ...fixtureFlag('Other?'), same_as: 'F1' }])
    );
    await h.rt.review(h.ctx, h.config, 'command');
    const flags = h.rt.state().flags.flags;
    expect(flags).toHaveLength(1);
    expect(flags[0].repeats).toBe(2);
    const notices = h.ctx.ui.notify.mock.calls.map((c: any[]) => c[0]);
    expect(notices).toContainEqual(
      expect.stringMatching(/1 new question[\s\S]*F1 · P1 Transmission: First\?/)
    );
    expect(notices).toContainEqual(
      expect.stringMatching(/0 new question\(s\), 2 repeat[\s\S]*raised again: F1/)
    );
    // the second prompt carried the open flag, and the spec read fresh
    const prompt = (h.rt.callModel as any).mock.calls[1][1].userPrompt;
    expect(prompt).toMatch(/\[Flags\]\nopen[\s\S]*"id": "F1"[\s\S]*"question": "First\?"/);
    expect(prompt).toMatch(/\[Model Spec\]\n[\s\S]*## P1 Transmission/);
    expect(readFileSync(join(h.cwd, '.pi', 'FLAGS.md'), 'utf8')).toMatch(/raised again 2×/);
    expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it('reviews only on turns that edit a model or spec file', async () => {
    h = harness();
    await h.turn();
    await h.turn();
    expect(h.rt.callModel).not.toHaveBeenCalled();

    const specFile = join(h.cwd, 'MODEL_SPEC.md');
    writeFileSync(
      specFile,
      readFileSync(specFile, 'utf8').replace('## P3 Demography', '## P3 Births and deaths')
    );
    await h.turn();
    expect(h.rt.state().metrics['review.edit']).toBe(1);

    const fit = join(h.cwd, 'R', 'fit.R');
    await h.turn('Ledger: unchanged', () =>
      writeFileSync(fit, readFileSync(fit, 'utf8') + '\n# x\n')
    );
    expect(h.rt.state().metrics['review.edit']).toBe(2);
    await h.turn();
    expect(h.rt.callModel).toHaveBeenCalledTimes(2);
  });

  it('/flag lists, closes and sends; only send steers; state survives a reload', async () => {
    h = harness();
    const second = { ...fixtureFlag('Second?'), concept: 'P2 External', b: null };
    h.replies.push(reply([fixtureFlag('First?'), second]));
    await h.rt.review(h.ctx, h.config, 'command');
    expect(await h.rt.flagCommand('', h.ctx)).toMatch(/F1[\s\S]*F2/);
    expect(await h.rt.flagCommand('F2 dismiss', h.ctx)).toMatch(/^Usage/);
    expect(await h.rt.flagCommand('F2 close', h.ctx)).toMatch(/F2 not closed. Say why/);
    expect(await h.rt.flagCommand('F2 close intended', h.ctx)).toMatch(/not closed/);
    expect(h.rt.state().flags.flags[1].status).toBe('open');
    expect(await h.rt.flagCommand('F2 close external forcing is deliberate', h.ctx)).toMatch(
      /F2 closed \(external forcing/
    );
    expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
    expect(await h.rt.flagCommand('F1 send', h.ctx)).toMatch(/sent/);
    expect(h.pi.sendUserMessage.mock.calls[0][0]).toMatch(/^Ledger check: possible inconsistency/);
    expect(await h.rt.flagCommand('F9 send', h.ctx)).toMatch(/No flag F9/);
    expect(await h.rt.flagCommand('F1 bogus', h.ctx)).toMatch(/^Usage/);
    expect(readFileSync(join(h.cwd, '.pi', 'FLAGS.md'), 'utf8')).toMatch(/Open questions \(0\)/);
    expect(h.rt.metricsText()).toMatch(/sent 1, closed 1/);
    expect(await h.rt.flagCommand('F1 close fixed in fit.R', h.ctx)).toMatch(/closed/);

    const rt2 = new LedgerRuntime(h.pi);
    rt2.load(h.ctx);
    expect(rt2.state().flags.flags.map((f) => f.status)).toEqual(['closed', 'closed']);
    expect(rt2.state().flags.flags.map((f) => f.reason)).toEqual([
      'fixed in fit.R',
      'external forcing is deliberate',
    ]);
  });

  it('loads a pi-supervisor-era state with a register', () => {
    h = harness();
    h.branch.push({
      type: 'custom',
      customType: LEDGER_ENTRY_TYPE,
      data: {
        version: 1,
        turn: 7,
        register: {
          concepts: {},
          flags: [{ ...fixtureFlag('q'), id: 'F1', status: 'dismissed', turn: 1 }],
          nextFlag: 2,
          suppressed: [],
        },
        registerGrewLastReview: true,
      },
    });
    const rt = new LedgerRuntime(h.pi);
    rt.load(h.ctx);
    expect(rt.state()).toMatchObject({ version: 2, turn: 7, lastTurnFindings: [] });
    expect(rt.state().flags.flags[0].status).toBe('closed');
    expect('register' in rt.state()).toBe(false);
  });

  it('asks for a reason when none is given, and a cancel closes nothing', async () => {
    h = harness();
    h.replies.push(reply([fixtureFlag('First?')]));
    await h.rt.review(h.ctx, h.config, 'command');
    h.ctx.hasUI = true;
    h.ctx.ui.input = vi.fn(async () => undefined);
    expect(await h.rt.flagCommand('F1 close', h.ctx)).toMatch(/not closed/);
    expect(h.rt.state().flags.flags[0].status).toBe('open');
    h.ctx.ui.input = vi.fn(async () => ' fixed  in fit.R ');
    expect(await h.rt.flagCommand('F1 close', h.ctx)).toMatch(/closed \(fixed in fit\.R\)/);
    expect(h.ctx.ui.input.mock.calls[0][0]).toMatch(/^Why close F1\? \(First\?\)/);
  });

  it('adds a labelled model interpretation to a terse reason, kept apart from it', async () => {
    h = harness();
    h.replies.push(reply([fixtureFlag('First?'), { ...fixtureFlag('Second?'), concept: 'P2 X' }]));
    await h.rt.review(h.ctx, h.config, 'command');
    const said = 'Frequency dependence is the deliberate choice for this host.';
    h.replies.push({ ok: true, json: { interpretation: said }, model: null } as never);
    await h.rt.flagCommand('F1 close chosen on purpose', h.ctx, h.config);
    await h.rt.pendingInterpretation;
    const [f1, f2] = h.rt.state().flags.flags;
    expect(f1).toMatchObject({ reason: 'chosen on purpose', interpretation: said });
    const call = (h.rt.callModel as any).mock.calls.at(-1)[1];
    expect(call.systemPrompt).toMatch(/one sentence/);
    expect(call.userPrompt).toMatch(/\[Human's reason for closing\]\nchosen on purpose/);
    expect(renderFlag(f1).join('\n')).toMatch(
      /Your note: chosen on purpose\n {2}\(interpretation: Freq/
    );
    expect(flagsForPrompt(h.rt.state().flags)).toMatch(
      /"reason": "chosen on purpose",\n {2}"interpretation_by_model": "Freq/
    );
    expect(h.ctx.ui.notify.mock.calls.at(-1)[0]).toMatch(/^F1 \(interpretation: Freq/);

    // Re-closing replaces the reason and drops the old interpretation.
    h.replies.push({ ok: false, error: 'boom', model: null } as never);
    await h.rt.flagCommand('F1 close not a real difference', h.ctx, h.config);
    await h.rt.pendingInterpretation;
    expect(f1.reason).toBe('not a real difference');
    expect(f1.interpretation).toBeUndefined();

    // A long reason speaks for itself: no model call.
    const calls = (h.rt.callModel as any).mock.calls.length;
    const long = 'the range is the prior from the 2019 trapping data and not a fitted value at all';
    await h.rt.flagCommand(`F2 close ${long}`, h.ctx, h.config);
    expect(h.rt.pendingInterpretation).toBeNull();
    expect((h.rt.callModel as any).mock.calls.length).toBe(calls);
    expect(f2.reason).toBe(long);
  });

  it('loads flags closed earlier without a reason', () => {
    h = harness();
    const old = new LedgerRuntime(h.pi);
    old.load(h.ctx);
    addFlag(old.state().flags, fixtureFlag('q'), 1);
    closeFlag(old.state().flags, old.state().flags.flags[0]);
    old.persist();
    const rt = new LedgerRuntime(h.pi);
    rt.load(h.ctx);
    const [f] = rt.state().flags.flags;
    expect(f).toMatchObject({ status: 'closed' });
    expect(f.reason).toBeUndefined();
    expect(renderFlag(f).join('\n')).not.toMatch(/Your note/);
    expect(flagsForPrompt(rt.state().flags)).toMatch(/closed[\s\S]*"id": "F1"/);
  });
});
