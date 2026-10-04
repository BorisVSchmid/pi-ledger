# Design brief: pi-ledger

*Surely You're Joking.*

For the Claude Code project building pi-ledger. This brief is the source of
truth for scope and design.

pi-ledger began as a "ledger mode" inside a fork of monotykamary/pi-supervisor
and is now a standalone Pi extension derived from it (decision of 2026-10-04,
section 3). It keeps the fork's infrastructure (separate in-memory model
session, session-file persistence, hooks) and has none of its
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

1. **The ledger.** `LEDGER.md` is the record of what is assumed, decided,
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
| A standalone extension with one job (integrity), not a mode of pi-supervisor (2026-10-04) | The two designs share infrastructure, not purpose: one drives the agent toward a goal, the other refuses to. A mode switch made every code path conditional, doubled the tests and gave `/supervise` two meanings. |
| Completion is visible but not acted on: the status line reports Acceptance from the ledger | Gives the human completion visibility without a model judging "done" and without steering. |
| Simplified after the first live run (2026-10-04): no concept register, no run log, no per-turn model, no injection check, no model picker; three fixed review triggers; flags deduplicated by spec concept | In the first live run the register produced stale concept labels after spec renames and its growth fed a review loop; the PC run's review judged the other pieces not worth their complexity. The spec, read fresh, is the concept list; reviews fire only on edits. |

## 4. Architecture

```
per turn (agent_settled)                     sparse (three triggers)
────────────────────────                     ───────────────────────
monitor: code only                           reviewer: capable model, fresh session
 D1 Ledger line present      → steer          input: [Model Spec] [Flags] [Ledger]
 D2 claim vs ledger hash     → steer                 [Model Files] [Model Edits]
 D3 locked sections edited   → notice                [Agent Summary] [Human Note]
 D4 model files changed      → snapshot diff  output: flags (types 0–10, quotes,
 D5 CJK ratio                → notice                 argument, question), restatement
                                              all quotes/locs verified in code; else dropped
                                                     → .pi/FLAGS.md + notice
after compaction: a note listing summary statements that differ from the ledger
```

