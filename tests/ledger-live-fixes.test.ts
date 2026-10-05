// Fixes from the second live run (2026-10-04): a spurious "edit" review,
// stale open flags, ledger growth and AC status lines outside Acceptance.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerRuntime } from '../src/runtime.js';
import { defaultConfig } from '../src/config.js';
import { acceptanceSummary, statusDetail, statusLine } from '../src/monitor.js';
import type { JsonCallResult } from '../src/model-session.js';

const FIXTURE = join(__dirname, 'fixtures', 'ledger', 'base');

function harness() {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-ledger-live-'));
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
  const say = (text: string) =>
    branch.push({
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });
  /** One observed agent run: before_agent_start, work, agent_settled. */
  const turn = async (text = 'Ledger: unchanged', during?: () => void | Promise<void>) => {
    await rt.onAgentStart(ctx, config);
    await during?.();
    say(text);
    await rt.onSettled(ctx, config);
    await rt.pending;
  };
  const file = (rel: string) => join(cwd, rel);
  const edit = (rel: string, f: (s: string) => string) =>
    writeFileSync(file(rel), f(readFileSync(file(rel), 'utf8')));
  const notices = () => ctx.ui.notify.mock.calls.map((c: any[]) => String(c[0]));
  return { cwd, pi, ctx, config, rt, replies, turn, file, edit, notices, say };
}

function reply(flags: unknown[], extra: Record<string, unknown> = {}): JsonCallResult {
  return {
    ok: true,
    json: { flags, restatement: null, ...extra },
    model: { provider: 'p', modelId: 'm' },
  };
}

const nextFlag = {
  concept: 'P1 Transmission',
  type: 5,
  a: { loc: 'LEDGER.md#Next', quote: 'fit the model to 2015-2018' },
  b: { loc: 'R/transmission.R:4', quote: 'beta * I / N' },
  argument: 'x',
  question: 'Does the planned fit use the frequency-dependent term?',
};

describe('spurious edit review', () => {
  let h: ReturnType<typeof harness>;
  afterEach(() => rmSync(h.cwd, { recursive: true, force: true }));

  it('a /flag send turn that changes only the ledger starts no review', async () => {
    h = harness();
    h.replies.push(reply([nextFlag]));
    await h.turn('Ledger: unchanged', () => h.edit('R/fit.R', (s) => s + '\n# tweak\n'));
    expect(h.rt.state().metrics['review.edit']).toBe(1);

    expect(await h.rt.flagCommand('F1 send', h.ctx)).toMatch(/sent/);
    // Pi runs the sent flag as a new prompt, so before_agent_start fires again.
    await h.turn('Ledger: D2 added', () =>
      h.edit('LEDGER.md', (s) =>
        s.replace('## Decisions\n', '## Decisions\n- D2: fit uses beta * I / N\n')
      )
    );
    expect(h.rt.state().metrics['review.edit']).toBe(1);
    expect(h.rt.callModel).toHaveBeenCalledTimes(1);
  });

  it('a prompt that never ran leaves no stale baseline behind', async () => {
    h = harness();
    // before_agent_start fired, but the run failed before it started: no agent_settled.
    await h.rt.onAgentStart(h.ctx, h.config);
    // The human edits a model file between runs.
    h.edit('R/fit.R', (s) => s + '\n# human edit\n');
    await h.turn('Ledger: D2 added', () =>
      h.edit('LEDGER.md', (s) => s.replace('## Decisions\n', '## Decisions\n- D2: x\n'))
    );
    expect(h.rt.state().metrics['review.edit']).toBeUndefined();
    expect(h.rt.callModel).not.toHaveBeenCalled();
  });

  it('skips the edit review when the model is what the last review already saw', async () => {
    h = harness();
    // /review runs while the agent is still working (commands run during streaming).
    await h.turn('Ledger: unchanged', async () => {
      h.edit('R/fit.R', (s) => s + '\n# tweak\n');
      await h.rt.review(h.ctx, h.config, 'command');
    });
    expect(h.rt.state().metrics['review.command']).toBe(1);
    expect(h.rt.state().metrics['review.edit']).toBeUndefined();
    expect(h.rt.state().metrics['review.skipped_seen']).toBe(1);
  });

  it('names the changed files when an edit starts a review', async () => {
    h = harness();
    await h.turn('Ledger: unchanged', () => h.edit('R/fit.R', (s) => s + '\n# tweak\n'));
    expect(h.notices()).toContain('Ledger: reviewing the model (edit: R/fit.R)…');
  });
});

