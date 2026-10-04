/**
 * Ledger-mode state, persisted in the Pi session as a custom entry
 * (the same mechanism upstream uses for supervisor state).
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { FindingKind } from './monitor.js';
import { emptyRegister, type Register } from './register.js';

export const LEDGER_ENTRY_TYPE = 'supervisor-ledger-state';

export interface Notice {
  kind: FindingKind;
  detail: string;
  turn: number;
  ts: number;
}

export interface LedgerState {
  version: 1;
  /** Completed agent runs observed in ledger mode. */
  turn: number;
  /** MEMENTO.md at the end of the last observed turn. */
  previousLedgerHash: string | null;
  previousLedgerText: string | null;
  /** `${kind}:${ledgerHash}` of every steer sent; a key is never sent twice. */
  steerHistory: string[];
  notices: Notice[];
  /** Dedup keys for notices, so the same finding is not reported every turn. */
  noticeKeys: string[];
  metrics: Record<string, number>;
  /** Concept-level model register and reviewer flags. */
  register: Register;
}

export function emptyLedgerState(): LedgerState {
  return {
    version: 1,
    turn: 0,
    previousLedgerHash: null,
    previousLedgerText: null,
    steerHistory: [],
    notices: [],
    noticeKeys: [],
    metrics: {},
    register: emptyRegister(),
  };
}

export function bump(state: LedgerState, metric: string, by = 1): void {
  state.metrics[metric] = (state.metrics[metric] ?? 0) + by;
}

/** Keep notices bounded; older ones remain in earlier session entries. */
const MAX_NOTICES = 200;

export function addNotice(state: LedgerState, notice: Notice, key: string): boolean {
  if (state.noticeKeys.includes(key)) return false;
  state.noticeKeys.push(key);
  state.notices.push(notice);
  if (state.notices.length > MAX_NOTICES)
    state.notices.splice(0, state.notices.length - MAX_NOTICES);
  if (state.noticeKeys.length > MAX_NOTICES * 5) state.noticeKeys.splice(0, MAX_NOTICES);
  return true;
}

export class LedgerStateStore {
  private state: LedgerState = emptyLedgerState();

  constructor(private pi: ExtensionAPI) {}

  get(): LedgerState {
    return this.state;
  }

  load(ctx: ExtensionContext): void {
    const entries = ctx.sessionManager.getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i] as { type: string; customType?: string; data?: unknown };
      if (entry.type === 'custom' && entry.customType === LEDGER_ENTRY_TYPE) {
        this.state = { ...emptyLedgerState(), ...(entry.data as Partial<LedgerState>) };
        return;
      }
    }
    this.state = emptyLedgerState();
  }

  persist(): void {
    this.pi.appendEntry(LEDGER_ENTRY_TYPE, this.state);
  }
}
