import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ModelRegistry,
  ModelRuntime,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
  fauxAssistantMessage,
  fauxProvider,
  getCurrentSystemPrompt,
  getCurrentTools,
} from '@earendil-works/pi-ai/compat';
import { SupervisorSession } from '../src/session/supervisor-session.js';

it('inherits the parent native provider runtime for real SDK supervisor sessions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi1-supervisor-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 503 });
  process.env.PI_CODING_AGENT_DIR = root;
  const supervisor = new SupervisorSession();
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(root, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const faux = fauxProvider({
      provider: 'supervisor-offline',
      api: 'supervisor-offline-api',
      models: [{ id: 'test', name: 'Offline', reasoning: false }],
      tokenSize: { min: 100, max: 100 },
    });
    runtime.registerNativeProvider(faux.provider);
    await runtime.refresh({ allowNetwork: false });
    const ctx = { cwd: root, modelRegistry: new ModelRegistry(runtime) } as ExtensionContext;
    faux.setResponses([
      (context, options) => {
        expect(options?.apiKey).not.toBe('supervisor-parent-runtime');
        expect(getCurrentSystemPrompt(context.messages)).toContain(
          'Analyze only the offline goal.'
        );
        expect(getCurrentSystemPrompt(context.messages)).toContain(root);
        expect(getCurrentTools(context.messages)).toEqual([]);
        return fauxAssistantMessage('local supervisor decision');
      },
      fauxAssistantMessage('second decision'),
    ]);
    expect(
      await supervisor.ensureStarted(
        ctx,
        'supervisor-offline',
        'test',
        'Analyze only the offline goal.'
      )
    ).toBe(true);
    expect(await supervisor.prompt('first analysis')).toBe('local supervisor decision');
    expect(
      await supervisor.ensureStarted(
        ctx,
        'supervisor-offline',
        'test',
        'Analyze only the offline goal.'
      )
    ).toBe(true);
    expect(await supervisor.prompt('second analysis')).toBe('second decision');
    expect(faux.state.callCount).toBe(2);
    faux.setResponses([
      (context) => {
        expect(JSON.stringify(context.messages)).not.toContain('first analysis');
        return fauxAssistantMessage('fresh parent decision');
      },
    ]);
    const replacement = { ...ctx, modelRegistry: new ModelRegistry(runtime) };
    expect(
      await supervisor.ensureStarted(
        replacement,
        'supervisor-offline',
        'test',
        'Analyze only the offline goal.'
      )
    ).toBe(true);
    expect(await supervisor.prompt('fresh analysis')).toBe('fresh parent decision');
    expect(faux.state.callCount).toBe(3);
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    expect(await supervisor.prompt('must not start', alreadyAborted.signal)).toBeNull();
    expect(faux.state.callCount).toBe(3);
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    faux.setResponses([
      async (_context, options) => {
        enter();
        await new Promise<void>((resolve) => {
          options!.signal!.addEventListener('abort', () => resolve(), { once: true });
        });
        return fauxAssistantMessage('must not finish normally');
      },
    ]);
    const cancellation = new AbortController();
    const cancelled = supervisor.prompt('cancel local analysis', cancellation.signal);
    await entered;
    cancellation.abort();
    expect(await cancelled).not.toBe('must not finish normally');
  } finally {
    supervisor.dispose();
    globalThis.fetch = previousFetch;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
