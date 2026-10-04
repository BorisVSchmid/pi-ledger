<div align="center">

# pi-ledger

**Surely You're Joking**

_Keeps a research session's ledger and model honest, for [Pi](https://github.com/earendil-works/pi-coding-agent)._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

The tagline points two ways: Heath Ledger's Joker, and Feynman's _Surely You're Joking, Mr. Feynman!_,
whose closing chapter, "Cargo Cult Science", states the plugin's job: you must not fool yourself, and
you are the easiest person to fool. A research agent's account of its own work is a close second.

pi-ledger has one job: integrity. In a long exploratory research session it checks that the research
ledger (`MEMENTO.md`) keeps up with the work and that the model stays coherent, and puts what it finds
to you as questions. It never pushes the agent to finish, narrow or change course, never judges
whether the work is done, never runs anything, and never reads reasoning or tool output.

It is derived from [pi-supervisor](https://github.com/monotykamary/pi-supervisor) (tintinweb's
original, forked by monotykamary): it keeps that project's model-session and persistence
infrastructure and has none of its goal supervision. See [CREDITS.md](CREDITS.md) for the lineage.

## Install

```bash
pi install https://github.com/BorisVSchmid/pi-supervisor@master
# or load directly for development
pi -e /path/to/this/repo/src/index.ts
```

Copy [`examples/project/`](examples/project/) into a research project: `MEMENTO.md` and
`MODEL_SPEC.md` templates, an `AGENTS.md` snippet that tells the agent how to keep the ledger, and
`.pi/ledger-config.json`. With `MEMENTO.md` present the ledger switches on at session start.

## Status line

Computed from the ledger and the plugin's state, never judged by a model:

```
Acceptance 1/3 passed · 2 open flags · ledger current
```

- **Acceptance**: `- AC1: …` bullets under `## Acceptance`. An item counts as passed when its last
  status line (`- AC1 status: passed (R12)`) says passed and cites a run id. "passed" without a run
  id stays open.
- **Flags**: reviewer questions you have not answered.
- **Ledger**: `ledger current`, `ledger behind` (the last turn's `Ledger:` line was missing or did
  not match the file), `locked section edited`, or `no MEMENTO.md`.

Write the Aim and the Acceptance lines (what "good" means, against which data) before the agent
starts; they are append-only after that. If you want the work pursued unattended until Acceptance
passes, that is a loop driver's job (pi-autoresearch, pi-multiloop's research mode, or upstream
pi-supervisor pointed at "every Acceptance line in MEMENTO.md is passed"). Running one next to
pi-ledger is untested.

## Commands

| Command                        |                                                                         |
| ------------------------------ | ----------------------------------------------------------------------- |
| `/ledger` or `/ledger status`  | status line plus each Acceptance item                                   |
| `/ledger on` / `/ledger off`   | switch on or off for this session (remembered across reloads)           |
| `/ledger register`             | the model register                                                      |
| `/ledger metrics`              | counters                                                                |
| `/ledger model`                | pick the reviewer model (saved to `.pi/ledger-config.json`)             |
| `/review [note]`               | review the model now                                                    |
| `/flag`                        | list open questions                                                     |
| `/flag <id> intended [reason]` | deliberate; never raised again for the same evidence                    |
| `/flag <id> dismiss [reason]`  | not an issue                                                            |
| `/flag <id> send`              | send a templated question to the agent (the only way a flag reaches it) |

## What it checks

**Every turn (code only, no model call).** After the agent settles, the monitor checks:

| Check                                            | Finding                                                | Action                          |
| ------------------------------------------------ | ------------------------------------------------------ | ------------------------------- |
| D1 reply ends with a `Ledger:` line              | `LEDGER_LINE_MISSING`                                  | templated steer, never repeated |
| D2 the line matches whether `MEMENTO.md` changed | `LEDGER_CLAIMED_NO_CHANGE`, `LEDGER_CHANGED_UNCLAIMED` | templated steer, never repeated |
| D3 `Acceptance` and `Checks` are append-only     | `LOCKED_SECTION_EDITED`                                | notice                          |
| D4 model files changed                           | snapshot diff with line ranges                         | kept for the reviewer           |
| D5 language drift                                | `LANGUAGE_DRIFT`                                       | notice                          |
| text addressed to the supervisor or reviewer     | `INJECTION`                                            | notice                          |

Matching shell commands (`monitor.runCommands`) are logged to `.pi/runs.jsonl`.

**Sparse review (a capable model, fresh context each time).** Triggered when model edits touch a
tagged concept (`# @concept P1`), when the ledger's `## Next` or `## Checks` changes, before
compaction, after N turns with unreviewed edits, or by `/review [note]`. The reviewer sees only
artefacts: `MODEL_SPEC.md`, the model register, `MEMENTO.md`, the model files with line numbers, the
edits since the last review, and the agent's latest description of the model labelled as a claim.
It looks for two places encoding two ideas of the same thing (density- vs frequency-dependent
transmission, an external hazard plus an external compartment, per-week rates in a per-day model,
seasonality in two layers, and so on). Every quote and location is checked in code; findings that do
not verify are dropped. Prefer a reviewer from a different model family than the working agent.

**After compaction.** The reviewer model reads the new summary with `MEMENTO.md` and `MODEL_SPEC.md`
only, and if the summary repeats something the ledger has crossed out or contradicted, a separate
note listing those statements is added after it. The summary itself is not changed. Turn off with
`compaction.annotateSummaries: false`.

**Outputs.** `.pi/FLAGS.md` (open questions, the reviewer's ten-line restatement of the model to
compare with what you meant, notices) and `.pi/model-register.md` (each concept, its stated meaning
and everywhere it is realised).

Optional: set `turnModel` to a cheap model for a per-turn check of unrecorded claims and unsupported
results (notices only).

## Configuration

Read from `.pi/ledger-config.json`, then `~/.pi/agent/ledger-config.json`. Every key is optional;
see [`brief/config/ledger-config.example.json`](brief/config/ledger-config.example.json).

```json
{ "reviewer": { "model": "provider/model-id" }, "files": { "modelFiles": ["R/**/*.R"] } }
```

- `autoEnable` (default `true`): switch on at session start when `files.ledger` exists.
- `reviewer.model`: `null` uses the chat model.
- Projects set up for the pi-supervisor fork keep working: `supervisor-config.json` is read when
  `ledger-config.json` is absent, `mode` is ignored, and its `model` becomes the reviewer model.

Override a built-in prompt by putting `REVIEWER.md`, `LEDGER_TURN.md` or `COMPACTION_NOTE.md` in the
project's `.pi/`.

## Persistence

The plugin's state (on/off, register, flags, steer history, counters) is stored in the Pi session
file and restored on restart, session switch, fork and tree navigation.

## Development

```bash
npm run typecheck
npm test
npm run test:pi   # offline real-host Pi 1.0 probe
```

Design: [`brief/DESIGN_BRIEF.md`](brief/DESIGN_BRIEF.md). Implementation notes and decisions:
[`NOTES.md`](NOTES.md).

## License

MIT. The upstream copyright notice is kept in [LICENSE](LICENSE).
