# pi-ledger: implementation notes

Working notes for `brief/DESIGN_BRIEF.md`. Deliverables 1 to 8 below were built as "ledger
mode" inside the pi-supervisor fork; the split into the standalone pi-ledger and the
simplification after it come first. Older sections keep their original paths (`ledger-mode-brief/`, `examples/ledger-mode/`,
`/supervise register`); the first two are now `brief/` and `examples/project/`, the register is gone.

## Simplification (2026-10-04, after the split)

Boris asked whether the plugin could be simpler, taking the PC run's view on what earned its
complexity. The source went from 16 files in `src/ledger/` and `src/ui/` to seven in `src/`:
`index.ts`, `config.ts`, `monitor.ts` (was checks, monitor, status), `reviewer.ts` (was
reviewer, prompts), `flags.ts` (new; the flag half of the old register and flags-file),
`model-session.ts` (was model-session, model-call) and `runtime.ts` (was runtime, state,
commands). Defaults taken without asking:

- **Dropped the concept register** (`register.ts`, `/ledger register`, `.pi/model-register.md`,
  `syncFromSpec`, register edits in the reviewer output). It mostly restated the spec, caused
  the stale-label and review-loop fixes below, and needed its own merge logic. The reviewer now
  reads `MODEL_SPEC.md` fresh and names concepts by its current `## P<n>` heading; flags are
  matched by that P-id (`conceptKey`), by evidence, or by overlapping locations
  (`LINE_SLACK` = 3). A spec rename therefore needs no migration.
- **Dropped `runs.jsonl` and the run recorder.** Nothing read it; run ids in the ledger are the
  agent's own (`R<n>`), checked only by the status line's "passed needs a run id" rule.
- **Dropped `turnModel`** (the optional per-turn model call) and its prompt. Off by default and
  never used in a run.
- **Dropped the injection regex.** It only caught text addressed to "the supervisor"; the
  reviewer handles that as type 0. Fixture variant 9 now expects no monitor finding.
- **Dropped the model picker and `/ledger model`** (`src/ui/*`). Set `reviewer.model` in the
  config. The reviewer falls back to the chat model when unset.
- **Kept D5 (CJK ratio)** because GLM models drift into Chinese, which was the reason for adding
  it; it costs a dozen lines.
- **Triggers fixed in code: edit, before_compaction, command.** `edit` fires when the turn
  changed a model file or `MODEL_SPEC.md` changed after its first sighting. Breakpoint and
  backstop triggers, cooldowns and the `triggers` config block are gone. A review cannot
  trigger another one because a turn without edits never reviews.
- **`/flag <id> close [reason]`** replaces `intended` and `dismiss`, which were the same action.
  Both old words still work as aliases. Statuses are `open`, `sent`, `closed`.
- **Compaction note reworded**: it lists summary statements that _differ_ from the ledger and
  says to check which is current, since the ledger can be behind. The prompt's key is
  `differs`; replies under the old `stale` key are still accepted.
- **Model files:** top-level `*.{R,stan}` added to the default `modelFiles`; `**/archive/**`
  added to `ignore`, and the AGENTS snippet says retired code goes under `archive/` with its
  `@concept` tags removed.
- **Config trimmed** to `autoEnable`, `reviewer {model, fallbackModel, thinking}` and
  `files {ledger, spec, modelFiles, ignore}`. Locked headings, the CJK threshold and the 120k
  model-file cap are constants. Unknown keys in old configs are ignored.
- **State:** the session entry names stay (`supervisor-ledger-state`,
  `supervisor-compaction-note`) and the state is now version 2. `restoreState` migrates a
  version 1 entry, turning register flags into flat flags (`intended`/`dismissed` → `closed`),
  so Boris's paused PC session resumes.
- **Testing seam:** `sessions.create` in `model-session.ts` is injectable, so tests replace the
  in-memory session without module mocks.
- Tests: 8 files, 68 pass (the register and flag-fix tests were replaced by
  `tests/ledger-flags.test.ts`); prettier clean; the offline Pi probe passes.

