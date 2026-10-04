/**
 * pi-ledger configuration. Every key is optional.
 *
 * Read from <cwd>/.pi/ledger-config.json, then <agentDir>/ledger-config.json
 * (~/.pi/agent by default). The legacy name supervisor-config.json is read
 * at each location when ledger-config.json is absent. The first file that
 * exists and parses wins; missing keys take the defaults below. Everything
 * else (triggers, locked headings, limits) is fixed in code.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export interface LedgerConfig {
  /** Switch on at session start when the ledger file exists (until /ledger on|off says otherwise). */
  autoEnable: boolean;
  reviewer: {
    /** "provider/modelId"; null means the chat model. */
    model: string | null;
    /** Used when the primary model is unavailable or the call fails. */
    fallbackModel: string | null;
    thinking: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  };
  files: {
    ledger: string;
    spec: string;
    /** Model source the reviewer reads and the monitor diffs. */
    modelFiles: string[];
    ignore: string[];
  };
}

export const CONFIG_FILE = 'ledger-config.json';
/** Read when ledger-config.json is absent, so projects set up for the fork keep working. */
export const LEGACY_CONFIG_FILE = 'supervisor-config.json';

export function defaultConfig(): LedgerConfig {
  return {
    autoEnable: true,
    reviewer: { model: null, fallbackModel: null, thinking: 'high' },
    files: {
      ledger: 'MEMENTO.md',
      spec: 'MODEL_SPEC.md',
      modelFiles: ['*.{R,stan}', 'R/**/*.R', 'src/**/*.{R,stan,clj,py}', 'models/**/*'],
      // Archived code is not part of the model, even if it keeps its @concept tags.
      ignore: ['**/node_modules/**', '**/.git/**', '**/renv/**', '**/archive/**'],
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

function readConfigFile(cwd: string, agentDir: string): unknown | undefined {
  for (const dir of [join(cwd, '.pi'), agentDir]) {
    const raw = readJson(join(dir, CONFIG_FILE)) ?? readJson(join(dir, LEGACY_CONFIG_FILE));
    if (raw !== undefined) return raw;
  }
  return undefined;
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