describe('stale open flags', () => {
  let h: ReturnType<typeof harness>;
  afterEach(() => rmSync(h.cwd, { recursive: true, force: true }));

  it('marks a flag whose quote is gone, never closes it, and lists it after the next review', async () => {
    h = harness();
    h.replies.push(reply([nextFlag]));
    await h.rt.review(h.ctx, h.config, 'command');
    expect(h.rt.state().flags.flags[0].status).toBe('open');

    // The Next item is replaced; the flag's quote no longer exists.
    await h.turn('Ledger: Next updated', () =>
      h.edit('LEDGER.md', (s) => s.replace('fit the model to 2015-2018', 'compare R4 with R5'))
    );
    const f = h.rt.state().flags.flags[0];
    expect(f.status).toBe('open');
    expect(f.evidenceGone).toEqual(['LEDGER.md#Next']);
    expect(await h.rt.flagCommand('', h.ctx)).toMatch(
      /F1 · P1 Transmission .* open · evidence gone/
    );
    const flagsMd = readFileSync(h.file('.pi/FLAGS.md'), 'utf8');
    expect(flagsMd).toMatch(/evidence gone/);
    expect(flagsMd).toMatch(/Evidence gone: `LEDGER.md#Next` no longer contains the quote/);

    await h.rt.review(h.ctx, h.config, 'command');
    expect(h.notices().at(-1)).toMatch(/Possibly stale[\s\S]*F1 · evidence gone/);
    expect(h.rt.state().flags.flags[0].status).toBe('open');
  });

  it('clears the mark when the quote comes back, and finds a code quote that only moved', async () => {
    h = harness();
    h.replies.push(reply([nextFlag]));
    await h.rt.review(h.ctx, h.config, 'command');
    // Lines inserted above the code quote: it moved, it is not gone.
    await h.turn('Ledger: unchanged', () =>
      h.edit('R/transmission.R', (s) => '# a\n# b\n# c\n# d\n# e\n# f\n# g\n# h\n' + s)
    );
    expect(h.rt.state().flags.flags[0].evidenceGone).toBeUndefined();

    h.edit('LEDGER.md', (s) => s.replace('fit the model to 2015-2018', 'something else'));
    await h.turn('Ledger: Next updated');
    expect(h.rt.state().flags.flags[0].evidenceGone).toEqual(['LEDGER.md#Next']);
    h.edit('LEDGER.md', (s) => s.replace('something else', 'fit the model to 2015-2018'));
    await h.turn('Ledger: Next restored');
    expect(h.rt.state().flags.flags[0].evidenceGone).toBeUndefined();
  });

  it('records a ledger entry the reviewer says answers an open flag, only if its quote verifies', async () => {
    h = harness();
    h.replies.push(reply([nextFlag]));
    await h.rt.review(h.ctx, h.config, 'command');
    h.edit('LEDGER.md', (s) =>
      s.replace('## Decisions\n', '## Decisions\n- D2: the fit uses frequency-dependent contact\n')
    );
    h.replies.push(
      reply([], {
        answered: [
          { id: 'F1', loc: 'LEDGER.md#D2', quote: 'the fit uses frequency-dependent contact' },
          { id: 'F1', loc: 'LEDGER.md#D9', quote: 'an invented decision text' },
          { id: 'F7', loc: 'LEDGER.md#D2', quote: 'the fit uses frequency-dependent contact' },
        ],
      })
    );
    await h.rt.review(h.ctx, h.config, 'command');
    const f = h.rt.state().flags.flags[0];
    expect(f.status).toBe('open');
    expect(f.answeredBy).toEqual({
      loc: 'LEDGER.md#D2',
      quote: 'the fit uses frequency-dependent contact',
    });
    expect(h.notices().at(-1)).toMatch(/F1 · possibly answered by LEDGER.md#D2/);
    expect(readFileSync(h.file('.pi/FLAGS.md'), 'utf8')).toMatch(
      /Possibly answered by `LEDGER.md#D2`/
    );
    const prompt = (h.rt.callModel as any).mock.calls[1][1];
    expect(prompt.systemPrompt).toMatch(/"answered"/);
  });
});

describe('ledger growth and AC status placement', () => {
  it('shows the word count, and says what to condense when over the target', () => {
    const short = '# Q\n\n## Acceptance (locked)\n- AC1: x\n';
    expect(statusDetail(short)).toMatch(/^Ledger: \d+ words\.$/m);
    const long = short + '\n## Observed\n' + '- O1: word '.repeat(800) + '\n';
    expect(statusDetail(long)).toMatch(
      /Ledger: 2,4\d\d words, over the ~2,000-word target\. Condense Observed and Crossed out/
    );
  });

  it('counts an AC status line written under Checks', () => {
    const md = [
      '## Acceptance (locked)',
      '- AC1: peak within a month',
      '## Checks (locked, written before the run)',
      '- C1: R16 should peak in July',
      '- AC1 status: failed (R16)',
    ].join('\n');
    expect(acceptanceSummary(md).items[0]).toMatchObject({ status: 'failed', run: 'R16' });
    expect(
      statusLine({
        ledgerText: md,
        ledgerName: 'LEDGER.md',
        state: { turn: 1, lastTurnFindings: [], flags: { flags: [] } },
      })
    ).toMatch(/^Acceptance 0\/1 passed, 1 failed/);
  });
});

// Third live run (2026-10-05): after Boris swapped in a new ledger and spec
// between turns, the agent described the old spec from memory.
describe('ledger or spec edited between turns', () => {
  let h: ReturnType<typeof harness>;
  afterEach(() => rmSync(h.cwd, { recursive: true, force: true }));

  it('tells the agent which sections changed, once', async () => {
    h = harness();
    expect(await h.rt.onAgentStart(h.ctx, h.config)).toBeNull(); // first run: no baseline yet
    h.say('Ledger: unchanged');
    await h.rt.onSettled(h.ctx, h.config);
    await h.rt.pending;

    h.edit('LEDGER.md', (s) => s.replace(/## Next[\s\S]*$/, '## Next\n- fit R7\n'));
    h.edit('MODEL_SPEC.md', (s) => s + '\n## P5 Calving\n- births pulse in April\n');
    const note = await h.rt.onAgentStart(h.ctx, h.config);
    expect(note).toMatch(/not by you/);
    expect(note).toMatch(/LEDGER\.md \(Next\)/);
    expect(note).toMatch(/MODEL_SPEC\.md \(P5 Calving\)/);
    expect(note).not.toMatch(/R\/fit\.R/);
    h.say('Ledger: unchanged');
    await h.rt.onSettled(h.ctx, h.config);
    await h.rt.pending;
    // The edit happened before the run, so it is not this run's unclaimed change.
    expect(h.rt.state().lastTurnFindings).not.toContain('LEDGER_CHANGED_UNCLAIMED');

    expect(await h.rt.onAgentStart(h.ctx, h.config)).toBeNull();
    expect(h.rt.state().metrics.outside_edit).toBe(1);
  });

  it('names model files edited between turns', async () => {
    h = harness();
    await h.turn();
    h.edit('R/fit.R', (s) => s + '\n# swapped in by hand\n');
    expect(await h.rt.onAgentStart(h.ctx, h.config)).toMatch(/- R\/fit\.R/);
  });

  it("after an interrupted turn, says the changes may be the agent's own", async () => {
    h = harness();
    await h.turn();
    await h.rt.onAgentStart(h.ctx, h.config);
    // The run is killed mid-turn: no agent_settled, and the extension reloads.
    h.edit('LEDGER.md', (s) => s + '- C9: written just before the kill\n');
    h.rt.load(h.ctx);
    const note = await h.rt.onAgentStart(h.ctx, h.config);
    expect(note).toMatch(/interrupted, so some of the changes may be your own/);
    expect(note).not.toMatch(/not by you/);
  });

  it('says nothing when only the agent edited the ledger', async () => {
    h = harness();
    await h.turn('Ledger: Next — added R7', () => h.edit('LEDGER.md', (s) => s + '- fit R7\n'));
    expect(await h.rt.onAgentStart(h.ctx, h.config)).toBeNull();
  });
});
