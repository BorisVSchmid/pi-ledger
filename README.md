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
ledger (`LEDGER.md`) keeps up with the work and that the model stays coherent, and puts what it finds
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

Copy [`examples/project/`](examples/project/) into a research project: `LEDGER.md` and
`MODEL_SPEC.md` templates, an `AGENTS.md` snippet that tells the agent how to keep the ledger, and
`.pi/ledger-config.json`. With `LEDGER.md` present the ledger switches on at session start.
Projects started with an earlier version keep their ledger in `MEMENTO.md`: rename it (and
`MEMENTO.archive.md`) to `LEDGER.md`. The old name is not read, and a notice says so.

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
  not match the file), `locked section edited`, or `no LEDGER.md`.

Write the Aim and the Acceptance lines (what "good" means, against which data) before the agent
starts; they are append-only after that. If you want the work pursued unattended until Acceptance
passes, that is a loop driver's job (pi-autoresearch, pi-multiloop's research mode, or upstream
pi-supervisor pointed at "every Acceptance line in LEDGER.md is passed"). Running one next to
pi-ledger is untested.

## Commands

| Command                       |                                                                         |
| ----------------------------- | ----------------------------------------------------------------------- |
| `/ledger` or `/ledger status` | status line plus each Acceptance item                                   |
| `/ledger on` / `/ledger off`  | switch on or off for this session (remembered across reloads)           |
| `/ledger metrics`             | counters                                                                |
| `/review [note]`              | review the model now                                                    |
| `/flag`                       | list open questions                                                     |
| `/flag <id> close <reason>`   | answered: say why in at least 3 words; never raised again               |
| `/flag <id> send`             | send a templated question to the agent (the only way a flag reaches it) |

## What it checks

**Every turn (code only, no model call).** After the agent settles, the monitor checks:

| Check                                           | Finding                                                | Action                          |
| ----------------------------------------------- | ------------------------------------------------------ | ------------------------------- |
| D1 reply ends with a `Ledger:` line             | `LEDGER_LINE_MISSING`                                  | templated steer, never repeated |
| D2 the line matches whether `LEDGER.md` changed | `LEDGER_CLAIMED_NO_CHANGE`, `LEDGER_CHANGED_UNCLAIMED` | templated steer, never repeated |
| D3 `Acceptance` and `Checks` are append-only    | `LOCKED_SECTION_EDITED`                                | notice                          |
| D4 model files changed                          | snapshot diff with line ranges                         | starts a review                 |
| D5 language drift                               | `LANGUAGE_DRIFT`                                       | notice                          |

**Review (a capable model, fresh context each time).** Runs after a turn that changed a model file or
`MODEL_SPEC.md`, before compaction, and on `/review [note]`, one at a time. The reviewer sees only
artefacts: `MODEL_SPEC.md` (read fresh, so renamed headings are picked up), the flags already
raised, `LEDGER.md`, the model files with line numbers, the edits since the last review, and the
agent's latest description of the model labelled as a claim. It looks for two places encoding two
ideas of the same thing (density- vs frequency-dependent transmission, an external hazard plus an
external compartment, per-week rates in a per-day model, seasonality in two layers, and so on).
Every quote and location is checked in code; findings that do not verify are dropped, and a
question already open is merged into its flag rather than raised again. Prefer a reviewer from a
different model family than the working agent.

**After compaction.** The reviewer model reads the new summary with `LEDGER.md` and `MODEL_SPEC.md`
only, and adds a separate note listing statements in the summary that differ from the ledger. The
note does not assume the ledger is right (it can be behind); it asks the agent to check which is
current. The summary itself is not changed.

**Output.** `.pi/FLAGS.md`: open questions, the reviewer's ten-line restatement of the model to
compare with what you meant, and the monitor's notices.

## Configuration

Read from `.pi/ledger-config.json`, then `~/.pi/agent/ledger-config.json`. Every key is optional;
see [`examples/project/ledger-config.json`](examples/project/ledger-config.json).

```json
{ "reviewer": { "model": "provider/model-id" }, "files": { "modelFiles": ["R/**/*.R"] } }
```

- `autoEnable` (default `true`): switch on at session start when `files.ledger` exists.
- `reviewer.model` (`null` = the chat model), `reviewer.fallbackModel`, `reviewer.thinking`.
- `files.ledger`, `files.spec`, `files.modelFiles`, `files.ignore` (archives are ignored by default).
- Projects set up for the pi-supervisor fork keep working: `supervisor-config.json` is read when
  `ledger-config.json` is absent, other keys are ignored, and its `model` becomes the reviewer model.

Override a built-in prompt by putting `REVIEWER.md` or `COMPACTION_NOTE.md` in the project's `.pi/`.

## Persistence

The plugin's state (on/off, flags, steer history, counters) is stored in the Pi session
file and restored on restart, session switch, fork and tree navigation.

## Development

```bash
npm run typecheck
npm test
npm run test:pi   # offline real-host Pi 1.0 probe
```

Code, in `src/`: `index.ts` wires Pi and the commands; `monitor.ts` holds the per-turn checks
and the status line; `reviewer.ts` the reviewer's prompt, input and quote verification, and the
compaction note; `flags.ts` the human's questions; `model-session.ts` the separate model
session; `runtime.ts` the state and files that tie them together; `config.ts` the settings.

Design: [`brief/DESIGN_BRIEF.md`](brief/DESIGN_BRIEF.md). Implementation notes and decisions:
[`NOTES.md`](NOTES.md).

## License

MIT. The upstream copyright notice is kept in [LICENSE](LICENSE).
