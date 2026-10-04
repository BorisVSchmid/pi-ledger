/**
 * Model calls for the reviewer and the compaction note: a fresh in-memory Pi
 * session per call (derived from pi-supervisor's supervisor session), which
 * delegates provider auth to the parent session's model registry and is
 * disposed afterwards, so nothing carries over between reviews.
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

type ThinkingLevel = NonNullable<ExtensionContext['thinkingLevel']>;

export class ModelSession {
  private session: Awaited<ReturnType<typeof createAgentSession>>['session'] | null = null;
  private model: any = null;
  private systemPrompt: string = '';
  private thinkingLevel: ThinkingLevel | undefined = undefined;
  private parentRegistry: ExtensionContext['modelRegistry'] | null = null;
  private cwd: string | null = null;

  async ensureStarted(
    ctx: ExtensionContext,
    provider: string,
    modelId: string,
    systemPrompt: string,
    thinkingLevel?: ThinkingLevel
  ): Promise<boolean> {
    // If model or system prompt changed, need new session
    const newModel = ctx.modelRegistry.find(provider, modelId);
    if (!newModel) return false;

    if (
      this.session &&
      this.model === newModel &&
      this.systemPrompt === systemPrompt &&
      this.thinkingLevel === thinkingLevel &&
      this.parentRegistry === ctx.modelRegistry &&
      this.cwd === ctx.cwd
    ) {
      // Session reusable
      return true;
    }

    // Dispose old session if exists
    this.dispose();

    const loader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPromptOverride: () => systemPrompt,
      noContextFiles: true,
      appendSystemPromptOverride: () => [],
      // A fresh SDK session otherwise loses extension/native providers owned
      // by the parent runtime. Delegate through the public model registry so
      // parent auth, environment and request hooks remain authoritative.
      extensionFactories: [
        (pi) => {
          pi.registerProvider(newModel.provider, {
            api: newModel.api,
            baseUrl: newModel.baseUrl,
            apiKey: 'supervisor-parent-runtime',
            models: [
              {
                id: newModel.id,
                name: newModel.name,
                api: newModel.api,
                reasoning: newModel.reasoning,
                input: newModel.input,
                cost: newModel.cost,
                contextWindow: newModel.contextWindow,
                maxTokens: newModel.maxTokens,
              },
            ],
            streamSimple: (_model, context, options) => {
              // The child credential is a local admission token, never provider
              // authentication. Let the parent's runtime resolve real auth.
              const { apiKey: _childKey, ...forwarded } = options ?? {};
              return ctx.modelRegistry.streamSimple(newModel, context, forwarded);
            },
          });
        },
      ],
    });
    await loader.reload();

    try {
      const result = await createAgentSession({
        cwd: ctx.cwd,
        sessionManager: SessionManager.inMemory(ctx.cwd),
        agentDir: getAgentDir(),
        model: newModel,
        tools: [],
        resourceLoader: loader,
        ...(thinkingLevel ? { thinkingLevel } : {}),
      });
      this.session = result.session;
      this.model = newModel;
      this.systemPrompt = systemPrompt;
      this.thinkingLevel = thinkingLevel;
      this.parentRegistry = ctx.modelRegistry;
      this.cwd = ctx.cwd;
      return true;
    } catch {
      return false;
    }
  }

  async prompt(
    userPrompt: string,
    signal?: AbortSignal,
    onDelta?: (accumulated: string) => void
  ): Promise<string | null> {
    if (!this.session || signal?.aborted) return null;

    const onAbort = () => this.session?.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    let responseText = '';
    const unsubscribe = this.session.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        responseText += event.assistantMessageEvent.delta;
        onDelta?.(responseText);
      }
    });

    try {
      await this.session.prompt(userPrompt);
    } catch {
      return null;
    } finally {
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
    }

    return responseText;
  }

  dispose(): void {
    if (this.session) {
      this.session.dispose();
      this.session = null;
    }
    this.model = null;
    this.parentRegistry = null;
    this.cwd = null;
  }
}

// ---------- one-shot JSON calls ----------

/** Extract the JSON object from a reply: strips fences and surrounding prose. */
export function parseJsonObject(text: string): unknown | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

export interface ModelRef {
  provider: string;
  modelId: string;
}

/** "provider/modelId" (model ids may themselves contain slashes). */
export function parseModelRef(ref: string | null | undefined): ModelRef | null {
  if (!ref) return null;
  const i = ref.indexOf('/');
  if (i <= 0 || i === ref.length - 1) return null;
  return { provider: ref.slice(0, i), modelId: ref.slice(i + 1) };
}

/** Configured model, else the chat model. */
export function resolveModel(ref: string | null, ctx: ExtensionContext): ModelRef | null {
  const parsed = parseModelRef(ref);
  if (parsed) return parsed;
  return ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : null;
}

export type JsonCallResult =
  | { ok: true; json: unknown; model: ModelRef }
  | { ok: false; error: string; model: ModelRef | null };

type Thinking = Parameters<ModelSession['ensureStarted']>[4];

/** How callJson makes a session; replaceable in tests. */
export const sessions = { create: (): ModelSession => new ModelSession() };

/** Call one model; on invalid JSON ask once more in the same session. */
async function callOnce(
  ctx: ExtensionContext,
  model: ModelRef,
  systemPrompt: string,
  userPrompt: string,
  thinking: string | undefined
): Promise<JsonCallResult> {
  const session = sessions.create();
  try {
    const level = thinking && thinking !== 'off' ? (thinking as Thinking) : undefined;
    const started = await session.ensureStarted(
      ctx,
      model.provider,
      model.modelId,
      systemPrompt,
      level
    );
    if (!started) return { ok: false, error: 'model unavailable', model };
    const first = await session.prompt(userPrompt, ctx.signal);
    if (first === null) return { ok: false, error: 'model call failed', model };
    let json = parseJsonObject(first);
    if (json === undefined) {
      const second = await session.prompt(
        'Your answer was not valid JSON. Reply again with only the JSON object, no prose, no fences.',
        ctx.signal
      );
      json = second === null ? undefined : parseJsonObject(second);
    }
    return json === undefined
      ? { ok: false, error: 'invalid JSON', model }
      : { ok: true, json, model };
  } finally {
    session.dispose();
  }
}

/** Primary model, then the fallback on unavailability or call failure (not on bad JSON). */
export async function callJson(
  ctx: ExtensionContext,
  opts: {
    model: string | null;
    fallbackModel: string | null;
    thinking?: string;
    systemPrompt: string;
    userPrompt: string;
  }
): Promise<JsonCallResult> {
  const primary = resolveModel(opts.model, ctx);
  if (!primary) return { ok: false, error: 'no model configured', model: null };
  const first = await callOnce(ctx, primary, opts.systemPrompt, opts.userPrompt, opts.thinking);
  if (first.ok || first.error === 'invalid JSON') return first;
  const fallback = parseModelRef(opts.fallbackModel);
  if (!fallback) return first;
  return callOnce(ctx, fallback, opts.systemPrompt, opts.userPrompt, opts.thinking);
}
