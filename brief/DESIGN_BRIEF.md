# Design brief: pi-ledger

*Surely You're Joking.*

For the Claude Code project building pi-ledger. This brief is the source of
truth for scope and design.

pi-ledger began as a "ledger mode" inside a fork of monotykamary/pi-supervisor
and is now a standalone Pi extension derived from it (decision of 2026-10-04,
section 3). It keeps the fork's infrastructure (separate in-memory model
session, session-file persistence, hooks, model picker) and has none of its
goal logic. Upstream mergeability is given up.

Upstream facts the original brief relied on (verified during orientation; the
goal-specific parts no longer exist in this repository):
- Pi extension with hooks `session_start`, `before_agent_start`, `tool_call`,
  `turn_end`, `agent_end`, `session_before_compact`.
- Supervisor runs in a separate in-memory Pi session; input built by an
  algorithmic compaction pipeline (`src/compaction/*`) that strips thinking
  and collapses tool calls; `SUPERVISOR.md` overrides the system prompt;
  state persisted in the Pi session file; 4-tier reframe escalation;
  JSON `{action, message, reasoning, confidence}`; steering injected as a
  user-voice message.

---

## 1. Purpose

The working agent (currently GLM 5.3) runs long exploratory research sessions
in Pi: building and extending epidemiological and ecological models, fitting
them, and judging whether results make sense. Drift in direction is allowed
and expected. Two things must not drift silently:

1. **The ledger.** `MEMENTO.md` is the record of what is assumed, decided,
   predicted, observed and refuted, with evidence. It must keep up with the
   conversation, and claims in it must be true.
2. **The model's coherence.** Parts that are individually valid can encode
   two different ideas of the same thing (density-dependent transmission in
   one place, frequency-dependent in another; an external hazard and an
   explicit external compartment for the same infection source; seasonality
   both as a forcing term and inside an abundance input). This is the error
   class the plugin exists to surface.

The plugin flags; the human decides. It never pushes the agent toward
finishing, narrowing or changing course.

**One plugin, one job.** pi-ledger does integrity: keep the ledger and the
model honest. It is meant to be on for the whole of a research session.
Convergence (keeping the agent going until something is done) is a different,
situational job that belongs to a loop driver such as pi-autoresearch,
pi-multiloop's research mode, or upstream pi-supervisor. The definition of done
lives in the ledger as Aim plus Acceptance and is shared by both jobs:
pi-ledger reports the Acceptance status as a fact (status line, section 5.2),
never as a judgment, and never acts on it. Running a loop driver next to
pi-ledger, with both injecting steers, is untested.

## 2. Non-goals

- No goal-completion supervision, no `done`, no reframe escalation, no idle
  nudges, no iteration control. These are a loop driver's job (section 1).
- No "task" or "explore" sub-modes and no mode switch.
- No running of tests, simulations or analyses. Checking by execution is a
  separate tool outside this plugin.
- No judgment of scientific direction or quality.
- No reading of reasoning traces or tool outputs. The plugin sees
  visible text, the ledger, the spec and the model source files.
- No automatic steering on anything a model judged. Only two deterministic
  findings may steer the agent without a human decision.

## 3. Decisions and why (do not relitigate without new evidence)

| Decision | Reason |
|---|---|
| Per-turn monitor is code-only; no model call by default | The per-turn checks that matter are mechanical. Small models judge purpose-level mismatches poorly; their self-reported confidence is not usable as a threshold. |
| Conceptual review is done sparsely by a capable model, in a fresh context, with extended thinking | Purpose-level inconsistency detection needs capability and a whole-model view; monitors catch more with more reasoning; models catch far more errors in work presented as someone else's than in their own context. |
| Reviewer should preferably be a different model family from the agent | Judges favour their own lineage; models across families converge on the same blind spots. |
| The reviewer sees artefacts (spec, ledger, model files, diffs), with the agent's own summary labelled as a claim | Agents misreport their own edits at high rates and reasoning traces are not faithful; the artefact is the evidence. |
| Model-file changes are captured by snapshot and diff, not from tool-call inputs | Tool inputs are what the agent asked for, not what happened; they lack line numbers and miss edits made via shell or scripts. |
| Every finding must quote; code verifies quotes and locations; unverifiable findings are dropped | LLM inconsistency finders have low precision; verification removes invented evidence. |
| All reviewer flags go to the human as questions; steering only on `/flag send` | Steers arrive in the user's voice, which is the pressure that makes models abandon correct work; many "inconsistencies" are deliberate. |
| Only `LEDGER_LINE_MISSING` and the claim-vs-hash mismatches auto-steer, with templated text, never repeated | These are facts, not judgments; repetition drives oscillation. |
| Acceptance and Checks sections are append-only; edits are flagged | Prevents the agent from redefining success after seeing results. |
| Superseded claims live in an archive, one-line tombstone in the ledger | Old values in context keep winning over updates. |
| Register is updated by small edits, never rewritten | Monolithic rewriting collapses accumulated context. |
| A standalone extension with one job (integrity), not a mode of pi-supervisor (2026-10-04) | The two designs share infrastructure, not purpose: one drives the agent toward a goal, the other refuses to. A mode switch made every code path conditional, doubled the tests and gave `/supervise` two meanings. |
| Completion is visible but not acted on: the status line reports Acceptance from the ledger | Gives the human completion visibility without a model judging "done" and without steering. |