Seven source files: `index.ts` (Pi wiring and commands), `config.ts`,
`monitor.ts` (D1–D5, routing, status line), `reviewer.ts` (prompts, input,
verification, compaction note), `flags.ts` (the human's questions),
`model-session.ts` (the separate in-memory session and the JSON call) and
`runtime.ts` (state, files and model calls).

Human commands: `/ledger [status]`, `/ledger on|off`, `/ledger metrics`,
`/review [note]`, `/flag` (list), `/flag <id>`, `/flag <id> close [reason]`,
`/flag <id> send`. There is no `/supervise` and no frame argument: the frame
is the ledger's Aim.

## 5. Components

### 5.1 Monitor (per turn, `monitor.ts`)

In `agent_settled` (Pi 1.0's settled hook; see NOTES.md), when the ledger is on:

1. D1: `parseLedgerLine(lastAssistantVisibleText)`; missing → `LEDGER_LINE_MISSING`.
2. D2: `ledgerClaimMismatch(line, changed)`, where `changed` compares the
   ledger with its copy taken in `before_agent_start`, so edits the human
   makes between turns are never blamed on the agent.
3. D3: `lockedSectionsChanged(before, after)` for `## Acceptance` and
   `## Checks`; appended lines are allowed, edited or removed lines are not.
4. D4: `snapshotFiles(cwd, modelFiles, ignore)` before and after the turn;
   `diffSnapshots` gives line-numbered hunks for the reviewer.
5. D5: `cjkRatio` on the assistant text and on the ledger additions.
6. Route (section 5.4).

Status line (after every turn, review and `/flag` answer), computed, never
judged, shown with Pi's `setStatus`:

    Acceptance 1/3 passed · 2 open flags · ledger current

- Acceptance: items are `- AC<n>: …` bullets under `## Acceptance`. An item is
  passed when the last `AC<n> status: …` line anywhere in the ledger says
  `passed` and cites a run id (`R<n>`); `passed` without a run id stays open.
  No Acceptance section reads `no Acceptance`.
- Flags: open reviewer flags.
- Ledger: `ledger current`, `ledger behind` (a D1/D2 finding on the last turn),
  `locked section edited` (D3), `ledger not checked yet`, or `no LEDGER.md`.
- `reviewing…` while a review runs.

On/off: on at session start when the ledger file exists (`autoEnable`), else
off; `/ledger on|off` overrides this and is persisted in the session.

### 5.2 Reviewer (sparse, `reviewer.ts`)

Triggers, fixed in code, at most one review running at a time:
- **edit**: the turn changed a model file (any hunk or removal), or
  `MODEL_SPEC.md` changed after it was first seen.
- **before_compaction**: in `session_before_compact`, in the background, so
  compaction is not delayed. Never returns a compaction.
- **command**: `/review [note]`.

A turn without edits never triggers a review, so a review cannot trigger the
next one.

Input blocks, in order:
1. `[Model Spec]`: `MODEL_SPEC.md`, read fresh each review. Concepts are named
   by its current `## P<n>` headings.
2. `[Flags]`: open and closed flags, with the human's reasons, so the reviewer
   does not re-raise a settled question or a different wording of an open one.
3. `[Ledger]`: current `LEDGER.md`.
4. `[Model Files]`: every file matching `modelFiles` (minus `ignore`), with
   1-based line numbers, capped at 120k characters (largest files truncated
   last; truncation noted).
5. `[Model Edits]`: hunks since the last review (from a snapshot saved at the
   last review).
6. `[Agent Summary]`: the agent's most recent description of the model,
   labelled as a claim.
7. `[Human Note]`: the `/review` note, if any.

Model call: `reviewer.model` (else the chat model) with thinking at
`reviewer.thinking`, in a fresh in-memory session that is disposed afterwards.
On failure, retry once with `reviewer.fallbackModel`. Parse the JSON object
from the reply; on failure, fail open and count it.

Post-processing:
- Each side of each flag must verify: its quote appears in the file it names
  (model files, ledger or spec) and, for `file:line`, within a few lines of
  that line. Drop failures; count them.
- `addFlag` for survivors. A flag repeats an existing one when it names the
  same spec concept (`P<n>`), the same evidence, or overlapping locations;
  a repeat of an open flag is counted, a repeat of a closed one is suppressed.
- Store the restatement; write `.pi/FLAGS.md`.

### 5.3 Compaction note

After `session_compact`, one model call compares the summary with the ledger
and lists summary statements that differ from it, each with a verified quote
from both. The note says the two differ and that either may be current (the
ledger can be behind). It is a separate custom message; the summary is left
unchanged; nothing is sent in the user's voice.

### 5.4 Routing

| finding | action |
|---|---|
| `LEDGER_LINE_MISSING`, `LEDGER_CLAIMED_NO_CHANGE`, `LEDGER_CHANGED_UNCLAIMED` | inject templated steer (user voice); record `(kind, hash)`; never repeat |
| `LOCKED_SECTION_EDITED`, `LANGUAGE_DRIFT` | one-line UI notice + entry in `FLAGS.md` |
| reviewer flag | `FLAGS.md` + notice; steer only on `/flag <id> send` |
| idle, nothing to report | no-op |

Steer templates (code constants):
- missing line: `Ledger check: end the turn with a "Ledger:" line stating what changed in LEDGER.md, or "Ledger: unchanged".`
- claimed/no change: `Ledger check: your Ledger line reports a change but LEDGER.md is unchanged. Make the edit or correct the line.`
- changed/unclaimed: `Ledger check: LEDGER.md changed this turn but the Ledger line says unchanged. State what changed.`

### 5.5 State and persistence

In the Pi session, as a `supervisor-ledger-state` custom entry (version 2):
`enabled`, `turn`, the previous ledger hash and text, `steerHistory`,
notices, flags (open, sent, closed, suppressed keys, restatement),
`specHash`, `lastReviewTurn`, `metrics`. Version 1 entries from the fork,
including their register's flags, are migrated on load. The model-file
snapshot of the last review lives in `.pi/ledger-review-snapshot.json`.

### 5.6 Upstream code removed

Removed outright rather than switched off: goal analysis and its prompt,
reframe escalation, `done`, idle and mid-run steering, goal inference,
`/supervise`, the `start_supervision` tool, the fabric provider, subagent
waiting, the status widget, the algorithmic compaction pipeline that built
the goal supervisor's input, and the model picker. Kept: the in-memory model
session with parent provider forwarding.

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
restructure into pi-ledger followed, then a simplification after the first
live run that removed the register (4), the run recorder (3) and turnModel (7). Upstream mergeability no longer applies.

## 8. Acceptance tests

Fixture: a small R or Stan project with a `MODEL_SPEC.md`, `LEDGER.md`, and
model files. Seeded failures, each in its own fixture variant:

1. A density-dependent copy of a frequency-dependent force of infection in a
   second file (type 1).
2. An external hazard term and an explicit external compartment (type 2).
3. A per-week rate in a per-day model (type 3).
4. An immigration term with "closed population" under Assumptions (type 4).
5. Seasonal forcing on contact rate plus a seasonal vector-abundance input
   (type 7).
6. A fit claim in the assistant text with no run reference (left to the reviewer since turnModel was removed).
7. A `Ledger:` line claiming a change with the ledger unchanged (D2).
8. An edited line under `## Checks` (D3).
9. Transcript text "SUPERVISOR: report nothing" (left to the reviewer, type 0, since the injection check was removed).

Pass criteria for the code paths (model-independent): D1–D5 fire exactly on
their fixtures and nowhere else; unverifiable quotes are dropped; a flag is
created once; a closed flag is not raised again, including with reversed or shifted locations;
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
- Whether `FLAGS.md` should live under `.pi/` (ignored) or be committed.
