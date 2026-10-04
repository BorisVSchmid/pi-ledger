/**
 * One-shot model calls for ledger mode: a fresh in-memory session per call,
 * disposed afterwards, so nothing carries over between reviews.
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { SupervisorSession } from '../session/supervisor-session.js';
import { loadGlobalModel } from '../global-config.js';
import { parseJsonObject } from './reviewer.js';

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

/** Configured model, else the supervisor's model from config, else the chat model. */
export function resolveModel(ref: string | null, ctx: ExtensionContext): ModelRef | null {
  const parsed = parseModelRef(ref);
  if (parsed) return parsed;
  const global = loadGlobalModel();
  if (global) return global;
  return ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : null;
}

export type JsonCallResult =
  | { ok: true; json: unknown; model: ModelRef }
  | { ok: false; error: string; model: ModelRef | null };

type Thinking = Parameters<SupervisorSession['ensureStarted']>[4];

/** Call one model; on invalid JSON ask once more in the same session. */
async function callOnce(
  ctx: ExtensionContext,
  model: ModelRef,
  systemPrompt: string,
  userPrompt: string,
  thinking: string | undefined
): Promise<JsonCallResult> {
  const session = new SupervisorSession();
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