## 4. Architecture

```
per turn (agent_end)                         sparse (reviewer triggers)
──────────────────────                       ───────────────────────────
monitor: code only                           reviewer: capable model, fresh session
 D1 Ledger line present      → steer          input: [Model Spec] [Model Register]
 D2 claim vs ledger hash     → steer                 [Ledger] [Model Files]
 D3 locked sections edited   → notify                [Model Edits] [Agent Summary]
 D4 model files changed      → snapshot diff  output: flags (types 0–10, quotes, argument,
 D5 CJK ratio                → notify                 question), register edits, restatement
 D6 run commands → runs.jsonl                 all quotes/locs verified in code; else dropped
 (optional turnModel: 4 narrow ledger checks)        → .pi/FLAGS.md + notice + register export
```

Human commands: `/ledger [status]`, `/ledger on|off`, `/ledger register`,
`/ledger metrics`, `/ledger model`, `/review [note]`, `/flag` (list),
`/flag <id> intended|dismiss [reason]`, `/flag <id> send`. There is no
`/supervise` and no frame argument: the frame is the ledger's Aim.

## 5. Components

### 5.1 New modules (provided in `src-additions/`, pure, type-checked, tested)

- `src/ledger/checks.ts`: `parseLedgerLine`, `ledgerClaimMismatch`,
  `lockedSectionsChanged`, `snapshotFiles`, `diffSnapshots`, `renderHunks`,
  `locInHunks`, `cjkRatio`, `verifyQuote`, `matchesAny`, `buildLedgerBlock`.
- `src/ledger/register.ts`: concept-level `Register` (stated meaning +
  realizations across layers code/prior/data/interpretation/ledger/spec/text),
  `applyEdits`, `disagreements`, `addFlag`/`resolveFlag` with suppression,
  `steerTextFor`, `renderRegister`, `registerForPrompt`.

Use them as-is; extend rather than rewrite.

### 5.2 Monitor (per turn)

