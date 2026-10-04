import { beforeEach, describe, expect, it, vi } from 'vitest';

const behaviour: Record<string, { start: boolean; replies: Array<string | null> }> = {};
const started: string[] = [];
const disposed: string[] = [];

vi.mock('../src/ledger/model-session.js', () => ({
  ModelSession: class {
    private key = '';
    async ensureStarted(
      _ctx: unknown,
      provider: string,
      modelId: string,
      _sp: string,
      thinking?: string
    ) {
      this.key = `${provider}/${modelId}`;
      started.push(`${this.key}:${thinking ?? 'none'}`);
      return behaviour[this.key]?.start ?? false;
    }
    async prompt() {
      return behaviour[this.key]?.replies.shift() ?? null;
    }
    dispose() {
      disposed.push(this.key);
    }
  },
}));

import { callJson, parseModelRef } from '../src/ledger/model-call.js';

const ctx: any = { model: undefined, signal: undefined };
const opts = {
  model: 'anthropic/claude-x',
  fallbackModel: 'zai/glm-5.3',
  thinking: 'high',
  systemPrompt: 's',
  userPrompt: 'u',
};

describe('callJson', () => {
  beforeEach(() => {
    for (const k of Object.keys(behaviour)) delete behaviour[k];
    started.length = 0;
    disposed.length = 0;
  });

  it('parses provider/model refs with slashes in the id', () => {
    expect(parseModelRef('openrouter/meta/llama')).toEqual({
      provider: 'openrouter',
      modelId: 'meta/llama',
    });
    expect(parseModelRef('nope')).toBeNull();
  });

  it('uses a fresh session with the configured thinking level and disposes it', async () => {
    behaviour['anthropic/claude-x'] = { start: true, replies: ['{"flags":[]}'] };
    const r = await callJson(ctx, opts);
    expect(r).toMatchObject({ ok: true, json: { flags: [] } });
    expect(started).toEqual(['anthropic/claude-x:high']);
    expect(disposed).toEqual(['anthropic/claude-x']);
  });

  it('falls back when the primary model is unavailable or fails', async () => {
    behaviour['zai/glm-5.3'] = { start: true, replies: ['{"ok":1}'] };
    expect(await callJson(ctx, opts)).toMatchObject({ ok: true, model: { provider: 'zai' } });
    behaviour['anthropic/claude-x'] = { start: true, replies: [null] };
    behaviour['zai/glm-5.3'] = { start: true, replies: ['{"ok":2}'] };
    expect(await callJson(ctx, opts)).toMatchObject({ ok: true, json: { ok: 2 } });
  });

  it('retries once on invalid JSON, then fails open without the fallback', async () => {
    behaviour['anthropic/claude-x'] = { start: true, replies: ['not json', '{"a":1}'] };
    expect(await callJson(ctx, opts)).toMatchObject({ ok: true, json: { a: 1 } });
    behaviour['anthropic/claude-x'] = { start: true, replies: ['bad', 'still bad'] };
    behaviour['zai/glm-5.3'] = { start: true, replies: ['{"a":2}'] };
    expect(await callJson(ctx, opts)).toMatchObject({ ok: false, error: 'invalid JSON' });
  });
});