The sections below describe the plugin before this change. Where they mention the register,
`runs.jsonl`, `turnModel`, `/ledger model`, `intended|dismiss` or `src/ledger/*` paths, those
no longer exist.

## Split into pi-ledger (2026-10-04)

Boris decided on one plugin with one job (integrity), goal mode removed rather than switched
off, no `/supervise`. Defaults taken without asking, per his preference:

- **Same repository, new package name.** `package.json` is now `pi-ledger` 0.1.0, built on a
  branch of `BorisVSchmid/pi-supervisor`. Renaming the GitHub repository (or moving to a new one)
  is Boris's call; `repository`/`homepage` point at the current repo until then. `LICENSE` keeps
  the upstream MIT notice unchanged.
- **Removed:** `src/core`, `src/state`, `src/compaction`, `src/session/client.ts` and
  `response-parser.ts`, `src/ui/renderer.ts`/`animations.ts`/`types.ts`, `src/fabric-provider.ts`,
  `src/subagent-detector.ts`, `src/types.ts`, `src/global-config.ts`, the `start_supervision` tool,
  `media/` (the upstream demo), and their tests. Kept: the in-memory model session (moved to
  `src/ledger/model-session.ts`, class `ModelSession`) and the model picker (`src/ui/model-*`).
- **Commands:** `/ledger [status] | on | off | register | metrics | model`, `/review`, `/flag`.
  `register` and `metrics` moved from `/supervise`. `model` replaces `/supervise model` and writes
  `reviewer.model`. `/review` refuses while the ledger is off; `/flag` works either way.
- **On/off:** on at session start when `files.ledger` exists (`autoEnable`, default true),
  otherwise off. `/ledger on|off` is stored in the session state (`enabled`) and wins over
  `autoEnable` on reload. Off means no monitor, no reviewer, no run log, no status line.
- **Status line** (`src/ledger/status.ts`, Pi `ctx.ui.setStatus('ledger', …)`): Acceptance items
  are `- AC<n>: …` under `## Acceptance`; an item is passed only when its last `AC<n> status:`
  line (anywhere in the ledger) says passed and cites `R<n>`. The convention mirrors the
  existing `C1 status: passed (R4)` for Checks and is added to the MEMENTO template and AGENTS
  snippet. "ledger behind" means the last turn had a D1/D2 finding; this needed one new state
  field, `lastTurnFindings`, set in `runtime.onSettled`. The line refreshes after each turn,
  `/flag`, `/ledger on|off`, and when a background review finishes.
- **Config:** `.pi/ledger-config.json`, then `<agentDir>/ledger-config.json`; at each location
  the legacy `supervisor-config.json` is read if the new file is absent, and its old top-level
  `model` becomes `reviewer.model` when that is unset. `mode` and `upstream` keys are gone (and
  ignored if present). `reviewer.model: null` now means the chat model (there is no separate
  supervisor model any more).
- **Session entry types kept:** `supervisor-ledger-state` and `supervisor-compaction-note` keep
  their names so sessions started under the fork still load.
- **Renamed directories:** `ledger-mode-brief/` to `brief/`, `examples/ledger-mode/` to
  `examples/project/`, example config to `ledger-config.json`.
- **CI:** `.github/workflows/test.yml` now also triggers on `master` (it only listed `main`, so
  it never ran). It still uses `bun install --frozen-lockfile`; the lockfile's root name was
  updated to `pi-ledger`, but bun here cannot read the lockfile, so whether CI installs cleanly is
  untested.
