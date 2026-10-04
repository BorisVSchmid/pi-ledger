import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/core/analyzer.js', () => ({ analyze: vi.fn() }));
vi.mock('../src/core/inference.js', () => ({ inferOutcome: vi.fn() }));
vi.mock('../src/ui/renderer.js', () => ({ updateUI: vi.fn(), toggleWidget: vi.fn() }));
vi.mock('../src/ui/model-picker.js', () => ({ pickModel: vi.fn() }));
vi.mock('../src/session/client.js', () => ({ disposeSession: vi.fn() }));
vi.mock('../src/subagent-detector.js', () => ({
  checkChildPiProcesses: vi.fn().mockResolvedValue({ hasActiveSubagents: false, count: 0 }),
  waitForSubagents: vi.fn(),
}));
vi.mock('../src/state/mid-run-signals.js', () => ({
  detectMidRunSignals: vi.fn().mockReturnValue({ type: 'tool_error' }),
}));

import piSupervisor from '../src/index.js';
import { analyze } from '../src/core/analyzer.js';

type Handler = (event: any, ctx: any) => Promise<unknown> | unknown;

function setup(mode: 'ledger' | 'goal') {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-ledger-switch-'));
  mkdirSync(join(cwd, '.pi'));
  writeFileSync(join(cwd, '.pi', 'supervisor-config.json'), JSON.stringify({ mode }));
  writeFileSync(join(cwd, 'MEMENTO.md'), '# Q\n## Next\n- fit\n');
  // A goal-supervision state left active in the session (e.g. from goal mode).
  const branch: any[] = [
    {
      type: 'custom',
      customType: 'supervisor-state',
      data: {
        active: true,
        outcome: 'finish the fit',
        provider: 'p',
        modelId: 'm',
        interventions: [
          { message: 'focus on the fit', reasoning: '', timestamp: 0 },
          { message: 'focus on the fit now', reasoning: '', timestamp: 1 },
        ],
        startedAt: 0,
        reframeTier: 0,
      },
    },
    {
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Ledger: unchanged' }] },
    },
  ];
  const handlers: Record<string, Handler[]> = {};
  const commands: Record<string, any> = {};
  let tool: any;
  const api: any = {
    on: vi.fn((name: string, h: Handler) => (handlers[name] ??= []).push(h)),
    registerCommand: vi.fn((name: string, def: any) => (commands[name] = def)),
    registerTool: vi.fn((def: any) => (tool = def)),
    registerProvider: vi.fn(),
    appendEntry: vi.fn((customType: string, data: unknown) =>
      branch.push({ type: 'custom', customType, data: JSON.parse(JSON.stringify(data)) })
    ),
    sendUserMessage: vi.fn(),
    sendMessage: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn() },
  };
  const ctx: any = {
    cwd,
    ui: { notify: vi.fn(), setWidget: vi.fn(), setStatus: vi.fn() },
    hasUI: true,
    sessionManager: { getBranch: () => branch },
    modelRegistry: { getApiKeyForProvider: vi.fn().mockResolvedValue('k'), find: vi.fn() },
    model: { provider: 'p', id: 'm' },
    isIdle: () => false,
  };
  piSupervisor(api);
  const emit = async (name: string, event: any = {}) => {
    for (const h of handlers[name] ?? []) await h({ type: name, ...event }, ctx);
  };
  return { cwd, api, ctx, emit, commands, getTool: () => tool, branch };
}

describe('upstream behaviour in ledger mode', () => {
  let s: ReturnType<typeof setup>;
  afterEach(() => rmSync(s.cwd, { recursive: true, force: true }));

  describe('ledger', () => {
    beforeEach(async () => {
      vi.mocked(analyze).mockReset();
      s = setup('ledger');
      await s.emit('session_start', { reason: 'startup' });
    });

    it('never runs goal analysis at idle or mid-run, so no done, steer or reframe', async () => {
      await s.emit('turn_end');
      await s.emit('before_agent_start');
      await s.emit('agent_settled');
      expect(analyze).not.toHaveBeenCalled();
      const goalStates = s.branch.filter((e) => e.customType === 'supervisor-state');
      expect(goalStates.at(-1).data.reframeTier).toBe(0);
      expect(s.api.sendUserMessage).not.toHaveBeenCalled();
    });

    it('refuses to start goal supervision from the command or the model tool', async () => {
      await s.commands.supervise.handler('make it converge', s.ctx);
      expect(s.ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/^Ledger mode/), 'info');
      const res = await s.getTool().execute('id', { outcome: 'x' }, undefined, undefined, s.ctx);
      expect(res.content[0].text).toMatch(/^Ledger mode/);
    });
  });

  describe('goal mode is unchanged', () => {
    beforeEach(async () => {
      vi.mocked(analyze).mockReset();
      vi.mocked(analyze).mockResolvedValue({ action: 'continue', reasoning: '', confidence: 1 });
      s = setup('goal');
      await s.emit('session_start', { reason: 'startup' });
    });

    it('still runs the goal analysis', async () => {
      await s.emit('agent_settled');
      expect(analyze).toHaveBeenCalled();
    });
  });
});
