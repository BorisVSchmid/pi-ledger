/**
 * pi-ledger configuration.
 *
 * Read from <cwd>/.pi/ledger-config.json, then <agentDir>/ledger-config.json
 * (~/.pi/agent by default). The legacy name supervisor-config.json is read
 * at each location when ledger-config.json is absent. The first file that
 * exists and parses wins; missing keys take the defaults below.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export interface ReviewerTriggers {
  onRegisterChange: boolean;
  onBreakpoint: boolean;
  beforeCompaction: boolean;
  onCommand: boolean;
  /** 0 disables the backstop. */
  idleAfterModelEditsEveryNTurns: number;
}

export interface LedgerConfig {
  /** Switch on at session start when the ledger file exists (until /ledger on|off says otherwise). */
  autoEnable: boolean;
  reviewer: {
    /** "provider/modelId"; null means use the chat model. */
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
    /** After each compaction, add a ledger note flagging stale statements in the summary. */
    annotateSummaries: boolean;
  };
}

export const CONFIG_FILE = 'ledger-config.json';
/** Read when ledger-config.json is absent, so projects set up for the fork keep working. */
export const LEGACY_CONFIG_FILE = 'supervisor-config.json';

export function defaultConfig(): LedgerConfig {
  return {
    autoEnable: true,
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
  const raw = readConfigFile(cwd, agentDir);
  const config = merge(defaultConfig(), raw);
  // The fork kept the supervisor model as { model: { provider, modelId } }; use it for the reviewer.
  const legacy = isPlainObject(raw) && isPlainObject(raw.model) ? raw.model : undefined;
  if (!config.reviewer.model && legacy?.provider && legacy?.modelId) {
    config.reviewer.model = `${String(legacy.provider)}/${String(legacy.modelId)}`;
  }
  return config;
}

function readConfigFile(cwd: string, agentDir: string): unknown | undefined {
  for (const dir of [join(cwd, '.pi'), agentDir]) {
    const raw = readJson(join(dir, CONFIG_FILE)) ?? readJson(join(dir, LEGACY_CONFIG_FILE));
    if (raw !== undefined) return raw;
  }
  return undefined;
}

/** Set `reviewer.model` in <cwd>/.pi/ledger-config.json, keeping other keys. Returns the path. */
export function saveReviewerModel(cwd: string, ref: string): string {
  const dir = join(cwd, '.pi');
  const file = join(dir, CONFIG_FILE);
  const existing = readJson(file);
  const out: Record<string, unknown> = isPlainObject(existing) ? existing : {};
  out.reviewer = { ...(isPlainObject(out.reviewer) ? out.reviewer : {}), model: ref };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n', 'utf-8');
  return file;
}
