import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/ui/model-picker.js', () => ({ pickModel: vi.fn() }));

import piLedger from '../src/index.js';

type Handler = (event: any, ctx: any) => Promise<unknown> | unknown;

function setup(opts: { memento?: string } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-ledger-plugin-'));
  if (opts.memento !== undefined) writeFileSync(join(cwd, 'MEMENTO.md'), opts.memento);
  const branch: any[] = [
    {
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    },
  ];
  const handlers: Record<string, Handler[]> = {};
  const commands: Record<string, any> = {};
  const api: any = {
    on: vi.fn((name: string, h: Handler) => (handlers[name] ??= []).push(h)),
    registerCommand: vi.fn((name: string, def: any) => (commands[name] = def)),
    registerTool: vi.fn(),
    registerProvider: vi.fn(),
    appendEntry: vi.fn((customType: string, data: unknown) =>
      branch.push({ type: 'custom', customType, data: JSON.parse(JSON.stringify(data)) })
    ),
    sendUserMessage: vi.fn(),
    sendMessage: vi.fn(),
  };
  const ctx: any = {
    cwd,
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    hasUI: true,
    sessionManager: { getBranch: () => branch },
    modelRegistry: { find: vi.fn() },
    model: { provider: 'p', id: 'm' },
  };
  piLedger(api);
  const emit = async (name: string, event: any = {}) => {
    for (const h of handlers[name] ?? []) await h({ type: name, ...event }, ctx);
  };
  const lastStatus = () => ctx.ui.setStatus.mock.calls.at(-1)?.[1];
  return { cwd, api, ctx, emit, commands, branch, lastStatus };
}

const MEMENTO = '# Q\n\n## Acceptance (locked)\n\n- AC1: fits held-out years\n\n## Next\n\n- fit\n';

describe('pi-ledger plugin', () => {
  let s: ReturnType<typeof setup>;
  afterEach(() => rmSync(s.cwd, { recursive: true, force: true }));

  it('registers only the ledger commands and no tools', () => {
    s = setup();
    expect(Object.keys(s.commands).sort()).toEqual(['flag', 'ledger', 'review']);
    expect(s.api.registerTool).not.toHaveBeenCalled();
  });

  it('switches on at session start when the ledger exists and shows the status line', async () => {
    s = setup({ memento: MEMENTO });
    await s.emit('session_start', { reason: 'startup' });
    expect(s.lastStatus()).toBe('Acceptance 0/1 passed · 0 open flags · ledger not checked yet');
  });

  it('stays off without a ledger until /ledger on, and remembers /ledger off', async () => {
    s = setup();
    await s.emit('session_start', { reason: 'startup' });
    expect(s.lastStatus()).toBeUndefined();
    await s.emit('agent_settled');
    expect(s.api.sendUserMessage).not.toHaveBeenCalled();

    await s.commands.ledger.handler('on', s.ctx);
    expect(s.lastStatus()).toBe('no Acceptance · 0 open flags · no MEMENTO.md');

    writeFileSync(join(s.cwd, 'MEMENTO.md'), MEMENTO);
    await s.commands.ledger.handler('off', s.ctx);
    expect(s.lastStatus()).toBeUndefined();
    // A reload keeps the explicit choice over autoEnable.
    await s.emit('session_start', { reason: 'reload' });
    expect(s.lastStatus()).toBeUndefined();
  });

  it('runs the monitor after each run: a missing Ledger line steers once, never toward a goal', async () => {
    s = setup({ memento: MEMENTO });
    await s.emit('session_start', { reason: 'startup' });
    await s.emit('before_agent_start');
    await s.emit('agent_settled');
    expect(s.api.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(s.api.sendUserMessage.mock.calls[0][0]).toMatch(/^Ledger check:/);
    expect(s.lastStatus()).toBe('Acceptance 0/1 passed · 0 open flags · ledger behind');
  });

  it('refuses /review while off', async () => {
    s = setup();
    await s.emit('session_start', { reason: 'startup' });
    await s.commands.review.handler('', s.ctx);
    expect(s.ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Ledger is off/), 'warning');
  });
});