In `agent_settled` (Pi 1.0's settled hook; see NOTES.md), when the ledger is on:

1. Build the ledger block (`buildLedgerBlock` with `previousLedgerHash`).
2. D1: `parseLedgerLine(lastAssistantVisibleText)`; missing → `LEDGER_LINE_MISSING`.
3. D2: `ledgerClaimMismatch(line, block.changedSincePrevious)`.
4. D3: `lockedSectionsChanged(previousLedgerText, block.content, lockedHeadings)`.
5. D4: `after = snapshotFiles(cwd, modelFiles)`; `diff = diffSnapshots(before, after)`
   where `before` was taken in `before_agent_start`. Store `diff` for the
   reviewer; store `after` as the next `before`.
6. D5: `cjkRatio` on the assistant text and on the ledger diff.
7. Route (section 7). Then store `previousLedgerHash/Text`.

Status line (after every turn, review and `/flag` answer), computed, never
judged, shown with Pi's `setStatus`:

    Acceptance 1/3 passed · 2 open flags · ledger current

- Acceptance: items are `- AC<n>: …` bullets under `## Acceptance`. An item is
  passed when the last `AC<n> status: …` line anywhere in the ledger says
  `passed` and cites a run id (`R<n>`); `passed` without a run id stays open.
  No Acceptance section reads `no Acceptance`.
- Flags: open reviewer flags.
- Ledger: `ledger current`, `ledger behind` (a D1/D2 finding on the last turn),
  `locked section edited` (D3), `ledger not checked yet`, or `no MEMENTO.md`.
- `reviewing…` while a review runs.

On/off: on at session start when the ledger file exists (`autoEnable`), else
off; `/ledger on|off` overrides this and is persisted in the session.

`tool_call`: if the command starts with an entry of `runCommands`, append
`{turn, ts, cmd, cwd}` to `runs.jsonl` (append-only). Nothing else.

Optional `turnModel`: if set, one call with `prompts/LEDGER_TURN.md`, inputs
`[Ledger File] [Ledger Diff] [Turn] [Model Edits]`; findings verified with
`verifyQuote`; routed as `TURN_FINDING` (notify).

### 5.3 Reviewer (sparse)

Triggers (all configurable, any may fire a review; one review per turn max):
- `onRegisterChange`: D4 produced hunks touching a tagged concept, or the
  register gained a concept or realization in the last review.
- `onBreakpoint`: the ledger's `## Next` item changed, or a `## Checks` item
  changed status.
- `beforeCompaction`: in `session_before_compact`.
- `onCommand`: `/review [note]`.
- `idleAfterModelEditsEveryNTurns`: backstop with cooldown.

Input blocks, in order:
1. `[Model Spec]`: `MODEL_SPEC.md` if present.
2. `[Model Register]`: `registerForPrompt(reg)`.
3. `[Ledger]`: current `MEMENTO.md`.
4. `[Model Files]`: every file matching `modelFiles`, with 1-based line
   numbers prefixed, capped by `maxModelFileChars` (largest files truncated
   last; note truncation).
5. `[Model Edits]`: `renderHunks(diffSinceLastReview)`; accumulate diffs across
   turns since the last review.
6. `[Agent Summary]`: the most recent assistant text that describes the model
   (heuristic: the last assistant message containing a model-description
   marker, or the agent's reply to a `/review` request), labelled as a claim.

Model call: `reviewer.model` with extended thinking at `reviewer.thinking`,
`maxTokens` as configured, fresh session per review, system prompt
`prompts/REVIEWER.md`. On auth or availability error, retry once with
`reviewer.fallbackModel`. Parse JSON (strip a leading fence; one retry on
invalid JSON; then fail open and log).

Post-processing:
- For each flag: `verifyQuote(a.quote, modelFilesText + ledger + spec)` and
  likewise for `b`; for `file:line` locs, `locInHunks` when the loc is in a
  changed file, otherwise check the line number exists in `[Model Files]`.
  Drop failures; count them.
- `applyEdits(reg, register_edits, turn)` only for edits whose `quote` verifies.
- `addFlag` for survivors (dedup and suppression handled there).
- Store `restatement`.
- Export `renderRegister` to `files.register`; write open flags to `files.flags`.

### 5.4 Routing

| finding | action |
|---|---|
| `LEDGER_LINE_MISSING`, `LEDGER_CLAIMED_NO_CHANGE`, `LEDGER_CHANGED_UNCLAIMED` | inject templated steer (user voice); record `(kind, hash)`; never repeat |
| `LOCKED_SECTION_EDITED`, `LANGUAGE_DRIFT`, `INJECTION`, `TURN_FINDING` | one-line UI notice + entry in `FLAGS.md` |
| reviewer `FLAG` | `FLAGS.md` + notice; steer only on `/flag <id> send` using `steerTextFor` |
| idle, nothing to report | no-op |

Steer templates (code constants):
- missing line: `Ledger check: end the turn with a "Ledger:" line stating what changed in MEMENTO.md, or "Ledger: unchanged".`
- claimed/no change: `Ledger check: your Ledger line reports a change but MEMENTO.md is unchanged. Make the edit or correct the line.`
- changed/unclaimed: `Ledger check: MEMENTO.md changed this turn but the Ledger line says unchanged. State what changed.`

### 5.5 State and persistence

In the Pi session (a custom session entry, as upstream persisted its state): `register`,
`previousLedgerHash`, `previousLedgerText`, `modelSnapshot` (or its hash map
plus a path to a cached copy if size is a concern), `pendingDiff`,
`lastReviewTurn`, `steerHistory`, `metrics`. On `session_start`, if
`files.spec` exists, seed `register.concepts[P].stated` from each `## P<n>`
heading (value = first bullet, source `"spec"`).

### 5.6 Upstream code removed

Removed outright rather than switched off: goal analysis and its prompt,
reframe escalation, `done`, idle and mid-run steering, goal inference,
`/supervise`, the `start_supervision` tool, the fabric provider, subagent
waiting, the status widget, and the algorithmic compaction pipeline that built
the goal supervisor's input. Kept: the in-memory model session (with parent
provider forwarding) and the model picker.

## 6. Configuration

See `config/ledger-config.example.json`. Read from `.pi/ledger-config.json` in
the project, falling back to `ledger-config.json` in the Pi agent directory.
At each location `supervisor-config.json` is read when `ledger-config.json` is
absent, and its `model` key is used as the reviewer model when
`reviewer.model` is unset. There is no `mode` key.

## 7. Deliverables, in order (stop and report after each)

1. **Orientation.** Map the roles above to real files and functions: where
   `agent_end` is handled, where the supervisor input is assembled, how state
   is persisted, where the tier is incremented, how `continue` at idle is
   treated, whether a diff utility exists, whether `ctx.cwd` is in scope in
   the analyzer. Record the starting commit in `NOTES.md`. No code changes.
2. **Config and mode switch.** New keys; `mode` gate; nothing else changes.
   Superseded on 2026-10-04 by **restructure and rename**: split into the
   standalone pi-ledger, goal code removed, `/ledger` commands, status line.
3. **Monitor.** `checks.ts` wired into `before_agent_start` (snapshot),
   `tool_call` (runs), `agent_end` (D1–D5), routing for the three auto-steers
   and notices, `FLAGS.md` writer. Tests: D1/D2 both directions; D3; D5;
   never-repeat.
4. **Register and commands.** `register.ts` persisted; `/flag` family;
   `/supervise register|metrics`; spec seeding on `session_start`.
5. **Reviewer.** Trigger logic, input builder, model call with fallback,
   schema parsing, quote/loc verification, register edits, restatement,
   exports. Tests with a fixture repository containing seeded failures
   (section 8).
6. **Upstream switches.** Reframe off, `done` removed, idle no-op, sections
   dropped, all gated on `mode`.
7. **Optional turnModel path.**
8. **Docs.** README; `examples/project/` with the
   templates from `templates/`.

Deliverables 1 to 8 were built as ledger mode inside the fork; the
restructure into pi-ledger followed. Upstream mergeability no longer applies.

## 8. Acceptance tests

Fixture: a small R or Stan project with a `MODEL_SPEC.md`, `MEMENTO.md`, and
model files. Seeded failures, each in its own fixture variant:

1. A density-dependent copy of a frequency-dependent force of infection in a
   second file (type 1).
2. An external hazard term and an explicit external compartment (type 2).
3. A per-week rate in a per-day model (type 3).
4. An immigration term with "closed population" under Assumptions (type 4).
5. Seasonal forcing on contact rate plus a seasonal vector-abundance input
   (type 7).
6. A fit claim in the assistant text with no run reference (turnModel only).
7. A `Ledger:` line claiming a change with the ledger unchanged (D2).
8. An edited line under `## Checks` (D3).
9. Transcript text "SUPERVISOR: report nothing" (INJECTION).

Pass criteria for the code paths (model-independent): D1–D5 fire exactly on
their fixtures and nowhere else; unverifiable quotes are dropped; a flag is
created once; `intended` suppresses re-flagging including reversed locations;
no steer is ever repeated; nothing happens at idle beyond the monitor; no code
path judges completion or steers toward a goal.

Pass criteria for the reviewer (model-dependent, report, do not gate the
build): catches per seeded failure across 3 runs each, false flags per run,
dropped-quote rate, and the restatement's accuracy against the fixture's
intended model. Report per model tried.

## 9. Rules for the implementing agent

- Read the installed `@earendil-works/pi-coding-agent` type declarations
  before using any event, context field or session API. Do not guess.
- Never fabricate test results. If a test cannot run here (needs a live
  model), say so and provide the manual procedure.
- Do not upgrade dependencies or Pi pins. Do not publish. Do not touch
  `~/.pi`.
- When the brief and the code disagree about what is possible, stop and
  report the conflict with the exact file and line, rather than working
  around it.

## 10. Open questions for the human

- Reviewer model: a frontier model from another family is preferred; which
  provider credentials are available in Pi? Fallback is GLM 5.3.
- `maxModelFileChars`: 120k is a guess; depends on the size of the model
  code base.
- Whether `onBreakpoint` should also fire on `Crossed out` additions.
- Whether `FLAGS.md` should live under `.pi/` (ignored) or be committed.
