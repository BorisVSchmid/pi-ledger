# Ledger mode: implementation notes

Working notes for implementing `ledger-mode-brief/DESIGN_BRIEF.md` in this fork.

## Starting point

- Starting commit: `8f5a1b45c65f1886cdfdedffae29889cba951421`
  ("fix: retain parent native providers on Pi 1.0.0", 2026-10-02), package version 0.5.23.
- Pi pins: `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui` all `1.0.0`; `typebox` 1.3.27.
- Baseline: `tsc --noEmit` clean; `vitest run` 14 files, 206 tests passing.
- Development branch: `claude/supervisor-brief-x4zwe1` (the brief asks for `ledger-mode`;
  this session is restricted to the branch above, one commit per deliverable as asked).
- Tooling note: `bun install` (bun 1.3.14) cannot read `bun.lock` (lockfile version 2), and
  `npm install` in the repo fails on the `overrides` block. The baseline above was run against
  the same pinned versions installed with npm outside the repo. No lockfile or pin was changed.

## Deliverable 1: orientation (no code changes)

All facts below were read from source in this repo and from the installed
`@earendil-works/pi-coding-agent@1.0.0` type declarations and compiled JS, not from the README.

### Hooks: brief vs. source

| Brief says | Source says |
|---|---|
| Supervisor decides in `agent_end` | Idle decision is in **`agent_settled`** (`src/index.ts:232`). README line 122 still says `agent_end`; the README is stale. `agent_end` is not used. |
| `session_start` | Used, registered **twice** (`src/index.ts:145-149`); the first handler runs on every reason, so the second is redundant. |
| `before_agent_start` | Used only to bump `userInputEpoch` (`src/index.ts:89`). |
| `tool_call` | **Not used** anywhere. Exists in Pi (`ExtensionAPI.on("tool_call")`); bash calls arrive as `BashToolCallEvent` with `toolName: "bash"` and `input.command`. |
| `turn_end` | Used for mid-run analysis, gated on `detectMidRunSignals` (`src/index.ts:201-229`). |
| `session_before_compact` | Used only to persist state (`src/index.ts:153`). |

Recommendation: run the ledger monitor in `agent_settled`, as upstream does. Pi documents it as
firing once after retries, overflow compaction and queued follow-ups are done, so D1–D5 see the
final assistant text once per user prompt. `agent_end` can fire for a run that is then retried.

### Role → file map

| Role | Where |
|---|---|
| Idle analysis + steer/done routing | `src/index.ts:232-337` (`agent_settled`) |
| Mid-run analysis | `src/index.ts:201-229` (`turn_end`), signals in `src/state/mid-run-signals.ts` |
| Supervisor input assembly | `src/core/analyzer.ts` → `src/compaction/index.ts` (`extractMessages`, `buildCompactionSummary`, `formatForSupervisor`) → `src/core/prompt-builder.ts` (`buildUserPrompt`) |
| System prompt | `src/core/prompt-loader.ts`: `<cwd>/.pi/SUPERVISOR.md`, then `~/.pi/agent/SUPERVISOR.md`, then the built-in prompt |
| Model call | `src/session/client.ts` → `src/session/supervisor-session.ts` (in-memory `createAgentSession`, `tools: []`, providers delegated to the parent registry) |
| Response parsing | `src/session/response-parser.ts` (`parseDecision`; invalid JSON → `continue`) |
| State | `src/state/manager.ts`, type `SupervisorState` in `src/types.ts` |
| Persistence | `pi.appendEntry('supervisor-state', state)` on every change; `loadFromSession` takes the last such custom entry on the active branch (`src/state/manager.ts:110-129`) |
| Reframe tier increment | `src/index.ts:264-267`: `detectIneffectivePattern()` → `escalateReframeTier()`. `detectIneffectivePattern` (`src/state/patterns.ts`) also fires on 60 s without a steer, so the tier climbs on stagnation alone. |
| Reframe guidance text | `src/core/reframe.ts`, injected by `buildUserPrompt` |
| `done` | Schema in `src/types.ts:37`, parser accepts it, handled at `src/index.ts:314-320` (stops supervision) |
| Config | `src/global-config.ts`: only `model: {provider, modelId}`, read from `join(process.cwd(), '.pi/supervisor-config.json')` |

