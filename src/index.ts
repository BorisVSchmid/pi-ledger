/**
 * pi-ledger — "Surely You're Joking". Keeps a research session's ledger and
 * model honest. It never steers the work's direction and never judges
 * whether the work is done.
 *
 *  monitor.ts   code-only checks after every agent run, and the status line
 *  reviewer.ts  a capable model reviews the model's code against its spec and
 *               ledger; the post-compaction note
 *  flags.ts     the reviewer's questions for the human
 *  runtime.ts   state, files and model calls (glue); this file wires up Pi
 *
 * Commands:
 *   /ledger [status]   status line and Acceptance detail
 *   /ledger on | off   switch the ledger on or off for this session
 *   /ledger metrics    counters
 *   /review [note]     review the model now
 *   /flag ...          list, close or send reviewer flags
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  defaultConfig,
  legacyLedgerNotice,
  loadLedgerConfig,
  type LedgerConfig,
} from './config.js';
import { LedgerRuntime, readTextOrNull } from './runtime.js';
import { statusDetail, statusLine } from './monitor.js';

const STATUS_KEY = 'ledger';

const SUBCOMMANDS = [
  { value: 'status', label: 'status', description: 'Status line and Acceptance detail' },
  { value: 'on', label: 'on', description: 'Switch the ledger on for this session' },
  { value: 'off', label: 'off', description: 'Switch the ledger off for this session' },
  { value: 'metrics', label: 'metrics', description: 'Show ledger counters' },
];

export default function (pi: ExtensionAPI) {
  let config: LedgerConfig = defaultConfig();
  let enabled = false;
  const ledger = new LedgerRuntime(pi);

  const ledgerPath = (ctx: ExtensionContext) => path.resolve(ctx.cwd, config.files.ledger);

  const currentStatus = async (ctx: ExtensionContext) => {
    const text = await readTextOrNull(ledgerPath(ctx));
    const line = statusLine({
      ledgerText: text,
      ledgerName: config.files.ledger,
      state: ledger.state(),
      reviewing: ledger.pending !== null,
    });
    return { text, line };
  };

  const refreshStatus = async (ctx: ExtensionContext): Promise<void> => {
    ctx.ui.setStatus(STATUS_KEY, enabled ? (await currentStatus(ctx)).line : undefined);
  };

  /** Refresh now, and again when a background review finishes. */
  const refreshAfterWork = async (ctx: ExtensionContext): Promise<void> => {
    await refreshStatus(ctx);
    void ledger.pending?.then(() => refreshStatus(ctx));
  };

  const setEnabled = (value: boolean) => {
    enabled = value;
    ledger.state().enabled = value;
    ledger.persist();
  };

  // ---- Session lifecycle ----

  const onSessionLoad = async (ctx: ExtensionContext) => {
    config = loadLedgerConfig(ctx.cwd);
    ledger.load(ctx);
    enabled = ledger.state().enabled ?? (config.autoEnable && existsSync(ledgerPath(ctx)));
    const legacy = legacyLedgerNotice(ctx.cwd, config.files.ledger);
    if (legacy) ctx.ui.notify(legacy, 'info');
    await refreshStatus(ctx);
  };

  pi.on('session_start', async (_event, ctx) => onSessionLoad(ctx));
  pi.on('session_tree', async (_event, ctx) => onSessionLoad(ctx));

  // ---- Monitor ----

  pi.on('before_agent_start', async (_event, ctx) => {
    if (enabled) await ledger.onAgentStart(ctx, config);
  });

  // agent_settled fires once Pi has fully settled: retries, overflow
  // recovery and queued follow-ups are done.
  pi.on('agent_settled', async (_event, ctx) => {
    if (!enabled) return;
    try {
      await ledger.onSettled(ctx, config);
    } catch (err) {
      ctx.ui.notify(`Ledger: monitor failed (${String(err)})`, 'warning');
    }
    await refreshAfterWork(ctx);
  });

  // ---- Compaction ----

  // Review the model before context is lost. Runs in the background on
  // artefacts only, so compaction is not delayed. Never returns a compaction.
  pi.on('session_before_compact', async (_event, ctx) => {
    if (!enabled) return;
    ledger.startReview(ctx, config, 'before_compaction');
    await refreshAfterWork(ctx);
  });

  // The summary stays as written; a separate note lists statements in it
  // that differ from the ledger.
  pi.on('session_compact', async (event, ctx) => {
    if (enabled) ledger.startCompactionNote(ctx, config, event.compactionEntry.summary);
  });

  // ---- /ledger ----

  pi.registerCommand('ledger', {
    description: 'Ledger status, or /ledger on|off|metrics',
    getArgumentCompletions(prefix: string) {
      const matches = SUBCOMMANDS.filter((s) => s.value.startsWith(prefix));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const sub = args?.trim() ?? '';

      if (sub === 'on' || sub === 'off') {
        setEnabled(sub === 'on');
        await refreshStatus(ctx);
        const missing =
          sub === 'on' && !existsSync(ledgerPath(ctx))
            ? ` No ${config.files.ledger} yet; the ledger checks start once it exists.`
            : '';
        ctx.ui.notify(
          sub === 'on' ? `Ledger on.${missing}` : 'Ledger off for this session.',
          'info'
        );
        return;
      }

      if (sub === 'metrics') {
        ctx.ui.notify(ledger.metricsText(), 'info');
        return;
      }

      if (sub === '' || sub === 'status') {
        if (!enabled) {
          ctx.ui.notify('Ledger is off. Use /ledger on to start.', 'info');
          return;
        }
        const { text, line } = await currentStatus(ctx);
        ctx.ui.setStatus(STATUS_KEY, line);
        ctx.ui.notify(`${line}\n${statusDetail(text)}`, 'info');
        return;
      }

      ctx.ui.notify('Usage: /ledger [status] | on | off | metrics', 'warning');
    },
  });

  // ---- /review ----

  pi.registerCommand('review', {
    description: 'Review the model now (/review [note for the reviewer])',
    handler: async (args, ctx) => {
      if (!enabled) {
        ctx.ui.notify('Ledger is off. Use /ledger on first.', 'warning');
        return;
      }
      if (!ledger.startReview(ctx, config, 'command', args?.trim() || undefined)) {
        ctx.ui.notify('A review is already running.', 'info');
        return;
      }
      await refreshAfterWork(ctx);
    },
  });

  // ---- /flag ----

  pi.registerCommand('flag', {
    description: 'List flags, or /flag <id> close <reason, 3+ words> | send',
    handler: async (args, ctx) => {
      ctx.ui.notify(await ledger.flagCommand(args ?? '', ctx, config), 'info');
      await refreshStatus(ctx);
    },
  });
}