- **CREDITS.md** is Boris's longer version (the "How it differs" sections), reworded where it
  described ledger mode as a mode of pi-supervisor, with one factual fix: the compaction
  paragraph said `beforeCompaction` asks the agent for a ledger update; the code starts a
  background review instead. The research citations are as corrected on master (PR #3).
  It still mentions an "optional anchor re-injection" that is not implemented.
- **Not done:** no live Pi run of the split plugin yet (tests and the offline Pi probe only).

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

| Brief says                        | Source says                                                                                                                                                 |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supervisor decides in `agent_end` | Idle decision is in **`agent_settled`** (`src/index.ts:232`). README line 122 still says `agent_end`; the README is stale. `agent_end` is not used.         |
| `session_start`                   | Used, registered **twice** (`src/index.ts:145-149`); the first handler runs on every reason, so the second is redundant.                                    |
| `before_agent_start`              | Used only to bump `userInputEpoch` (`src/index.ts:89`).                                                                                                     |
| `tool_call`                       | **Not used** anywhere. Exists in Pi (`ExtensionAPI.on("tool_call")`); bash calls arrive as `BashToolCallEvent` with `toolName: "bash"` and `input.command`. |
| `turn_end`                        | Used for mid-run analysis, gated on `detectMidRunSignals` (`src/index.ts:201-229`).                                                                         |
| `session_before_compact`          | Used only to persist state (`src/index.ts:153`).                                                                                                            |

Recommendation: run the ledger monitor in `agent_settled`, as upstream does. Pi documents it as
firing once after retries, overflow compaction and queued follow-ups are done, so D1–D5 see the
final assistant text once per user prompt. `agent_end` can fire for a run that is then retried.

### Role → file map

| Role                               | Where                                                                                                                                                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle analysis + steer/done routing | `src/index.ts:232-337` (`agent_settled`)                                                                                                                                                                         |
| Mid-run analysis                   | `src/index.ts:201-229` (`turn_end`), signals in `src/state/mid-run-signals.ts`                                                                                                                                   |
| Supervisor input assembly          | `src/core/analyzer.ts` → `src/compaction/index.ts` (`extractMessages`, `buildCompactionSummary`, `formatForSupervisor`) → `src/core/prompt-builder.ts` (`buildUserPrompt`)                                       |
| System prompt                      | `src/core/prompt-loader.ts`: `<cwd>/.pi/SUPERVISOR.md`, then `~/.pi/agent/SUPERVISOR.md`, then the built-in prompt                                                                                               |
| Model call                         | `src/session/client.ts` → `src/session/supervisor-session.ts` (in-memory `createAgentSession`, `tools: []`, providers delegated to the parent registry)                                                          |
| Response parsing                   | `src/session/response-parser.ts` (`parseDecision`; invalid JSON → `continue`)                                                                                                                                    |
| State                              | `src/state/manager.ts`, type `SupervisorState` in `src/types.ts`                                                                                                                                                 |
| Persistence                        | `pi.appendEntry('supervisor-state', state)` on every change; `loadFromSession` takes the last such custom entry on the active branch (`src/state/manager.ts:110-129`)                                            |
| Reframe tier increment             | `src/index.ts:264-267`: `detectIneffectivePattern()` → `escalateReframeTier()`. `detectIneffectivePattern` (`src/state/patterns.ts`) also fires on 60 s without a steer, so the tier climbs on stagnation alone. |
| Reframe guidance text              | `src/core/reframe.ts`, injected by `buildUserPrompt`                                                                                                                                                             |
| `done`                             | Schema in `src/types.ts:37`, parser accepts it, handled at `src/index.ts:314-320` (stops supervision)                                                                                                            |
| Config                             | `src/global-config.ts`: only `model: {provider, modelId}`, read from `join(process.cwd(), '.pi/supervisor-config.json')`                                                                                         |

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

## Decisions taken (2026-10-04)

Boris asked me to proceed on my own defaults rather than answer the detailed questions:

1. Checks status is recorded on a new appended line (`- C1 status: passed (R4)`); D3 stays strict.
2. `mode: "ledger"` in config activates the monitor on every session start, with no goal and no
   kickoff message.
3. Compaction-summary edits follow the design above; a code-only check may propose an edit.
4. Reviewer model: unset by default (falls back to the supervisor model); configure when known.
5. `maxModelFileChars` 120k; `onBreakpoint` does not fire on `Crossed out` additions; `FLAGS.md`
   lives under `.pi/`.

Correction to the compaction section: any extension can write the summary itself through
`session_before_compact` (Pi ships `examples/extensions/custom-compaction.ts`, which replaces the
summary with its own). What Pi cannot do is edit an existing summary in place with
`context_edit`. Ledger mode therefore has two routes: annotate at compaction time (generate the
normal summary, then append a stale-items note drawn from `MEMENTO.md`), and propose edits to an
existing summary for acceptance as described above.

## Deliverable 2: config and mode switch

- `src/ledger/config.ts`: `LedgerConfig` with every key from the example config plus
  `compaction.proposeSummaryEdits`; `loadLedgerConfig(cwd)` reads `<cwd>/.pi/supervisor-config.json`,
  else `<agentDir>/supervisor-config.json`; type-checked merge over defaults; unknown modes fall
  back to `goal`.
- `src/index.ts`: config loaded on each session load; ledger mode shows a notice. No other
  behaviour changes in either mode.
- `tests/ledger-config.test.ts`: 6 tests. Suite: 15 files, 212 tests pass; `tsc` clean.

## Deliverable 3: monitor

- `src/ledger/checks.ts`: the provided module, formatted to repo style, with fixes: D1 accepts
  `**Ledger:**` and "unchanged — reason"; D2 returns no mismatch without a baseline;
  `snapshotFiles` honours `files.ignore`.
- `src/ledger/monitor.ts`: pure `evaluateTurn` (D1, D2, D3, D5, injection) and `routeFindings`
  (templated steers from brief 5.4, never repeated per `(kind, ledger hash)`).
- `src/ledger/runtime.ts`: baseline (MEMENTO.md + model snapshot) at `before_agent_start`, so
  edits made by the human between turns are not attributed to the agent; `tool_call` appends run
  commands to `runs.jsonl`; `agent_settled` runs the monitor, steers or notifies, writes FLAGS.md.
- `src/ledger/state.ts`: ledger state persisted as a `supervisor-ledger-state` custom entry.
- D4 keeps the last turn's diff in memory; the reviewer (deliverable 5) diffs against a snapshot
  taken at the last review instead of accumulating per-turn hunks, so line numbers stay correct.
- `ledger-mode-brief/` is excluded from prettier so the brief stays verbatim and CI's
  `format:check` passes.
- Tests: `tests/ledger-monitor.test.ts` (17). Suite: 16 files, 229 tests pass; `tsc` clean.

## Deliverable 4: register and commands

- `src/ledger/register.ts`: the provided module with two changes. Concept names resolve onto
  existing keys (same `P<n>` id, or same name ignoring case), so "P1 transmission" from the
  reviewer and "P1 Transmission" from the spec are one concept. Suppression is keyed on concept
  plus file and normalised quote on each side, so `intended` survives shifted lines and swapped
  sides; changed evidence is a new question. `dismiss` still suppresses the same evidence.
  Added `specStatements` for seeding.
- Register persisted in ledger state; exported to `files.register` on every change.
- `/flag`, `/flag <id>`, `/flag <id> intended|dismiss [reason]`, `/flag <id> send` (templated
  steer via `steerTextFor`, the only way a reviewer flag reaches the agent).
- `/supervise register` and `/supervise metrics`, intercepted only in ledger mode.
- Spec seeding on session start from `## P<n>` headings in `MODEL_SPEC.md`.
- Tests: `tests/ledger-register.test.ts` (6). Suite: 17 files, 235 tests pass.

## Deliverable 5: reviewer and compaction note

- `src/ledger/reviewer.ts` (pure): input builder in the brief's block order, `[Model Files]` with
  line numbers (smallest files whole, largest truncated, with a note), `[Model Edits]` diffed
  against the snapshot of the last review (`.pi/supervisor-review-snapshot.json`), agent summary
  labelled as a claim; JSON extraction; shape checks; verification; triggers.
- Verification: a `file:line` side verifies if the quote is in that file within 5 lines of the
  cited line (this covers both changed and unchanged files, which `locInHunks` alone would not);
  `MEMENTO.md#…` and `MODEL_SPEC.md#…` sides verify against those files. Failed flags and register
  edits are dropped and counted. A reviewer `stated` edit is stored as `reviewer (<source>)`, so a
  model cannot overrule the spec or the human.
- `src/ledger/model-call.ts`: fresh in-memory session per call, disposed afterwards, with
  `reviewer.thinking`; fallback model on unavailability or failure; one retry on invalid JSON,
  then fail open. `reviewer.model: null` uses the supervisor model, then the chat model.
  `maxTokens` is not passed: `createAgentSession` has no such option.
- `src/session/supervisor-session.ts`: optional `thinkingLevel` argument (goal mode unchanged).
- Triggers after each turn, at most one review per turn and one at a time, run in the background:
  `register_change` (hunk contains `@concept` or overlaps a recorded realization, or the last
  review grew the register), `breakpoint` (`## Next` or `## Checks` changed), `backstop`
  (unreviewed model edits and N turns since the last review). `before_compaction` starts a review
  in the background without delaying compaction. `/review [note]` runs one on demand.
- Compaction note (agreed design): after `session_compact`, the reviewer model sees only the new
  summary, `MEMENTO.md` and `MODEL_SPEC.md` (`COMPACTION_NOTE_PROMPT`). Items whose summary quote
  and ledger quote both verify become one `supervisor-compaction-note` custom message placed after
  the summary. The summary is not changed. Off with `compaction.annotateSummaries: false`.
- Prompts embedded in `src/ledger/prompts.ts` (REVIEWER and LEDGER_TURN verbatim from the brief);
  a project can override each with `.pi/REVIEWER.md`, `.pi/LEDGER_TURN.md`, `.pi/COMPACTION_NOTE.md`.
- Fixture: `tests/fixtures/ledger/` (base R SEIR model plus the nine seeded variants).
  `scripts/ledger-fixture.sh <variant> <dir> [provider/model]` materialises one for a live run.
- Tests: `tests/ledger-fixture.test.ts` (19), `tests/ledger-model-call.test.ts` (4). Suite: 19
  files, 258 tests pass.

### Reviewer evaluation (model-dependent; not run here)

No model credentials are available in this environment, so the reviewer criteria of brief
section 8 have not been measured. Manual procedure, per model and per variant 1–5, three runs:

1. `scripts/ledger-fixture.sh <variant> /tmp/fx-<variant> <provider/model>`
2. `cd /tmp/fx-<variant> && pi` (with this extension installed), then `/review`.
3. Record from `.pi/FLAGS.md` and `/supervise metrics`: whether the seeded inconsistency is
   flagged (and with which type), other flags (false flags), `review.flags_dropped_unverified`,
   and whether the restatement in FLAGS.md matches the fixture's intended model.
4. Run `base` the same way: every flag there is a false flag.

## Deliverable 6: upstream switches

In ledger mode the goal-mode model analysis does not run at all, which covers every item in
brief 5.6 at once:

- `agent_settled`: the ledger monitor runs, then the handler returns. No `analyze()` call, so
  no `done`, no steer at idle (including the "Please continue" fallback on analysis errors), and
  `escalateReframeTier` is never reached.
- `turn_end`: returns immediately (mid-run analysis off).
- `/supervise <goal>`, `/supervise` (inferred goal) and the `start_supervision` tool refuse with
  a short explanation. `/supervise stop|widget|model|register|metrics` still work.
- `[Session Goal]`, `[Current Status]`, `[Earlier Turns]` are never built, because the goal
  prompt is never built.
- The `upstream.*` config keys are kept for compatibility with the example config; with the
  analysis path off they have nothing to switch.
- Goal mode is unchanged (covered by a test that runs the same events in goal mode).
- Tests: `tests/ledger-mode-switches.test.ts` (3), loading the full extension. Suite: 261 pass.

## Deliverable 7: optional turnModel

- Off by default (`turnModel: null`); no model call per turn unless set.
- When set: after each turn, one background call with `LEDGER_TURN_PROMPT` and
  `[Ledger File] [Ledger Diff] [Turn] [Model Edits]`; `[Turn]` is the last user message and the
  assistant's visible reply (no reasoning, no tool output). Only the four kinds in the prompt are
  accepted; the quote must be in the turn or the added model lines, and a ledger quote in the
  ledger. Survivors are `TURN_FINDING` notices (never steers), deduplicated.
- Tests: 2 in `tests/ledger-fixture.test.ts` (variant 6). Suite: 263 pass.

## Deliverable 8: docs

- README: "Ledger mode" section, `src/ledger/` in the project structure, and the stale
  `agent_end` reference corrected to `agent_settled`.
- `examples/ledger-mode/`: config (with `compaction.annotateSummaries`), `MEMENTO.md`,
  `MODEL_SPEC.md`, `AGENTS.snippet.md` and a short README. The MEMENTO template and AGENTS snippet
  differ from the brief's in one place: a check is resolved by appending
  `- C1 status: passed (R4)` rather than editing the line, so D3 stays strict (decision 1 above).
  The snippet also tells the agent how to read the post-compaction supervisor note.

## Not done or not verified

- Reviewer quality (brief section 8, model-dependent criteria) is not measured: no model
  credentials here. Procedure under "Reviewer evaluation" above.
- Not run inside a live Pi session. All hooks are exercised through tests against the Pi 1.0.0
  type declarations, with Pi's session and model layers mocked.
- `reviewer.maxTokens` is not applied (`createAgentSession` has no option for it).

## Fixes after the first live run (2026-10-04, Pi 1.0.0, master at 2080657)

The live run on Boris's PC showed four problems. Defaults chosen, no questions asked:

1. **Flag flood** (31 open flags in 13 turns, one issue raised 5-7 times).
   - `[Model Register]` now starts with `openFlags` (id, concept, type, status, locations and the
     question) and `resolved` (intended/dismissed with the human's reason). These are never
     truncated; only the concept map is cut to `maxChars`. Before, open flags came after the
     concepts, had no question text and were usually cut off.
   - `REVIEWER_PROMPT` tells the reviewer not to raise again what `openFlags` or `resolved` cover,
     and to set `"same_as": "F3"` when it repeats an open flag with changed evidence.
   - Code-side merge (`addFlagResult`): a new flag is a repeat of an open or sent flag when the
     concept resolves to the same key and every location of the flag with fewer sides is at a
     location of the other (same `#` anchor, or same file with line ranges within 3 lines).
     A repeat adds nothing; it bumps `repeats` on the existing flag, shown in FLAGS.md and the
     register as "raised again N×". A `same_as` naming an open flag counts as a repeat.
   - Against intended/dismissed flags only the exact quote-based suppression key applies, as
     before: changed evidence at the same place is a new question for the human. A `same_as`
     naming a resolved flag is ignored for the same reason.
2. **Review loop.** `register_change` no longer fires on "the last review grew the register"
   alone (almost every review adds a realization). It now needs an edit this turn: a model-file
   hunk that touches a registered concept, any model-file hunk after the register grew, or a
   change to `MODEL_SPEC.md`. Breakpoint and backstop triggers are unchanged.
3. **Stale concept label.** `syncFromSpec` renames a register key whose `P<n>` id now has a
   different spec heading, together with its flags and suppression keys, then applies the
   spec's stated values. It runs at session start, before every review, and after any turn in
   which `MODEL_SPEC.md` changed (tracked by `specHash` in the ledger state; the first sighting
   is not counted as a change). A rename is shown as a notice and FLAGS.md is rewritten.
4. **Flag visibility.** The notice after a review lists up to three new flags (id, concept,
   question clipped to 140 chars), "…and N more", and the open flags raised again. Flags still
   reach the agent only through `/flag <id> send` (the brief routes model-judged findings to
   the human).

Side effect: because the spec is now applied before each review, a spec statement always wins
over a reviewer-stated value for the same concept (one fixture test updated accordingly).
Tests: `tests/ledger-flag-fixes.test.ts` (13). Suite: 276 pass.

## Ledger file renamed to LEDGER.md (2026-10-04)

The ledger file is `LEDGER.md` (archive `LEDGER.archive.md`); the templates, example, fixtures and
prompts follow. Earlier sections of these notes keep the old name `MEMENTO.md`. The format had
diverged from ruslanlap/memento enough that the files are not interchangeable, so the old name is
not read as a fallback: `legacyLedgerNotice` (src/config.ts) shows a one-line rename notice at
session load when only `MEMENTO.md` exists. A config that sets `files.ledger` explicitly still wins.
