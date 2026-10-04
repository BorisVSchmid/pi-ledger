/**
 * pi-ledger — "Surely You're Joking". Keeps a research session's ledger and
 * model honest. It never steers the work's direction and never judges
 * whether the work is done.
 *
 *  - a code-only monitor after every agent run (ledger line vs. file, locked
 *    sections, language drift, injection), with two templated steers;
 *  - a sparse reviewer in a fresh model session that checks the model's code
 *    against its spec and the ledger, and raises flags for the human;
 *  - a note after compaction listing statements the ledger has since retired;
 *  - a status line computed from the ledger:
 *      Acceptance 1/3 passed · 2 open flags · ledger current
 *
 * Commands:
 *   /ledger [status]       — status line and Acceptance detail
 *   /ledger on | off       — switch the ledger on or off for this session
 *   /ledger register       — show the model register
 *   /ledger metrics        — show counters
 *   /ledger model          — pick the reviewer model
 *   /review [note]         — review the model now
 *   /flag ...              — list and answer reviewer flags
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  defaultConfig,
  loadLedgerConfig,
  saveReviewerModel,
  type LedgerConfig,
} from './ledger/config.js';
import { LedgerRuntime, readTextOrNull } from './ledger/runtime.js';
import { flagCommand, metricsText, registerText } from './ledger/commands.js';
import { statusDetail, statusLine } from './ledger/status.js';
import { parseModelRef } from './ledger/model-call.js';
import { pickModel } from './ui/model-picker.js';

const STATUS_KEY = 'ledger';

const SUBCOMMANDS = [
  { value: 'status', label: 'status', description: 'Status line and Acceptance detail' },
  { value: 'on', label: 'on', description: 'Switch the ledger on for this session' },
  { value: 'off', label: 'off', description: 'Switch the ledger off for this session' },
  { value: 'register', label: 'register', description: 'Show the model register' },
  { value: 'metrics', label: 'metrics', description: 'Show ledger counters' },
  { value: 'model', label: 'model', description: 'Pick the reviewer model' },
];

export default function (pi: ExtensionAPI) {
  let config: LedgerConfig = defaultConfig();
  let enabled = false;
  const ledger = new LedgerRuntime(pi);

  const ledgerPath = (ctx: ExtensionContext) => path.resolve(ctx.cwd, config.files.ledger);

  const refreshStatus = async (ctx: ExtensionContext): Promise<void> => {
    if (!enabled) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const text = statusLine({
      ledgerText: await readTextOrNull(ledgerPath(ctx)),
      ledgerName: config.files.ledger,
      state: ledger.state(),
      reviewing: ledger.pending !== null,
    });
    ctx.ui.setStatus(STATUS_KEY, text);
  };

  /** Refresh now, and again when a background review finishes. */
  const refreshAfterWork = async (ctx: ExtensionContext): Promise<void> => {
    await refreshStatus(ctx);
    void ledger.pending?.then(() => refreshStatus(ctx));
  };

  const setEnabled = (value: boolean) => {
    enabled = value;
    ledger.state().enabled = value;
    ledger.store.persist();
  };

  // ---- Session lifecycle ----

  const onSessionLoad = async (ctx: ExtensionContext) => {
    config = loadLedgerConfig(ctx.cwd);
    ledger.load(ctx);
    enabled = ledger.state().enabled ?? (config.autoEnable && existsSync(ledgerPath(ctx)));
    if (enabled) await ledger.seedFromSpec(ctx, config);
    await refreshStatus(ctx);
  };

  pi.on('session_start', async (_event, ctx) => onSessionLoad(ctx));
  pi.on('session_tree', async (_event, ctx) => onSessionLoad(ctx));

  // ---- Monitor: turn baseline, run log, end-of-run checks ----

  pi.on('before_agent_start', async (_event, ctx) => {
    if (enabled) await ledger.onAgentStart(ctx, config);
  });

  pi.on('tool_call', async (event, ctx) => {
    if (enabled) await ledger.onToolCall(event, ctx, config);
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
    if (enabled && config.reviewer.triggers.beforeCompaction) {
      ledger.startReview(ctx, config, 'before_compaction');
      await refreshAfterWork(ctx);
    }
  });

  // The summary stays as written; a separate note flags statements in it
  // that the ledger has since crossed out or contradicted.
  pi.on('session_compact', async (event, ctx) => {
    if (enabled && config.compaction.annotateSummaries) {
      ledger.startCompactionNote(ctx, config, event.compactionEntry.summary);
    }
  });

  // ---- /ledger ----

  pi.registerCommand('ledger', {
    description: 'Ledger status, or /ledger on|off|register|metrics|model',
    getArgumentCompletions(prefix: string) {
      const matches = SUBCOMMANDS.filter((s) => s.value.startsWith(prefix));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const sub = args?.trim() ?? '';

      if (sub === 'on') {
        setEnabled(true);
        await ledger.seedFromSpec(ctx, config);
        await refreshStatus(ctx);
        const missing = existsSync(ledgerPath(ctx))
          ? ''
          : ` No ${config.files.ledger} yet; the ledger checks start once it exists.`;
        ctx.ui.notify(`Ledger on.${missing}`, 'info');
        return;
      }

      if (sub === 'off') {
        setEnabled(false);
        await refreshStatus(ctx);
        ctx.ui.notify('Ledger off for this session.', 'info');
        return;
      }

      if (sub === 'register') {
        ctx.ui.notify(registerText(ledger), 'info');
        return;
      }

      if (sub === 'metrics') {
        ctx.ui.notify(metricsText(ledger), 'info');
        return;
      }

      if (sub === 'model') {
        const current = parseModelRef(config.reviewer.model);
        const picked = await pickModel(
          ctx,
          current?.provider ?? ctx.model?.provider,
          current?.modelId ?? ctx.model?.id
        );
        if (!picked) {
          ctx.ui.notify('Reviewer model selection cancelled.', 'info');
          return;
        }
        const file = saveReviewerModel(ctx.cwd, `${picked.provider}/${picked.id}`);
        config = loadLedgerConfig(ctx.cwd);
        ctx.ui.notify(
          `Reviewer model set to ${picked.provider}/${picked.id} (saved to ${file}).`,
          'info'
        );
        return;
      }

      if (sub === '' || sub === 'status') {
        if (!enabled) {
          ctx.ui.notify('Ledger is off. Use /ledger on to start.', 'info');
          return;
        }
        const text = await readTextOrNull(ledgerPath(ctx));
        await refreshStatus(ctx);
        ctx.ui.notify(
          `${statusLine({ ledgerText: text, ledgerName: config.files.ledger, state: ledger.state(), reviewing: ledger.pending !== null })}\n${statusDetail(text)}`,
          'info'
        );
        return;
      }

      ctx.ui.notify('Usage: /ledger [status] | on | off | register | metrics | model', 'warning');
    },
  });

  // ---- /review: ask for a review now ----

  pi.registerCommand('review', {
    description: 'Review the model now (/review [note for the reviewer])',
    handler: async (args, ctx) => {
      if (!enabled) {
        ctx.ui.notify('Ledger is off. Use /ledger on first.', 'warning');
        return;
      }
      if (!config.reviewer.triggers.onCommand) {
        ctx.ui.notify('/review is disabled in ledger-config.json.', 'warning');
        return;
      }
      const note = args?.trim() || undefined;
      if (!ledger.startReview(ctx, config, 'command', note)) {
        ctx.ui.notify('A review is already running.', 'info');
        return;
      }
      await refreshAfterWork(ctx);
    },
  });

  // ---- /flag: answer reviewer flags ----

  pi.registerCommand('flag', {
    description: 'List flags, or /flag <id> intended|dismiss|send [reason]',
    handler: async (args, ctx) => {
      ctx.ui.notify(await flagCommand(args ?? '', ctx, pi, ledger, config), 'info');
      await refreshStatus(ctx);
    },
  });
}
