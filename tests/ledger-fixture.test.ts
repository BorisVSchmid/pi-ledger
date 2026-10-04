import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerRuntime, COMPACTION_NOTE_TYPE } from '../src/runtime.js';
import { defaultConfig, type LedgerConfig } from '../src/config.js';
import { buildModelFilesBlock } from '../src/reviewer.js';
import { closeFlag } from '../src/flags.js';
import { parseJsonObject, type JsonCallResult } from '../src/model-session.js';

const FIXTURE = join(__dirname, 'fixtures', 'ledger');
const VARIANTS = [
  '1-density-copy',
  '2-hazard-and-compartment',
  '3-weekly-rate',
  '4-immigration-closed',
  '5-double-seasonality',
  '6-fit-claim',
  '7-claimed-no-change',
  '8-checks-edited',
  '9-injection',
];

function harness() {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-ledger-fx-'));
  cpSync(join(FIXTURE, 'base'), cwd, { recursive: true });
  const branch: any[] = [];
  const pi: any = {
    appendEntry: vi.fn((customType: string, data: unknown) =>
      branch.push({ type: 'custom', customType, data: JSON.parse(JSON.stringify(data)) })
    ),
    sendUserMessage: vi.fn(),
    sendMessage: vi.fn(),
  };
  const ctx: any = {
    cwd,
    ui: { notify: vi.fn() },
    sessionManager: { getBranch: () => branch },
  };
  const config: LedgerConfig = defaultConfig();
  const rt = new LedgerRuntime(pi);
  const replies: JsonCallResult[] = [];
  rt.callModel = vi.fn(async () =>
    replies.length
      ? replies.shift()!
      : ({ ok: true, json: { flags: [], restatement: null } } as any)
  );
  rt.load(ctx);
  const reply = (text: string) =>
    branch.push({
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });
  return { cwd, branch, pi, ctx, config, rt, replies, reply };
}

/** Apply a variant as if the agent made its edits during one turn. */
async function runVariant(variant: string) {
  const h = harness();
  await h.rt.onAgentStart(h.ctx, h.config);
  const dir = join(FIXTURE, 'variants', variant);
  cpSync(dir, h.cwd, { recursive: true, filter: (src) => !src.endsWith('reply.md') });
  const replyFile = join(dir, 'reply.md');
  const memChanged = existsSync(join(dir, 'LEDGER.md'));
  h.reply(
    existsSync(replyFile)
      ? readFileSync(replyFile, 'utf8')
      : memChanged
        ? 'Ledger: C1 — widened the range'
        : 'Ledger: unchanged'
  );
  await h.rt.onSettled(h.ctx, h.config);
  await h.rt.pending;
  const findings = Object.keys(h.rt.state().metrics)
    .filter((k) => k.startsWith('finding.'))
    .map((k) => k.slice('finding.'.length))
    .sort();
  return { ...h, findings };
}

describe('monitor on the seeded fixture', () => {
  it('base turn produces no findings', async () => {
    const h = harness();
    await h.rt.onAgentStart(h.ctx, h.config);
    h.reply('Ledger: unchanged');
    await h.rt.onSettled(h.ctx, h.config);
    expect(Object.keys(h.rt.state().metrics).filter((k) => k.startsWith('finding.'))).toEqual([]);
    rmSync(h.cwd, { recursive: true, force: true });
  });

  const expected: Record<string, string[]> = {
    '7-claimed-no-change': ['LEDGER_CLAIMED_NO_CHANGE'],
    '8-checks-edited': ['LOCKED_SECTION_EDITED'],
    // 9-injection: text addressed to the supervisor is left to the reviewer (type 0).
  };

  for (const v of VARIANTS) {
    it(`variant ${v}: ${expected[v] ? expected[v].join(', ') : 'no monitor finding'}`, async () => {
      const r = await runVariant(v);
      expect(r.findings).toEqual(expected[v] ?? []);
      const steered = r.pi.sendUserMessage.mock.calls.length;
      expect(steered).toBe(v === '7-claimed-no-change' ? 1 : 0);
      rmSync(r.cwd, { recursive: true, force: true });
    });
  }
});