### Specific questions from deliverable 1

- **How `continue` at idle is treated.** In code it is already a no-op (falls through to
  "watching", `src/index.ts:321-326`). But the built-in prompt tells the model it must never
  return `continue` at idle, the user prompt repeats that (`prompt-builder.ts:39-41`), and
  `analyze()` returns a **steer** ("Please continue working toward the goal.") when the model
  call throws at idle (`analyzer.ts:46-53`). Ledger mode needs all three switched off.
- **Diff utility.** None in this repo. Pi depends on `diff@8.0.4` but it is not a declared
  dependency here. `checks.ts` has its own LCS diff (`diffLines`), so no new dependency is needed.
- **`ctx.cwd` in the analyzer.** Yes: `analyze(ctx, …)` receives the `ExtensionContext`, which
  has `cwd` (Pi `ExtensionContext.cwd`), and already uses it for `loadSystemPrompt(ctx.cwd)`.
- **Config fallback.** The brief says config is read from `.pi/supervisor-config.json` with a
  fallback to a global file. There is no global config file today, and `loadGlobalModel()` reads
  `process.cwd()`, not `ctx.cwd` (`saveGlobalModel` does take `ctx.cwd`). A fallback to
  `~/.pi/agent/supervisor-config.json` would be new; it reads `~/.pi` but does not write it.

### Upstream behaviour that conflicts with ledger mode (not listed in brief 5.6)

1. **Supervision is cleared whenever a session loads idle** (`src/index.ts:136-140`) and after an
   idle compaction (`src/index.ts:173-179`). Ledger mode is meant to persist across sessions and
   compactions, so both teardowns need to be skipped when `mode === "ledger"`.
2. **Supervision requires a goal.** `state.start(outcome, …)` and `/supervise <goal>` are the only
   entry points, and they send "Please start working on this goal" to the agent. Ledger mode has
   no goal. I propose `mode: "ledger"` in config activates the monitor on `session_start`
   without an outcome or a kickoff message.
3. **The supervisor session is reused, not fresh.** `SupervisorSession` keeps one in-memory Pi
   session across analyses "for token efficiency" (`supervisor-session.ts:1-4`). The reviewer
   needs a fresh session per review, so it needs its own session object, disposed after each call.
4. **No thinking level is set** for the supervisor session. `createAgentSession` accepts
   `thinkingLevel`, so `reviewer.thinking` is supported.
5. **The supervisor sees pre-compaction history.** `extractMessages` walks `getBranch()` and keeps
   every `message` entry, ignoring compaction entries. The agent sees the summary; the upstream
   supervisor sees the raw history. Ledger mode does not use this path.

### Issues found in the provided modules

`checks.ts` and `register.ts` type-check under this repo's strict settings. A smoke run of edge
cases (scratch script, not committed) found:

1. **D3 fires on every legitimate check resolution.** `MEMENTO.template.md` writes status inline
   (`- C1: … — status: pending`) and `AGENTS.snippet.md` says to resolve Checks "with a status".
   Changing `pending` to `passed (R4)` edits an existing line, so `lockedSectionsChanged` reports
   `Checks (locked, …)`. Confirmed by running it. Either the status goes on a new appended line
   (`- C1 status: passed (R4)`), or D3 ignores a change confined to the trailing `status:` field.
   `onBreakpoint` ("a Checks item changed status") depends on the same choice.
2. **D2 false positive on the first turn.** `buildLedgerBlock` returns `changedSincePrevious: null`
   when there is no previous hash; `ledgerClaimMismatch` takes a boolean, so `null` is falsy and
   a turn that claims a change returns `LEDGER_CLAIMED_NO_CHANGE`. Confirmed by running it.
   The call site must skip D2 when the value is `null`.
3. **D2 blames the agent for the human's edits.** The previous hash is stored at the end of a
   turn. If Boris edits `MEMENTO.md` between turns, the next turn sees a change the agent did not
   make. Fix: take the ledger hash in `before_agent_start`, as D4 does for model files.
