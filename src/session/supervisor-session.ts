/**
 * SupervisorSession - reusable session for a single supervision goal.
 * Maintains context window across multiple analyses for token efficiency.
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export class SupervisorSession {
  private session: Awaited<ReturnType<typeof createAgentSession>>['session'] | null = null;
  private model: any = null;
  private systemPrompt: string = '';
  private parentRegistry: ExtensionContext['modelRegistry'] | null = null;
  private cwd: string | null = null;

  async ensureStarted(
    ctx: ExtensionContext,
    provider: string,
    modelId: string,
    systemPrompt: string
  ): Promise<boolean> {
    // If model or system prompt changed, need new session
    const newModel = ctx.modelRegistry.find(provider, modelId);
    if (!newModel) return false;

    if (
      this.session &&
      this.model === newModel &&
      this.systemPrompt === systemPrompt &&
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
      });
      this.session = result.session;
      this.model = newModel;
      this.systemPrompt = systemPrompt;
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