describe('reviewer verification on variant 1 (density-dependent copy)', () => {
  let h: Awaited<ReturnType<typeof runVariant>>;
  beforeEach(async () => {
    h = await runVariant('1-density-copy');
  });
  afterEach(() => rmSync(h.cwd, { recursive: true, force: true }));

  const realFlag = {
    concept: 'P1 transmission',
    type: 1,
    a: { loc: 'R/transmission.R:4', quote: 'beta * I / N' },
    b: { loc: 'R/region.R:3', quote: 'beta * I' },
    argument: 'One divides by N, the other does not.',
    question: 'Is regional transmission meant to be density-dependent?',
  };
  const inventedFlag = {
    ...realFlag,
    b: { loc: 'R/region.R:3', quote: 'beta * S * I * contact_density' },
  };
  const wrongLine = { ...realFlag, b: { loc: 'R/region.R:40', quote: 'beta * I' } };

  it('keeps verified flags, drops invented quotes and lines, and records the restatement', async () => {
    h.replies.push({
      ok: true,
      json: {
        flags: [realFlag, inventedFlag, wrongLine],
        restatement: 'SEIR herd model with frequency-dependent transmission.',
      },
      model: { provider: 'p', modelId: 'm' },
    });
    await h.rt.review(h.ctx, h.config, 'command');
    const store = h.rt.state().flags;
    expect(store.flags).toHaveLength(1);
    expect(store.flags[0]).toMatchObject({ id: 'F1', status: 'open' });
    expect(h.rt.state().metrics['review.flags_dropped_unverified']).toBe(2);
    expect(store.restatement?.text).toMatch(/SEIR/);
    expect(readFileSync(join(h.cwd, '.pi', 'FLAGS.md'), 'utf8')).toMatch(/Open questions \(1\)/);
    // flags never steer on their own
    expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it('creates a flag once and suppresses it after closing, even when lines move', async () => {
    const out = { ok: true, json: { flags: [realFlag] }, model: null } as any;
    h.replies.push(out, out);
    await h.rt.review(h.ctx, h.config, 'command');
    await h.rt.review(h.ctx, h.config, 'command');
    expect(h.rt.state().flags.flags).toHaveLength(1);
    closeFlag(h.rt.state().flags, h.rt.state().flags.flags[0], 'deliberate');
    writeFileSync(
      join(h.cwd, 'R', 'region.R'),
      '# moved down\n\n' + readFileSync(join(h.cwd, 'R', 'region.R'), 'utf8')
    );
    // reversed sides, and the region.R line has moved from 3 to 5
    const moved = {
      ...realFlag,
      a: { loc: 'R/region.R:5', quote: 'beta * I' },
      b: { loc: 'R/transmission.R:4', quote: 'beta * I / N' },
    };
    h.replies.push({ ok: true, json: { flags: [moved] }, model: null } as any);
    const droppedBefore = h.rt.state().metrics['review.flags_dropped_unverified'] ?? 0;
    await h.rt.review(h.ctx, h.config, 'command');
    // it verified (not dropped) and was still not raised again
    expect(h.rt.state().metrics['review.flags_dropped_unverified'] ?? 0).toBe(droppedBefore);
    expect(h.rt.state().flags.flags).toHaveLength(1);
  });

  it('fails open on an unusable model reply', async () => {
    h.replies.push({ ok: false, error: 'invalid JSON', model: null });
    await h.rt.review(h.ctx, h.config, 'command');
    expect(h.rt.state().metrics['review.failed']).toBe(1);
    expect(h.rt.state().flags.flags).toHaveLength(0);
  });

  it('sends [Model Edits] since the last review with real line numbers', async () => {
    await h.rt.review(h.ctx, h.config, 'command');
    writeFileSync(
      join(h.cwd, 'R', 'region.R'),
      'regional_foi <- function(beta, I, N) beta * I / N\n'
    );
    await h.rt.review(h.ctx, h.config, 'command');
    const calls = (h.rt.callModel as any).mock.calls;
    const prompt: string = calls[calls.length - 1][1].userPrompt;
    expect(prompt).toMatch(/### R\/region\.R {2}\(new lines 1-2; old 1-5\)/);
    expect(prompt).toMatch(/=== R\/transmission\.R\n1\| # Force of infection/);
    expect(prompt).toMatch(/\[Agent Summary\]\n\(The working agent's own description/);
  });
});

describe('compaction note', () => {
  it('adds a note only for verified differences, leaving the summary alone', async () => {
    const h = harness();
    const summary =
      'Goal: explain July peak. Earlier we established that transmission is density-dependent across herds. Next: fit 2015-2018.';
    h.replies.push({
      ok: true,
      json: {
        differs: [
          {
            summary_quote: 'transmission is density-dependent across herds',
            ref: 'LEDGER.md#X1',
            ledger_quote: 'X1: transmission is density-dependent',
            note: 'crossed out: refuted by R2',
          },
          {
            summary_quote: 'the model uses weekly steps',
            ref: 'LEDGER.md#A1',
            ledger_quote: 'closed population',
            note: 'invented',
          },
        ],
      },
      model: null,
    } as any);
    await h.rt.compactionNote(h.ctx, h.config, summary);
    expect(h.pi.sendMessage).toHaveBeenCalledTimes(1);
    const msg = h.pi.sendMessage.mock.calls[0][0];
    expect(msg.customType).toBe(COMPACTION_NOTE_TYPE);
    expect(msg.content).toMatch(/"transmission is density-dependent across herds"/);
    expect(msg.content).not.toMatch(/weekly/);
    // the ledger is not presented as authoritative: it may be behind
    expect(msg.content).toMatch(/differ from the ledger; check which is current/);
    expect(msg.content).not.toMatch(/stale/);
    expect(h.rt.state().metrics['compaction_note.dropped_unverified']).toBe(1);
    // nothing reaches the agent in the user's voice
    expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
    rmSync(h.cwd, { recursive: true, force: true });
  });

  it('adds nothing when no item verifies (older prompts answer under "stale")', async () => {
    const h = harness();
    h.replies.push({ ok: true, json: { stale: [] }, model: null } as any);
    await h.rt.compactionNote(h.ctx, h.config, 'summary text');
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
    rmSync(h.cwd, { recursive: true, force: true });
  });
});

describe('reviewer input helpers', () => {
  it('numbers lines and truncates the largest files last', () => {
    const block = buildModelFilesBlock({ 'a.R': 'x\ny', 'big.R': 'z\n'.repeat(500) }, 300);
    expect(block).toMatch(/=== a\.R\n1\| x\n2\| y/);
    expect(block).toMatch(/NOTE: truncated or omitted to fit 300 chars: big\.R/);
  });

  it('parses JSON with fences or prose around it', () => {
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonObject('Here: {"a":2} done')).toEqual({ a: 2 });
    expect(parseJsonObject('no json')).toBeUndefined();
  });
});
