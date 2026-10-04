/**
 * Ledger-mode configuration.
 *
 * Read from <cwd>/.pi/supervisor-config.json, falling back to
 * <agentDir>/supervisor-config.json (~/.pi/agent by default). The first file
 * that exists and parses wins; missing keys take the defaults below.
 * Defaults keep upstream behaviour: mode is "goal" unless set to "ledger".
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export type SupervisorMode = 'goal' | 'ledger';

export interface ReviewerTriggers {
  onRegisterChange: boolean;
  onBreakpoint: boolean;
  beforeCompaction: boolean;
  onCommand: boolean;
  /** 0 disables the backstop. */
  idleAfterModelEditsEveryNTurns: number;
}

export interface LedgerConfig {
  mode: SupervisorMode;
  reviewer: {
    /** "provider/modelId"; null means use the supervisor model. */
    model: string | null;
    fallbackModel: string | null;
    thinking: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
    maxTokens: number;
    triggers: ReviewerTriggers;
    inputs: string[];
    maxModelFileChars: number;
  };
  /** "provider/modelId" for the optional per-turn LLM ledger check; null = code-only. */
  turnModel: string | null;
  files: {
    ledger: string;
    ledgerArchive: string;
    spec: string;
    register: string;
    flags: string;
    runs: string;
    modelFiles: string[];
    ignore: string[];
  };
  monitor: {
    lockedHeadings: string[];
    cjkRatioMax: number;
    runCommands: string[];
  };
  routing: {
    /** Deterministic findings that may steer without a human decision. */
    autoSteer: string[];
    notifyOnly: string[];
    neverRepeatSteer: boolean;
  };
  compaction: {
    /** After each compaction, add a supervisor note flagging stale statements in the summary. */
    annotateSummaries: boolean;
  };
  upstream: {
    reframeEscalation: boolean;
    idleContinueIsNoop: boolean;
    doneEnabled: boolean;
  };
}

export const CONFIG_FILE = 'supervisor-config.json';

export function defaultConfig(): LedgerConfig {
  return {
    mode: 'goal',
    reviewer: {
      model: null,
      fallbackModel: null,
      thinking: 'high',
      maxTokens: 16000,
      triggers: {
        onRegisterChange: true,
        onBreakpoint: true,
        beforeCompaction: true,
        onCommand: true,
        idleAfterModelEditsEveryNTurns: 6,
      },
      inputs: [
        'model_spec',
        'model_register',
        'ledger',
        'model_files',
        'model_edits',
        'agent_summary',
      ],
      maxModelFileChars: 120000,
    },
    turnModel: null,
    files: {
      ledger: 'MEMENTO.md',
      ledgerArchive: 'MEMENTO.archive.md',
      spec: 'MODEL_SPEC.md',
      register: '.pi/model-register.md',
      flags: '.pi/FLAGS.md',
      runs: '.pi/runs.jsonl',
      modelFiles: ['R/**/*.R', 'src/**/*.{R,stan,clj,py}', 'models/**/*'],
      ignore: ['**/node_modules/**', '**/.git/**', '**/renv/**'],
    },
    monitor: {
      lockedHeadings: ['Acceptance', 'Checks'],
      cjkRatioMax: 0.01,
      runCommands: ['Rscript', 'cmdstan', 'python', 'clj', 'make'],
    },
    routing: {
      autoSteer: ['LEDGER_LINE_MISSING', 'LEDGER_CLAIMED_NO_CHANGE', 'LEDGER_CHANGED_UNCLAIMED'],
      notifyOnly: ['LOCKED_SECTION_EDITED', 'LANGUAGE_DRIFT', 'INJECTION', 'FLAG', 'TURN_FINDING'],
      neverRepeatSteer: true,
    },
    compaction: {
      annotateSummaries: true,
    },
    upstream: {
      reframeEscalation: false,
      idleContinueIsNoop: true,
      doneEnabled: false,
    },
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Overlay `over` onto `base`, keeping base's shape and value types. Unknown keys are ignored. */
function merge<T>(base: T, over: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(over)) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, baseValue] of Object.entries(base)) {
    if (!(key in over)) continue;
    const value = over[key];
    if (isPlainObject(baseValue)) out[key] = merge(baseValue, value);
    else if (baseValue === null)
      out[key] = typeof value === 'string' || value === null ? value : null;
    else if (Array.isArray(baseValue)) {
      if (Array.isArray(value) && value.every((x) => typeof x === 'string')) out[key] = value;
    } else if (typeof value === typeof baseValue) out[key] = value;
  }
  return out as T;
}

function readJson(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
}

/** Load the config for `cwd`. Never throws; falls back to defaults. */
export function loadLedgerConfig(cwd: string, agentDir: string = getAgentDir()): LedgerConfig {
  const raw = readJson(join(cwd, '.pi', CONFIG_FILE)) ?? readJson(join(agentDir, CONFIG_FILE));
  const config = merge(defaultConfig(), raw);
  if (config.mode !== 'ledger') config.mode = 'goal';
  return config;
}

export function isLedgerMode(config: LedgerConfig | null | undefined): boolean {
  return config?.mode === 'ledger';
}
