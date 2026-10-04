/**
 * Command helpers: /flag and /ledger register|metrics.
 * Handlers return the text to show; the caller decides how to show it.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { LedgerConfig } from './config.js';
import { renderFlag } from './flags-file.js';
import { renderRegister, resolveFlag, steerTextFor } from './register.js';
import type { LedgerRuntime } from './runtime.js';
import { bump } from './state.js';

export const FLAG_USAGE =
  'Usage: /flag (list) · /flag <id> intended|dismiss [reason] · /flag <id> send';

export async function flagCommand(
  args: string,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  runtime: LedgerRuntime,
  config: LedgerConfig
): Promise<string> {
  const reg = runtime.state().register;
  const [id, action, ...rest] = args.trim().split(/\s+/).filter(Boolean);

  if (!id || id === 'list') {
    const open = reg.flags.filter((f) => f.status === 'open');
    if (open.length === 0) return 'No open flags.';
    return open.map((f) => renderFlag(f).join('\n')).join('\n\n');
  }

  const flag = reg.flags.find((f) => f.id.toLowerCase() === id.toLowerCase());
  if (!flag) return `No flag ${id}. ${FLAG_USAGE}`;
  if (!action) return renderFlag(flag).join('\n');
  if (action !== 'intended' && action !== 'dismiss' && action !== 'send') return FLAG_USAGE;

  resolveFlag(reg, flag.id, action, rest.join(' ') || undefined);
  bump(runtime.state(), `flag.${action}`);
  runtime.store.persist();
  await runtime.writeFlags(ctx, config);
  await runtime.exportRegister(ctx, config);

  if (action === 'send') {
    pi.sendUserMessage(steerTextFor(flag), { deliverAs: 'followUp' });
    return `${flag.id} sent to the agent.`;
  }
  return action === 'intended'
    ? `${flag.id} marked intended; it will not be raised again.`
    : `${flag.id} dismissed.`;
}

export function registerText(runtime: LedgerRuntime): string {
  return renderRegister(runtime.state().register);
}

export function metricsText(runtime: LedgerRuntime): string {
  const s = runtime.state();
  const flags = s.register.flags;
  const count = (status: string) => flags.filter((f) => f.status === status).length;
  const lines = [
    `turns observed: ${s.turn}`,
    `flags: ${flags.length} (open ${count('open')}, intended ${count('intended')}, dismissed ${count('dismissed')}, sent ${count('sent')})`,
    `notices: ${s.notices.length}`,
    ...Object.entries(s.metrics)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}: ${v}`),
  ];
  return lines.join('\n');
}