4. **D1 misses common formats.** `**Ledger:** unchanged` is not recognised (false
   `LEDGER_LINE_MISSING`); `Ledger: unchanged — nothing new` counts as a claimed change.
5. **Suppression is keyed on line numbers.** `suppressionKey` uses `concept|file:line`. Any edit
   above the flagged line shifts the number, so an `intended` flag comes back. The acceptance test
   "intended suppresses re-flagging including reversed locations" passes for swapped locations
   but not for shifted lines. Keying on normalised quotes (with file) would hold.
6. **`dismiss` also suppresses permanently**, same as `intended`. The brief only says `intended`.
7. **`snapshotFiles` ignores `files.ignore`.** It skips only `node_modules` and `.git`, walks the
   whole tree every turn (e.g. `renv/`), and silently skips files over 400 kB.

I will fix 1–4 and 7 in deliverable 3 and 5–6 in deliverable 4 unless told otherwise, extending
the modules rather than rewriting them.

## Addition from Boris: proposing edits to a compaction summary

Request: where needed, the supervisor proposes edits to a compaction summary to remove or annotate
stale information. Treated as a proposal Boris accepts, consistent with "flags to you, no steering".

What Pi 1.0.0 allows (from type declarations and `session-manager.js` / `agent-session.js`):

- **`context_edit` cannot target a compaction entry.** `SessionManager.appendContextEdit` accepts
  only `custom_message` entries and `user`/`assistant`/`toolResult` messages. It can annotate or
  omit stale messages in the retained range after the summary.
- **`session_before_compact` can supply the summary.** It receives `preparation`
  (`messagesToSummarize`, `previousSummary`, `firstKeptEntryId`) and may return
  `{ compaction: { summary, firstKeptEntryId, tokensBefore, details } }`. Pi exports `compact()`
  and `generateSummary()`, so the extension could generate the normal summary and edit it before
  it is stored. Threshold and overflow compactions happen mid-run, so a human accept/reject
  dialog here would block the agent.
- **A replacement compaction can be appended later.** At the `turn_end` and `agent_before_settle`
  boundaries an extension may return `entries: [{ type: "compaction", summary, firstKeptEntryId }]`.
  The newest compaction wins, and an older one inside the retained range contributes nothing
  (`buildSessionProjection`). Re-using the previous `firstKeptEntryId` re-states the summary
  without dropping retained messages. This only works during an agent run, not while idle.
- **The `context` event can rewrite the summary per request.** It receives the outgoing messages,
  including the `compactionSummary` message, and may return replacements. That takes effect from
  the next model call even when accepted while idle, but is not written to the session file.

Proposed design (for Boris to confirm):

1. After `session_compact`, the reviewer (or a code-only pass) compares the new summary with
   `MEMENTO.md`: statements matching a `## Crossed out` item, or contradicting an Assumption,
   Decision or Observed item, become a `SUMMARY_STALE` flag carrying a proposed edit
   (strike, or annotate "refuted by R9, see MEMENTO X1"), with quotes verified like other flags.
2. `/flag <id> accept` stores the edit in supervisor state. The `context` handler applies it from
   the next request; at the next boundary the edited summary is also persisted as a replacement
   compaction entry so it survives restarts. Nothing is applied without acceptance.
3. Same mechanism, optional: proposed `context_edit` annotations for stale retained messages.

Conflict with the brief: none with the "flags, no steering" rule, since nothing happens without
acceptance. It does widen section 2: the plugin would change what the agent sees, which the
brief does not otherwise do. Raised as an open question below.

## Open questions for Boris (brief section 10 plus orientation)

1. Reviewer provider credentials available in Pi (brief).
2. `maxModelFileChars` (brief).
3. `onBreakpoint` on `Crossed out` additions (brief).
4. `FLAGS.md` under `.pi/` or committed (brief).
5. D3 vs. Checks status: status on a new appended line, or D3 tolerates a `status:` change?
6. Ledger mode activation: start automatically on `session_start` when config says
   `mode: "ledger"`, with no goal and no kickoff message?
7. Compaction-summary edits: accept the design above, and should the code-only check
   (summary text matching a `Crossed out` item) be allowed to propose without a reviewer call?
