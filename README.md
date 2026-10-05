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

pi-ledger is its own project. It started as a mode inside a fork of
[pi-supervisor](https://github.com/monotykamary/pi-supervisor) and still uses that project's
model-session and persistence code (MIT, notice kept in [LICENSE](LICENSE)), but shares none of its
goal supervision. [CREDITS.md](CREDITS.md) gives the lineage and the designs it borrows.

## Install

```bash
pi install https://github.com/BorisVSchmid/pi-ledger@master
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
  id stays open. The status line belongs under Acceptance, but one written elsewhere still counts.
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
| `/ledger` or `/ledger status` | status line, each Acceptance item, and the ledger's word count          |
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
It then makes one open pass for anything else wrong: plain errors that contradict nothing (a
month-to-year conversion in a per-day model, a function returning NA for part of the year) and
checks that cannot fail because the model fixes the tested quantity. These may quote one place.
Every quote and location is checked in code; findings that do not verify are dropped, and a
question already open is merged into its flag rather than raised again. Prefer a reviewer from a
different model family than the working agent.

**Stale flags.** Flags are never closed for you, because a close needs your reason. After every
run and review the quotes of open flags are checked again (anywhere in the file, since lines move).
A flag whose quote is gone, say about a Next item that has since been replaced, is marked
`evidence gone` in `/flag` and `.pi/FLAGS.md`. A review may also point to a ledger entry that
answers an open flag (its quote is verified); the flag is marked `possibly answered by
LEDGER.md#D7`. The digest after each review lists all such flags so you can close them.

**Ledger size.** The snippet asks the agent to keep `LEDGER.md`, outside Acceptance and Checks, under about 2,000 words by
condensing Observed, Crossed out, done Next items and tested Assumptions into
`LEDGER.archive.md`. Acceptance and Checks are never condensed or moved. `/ledger status` shows
the word count.

**After compaction.** The reviewer model reads the new summary with `LEDGER.md` and `MODEL_SPEC.md`
only, and adds a separate note listing statements in the summary that differ from the ledger. The
note does not assume the ledger is right (it can be behind); it asks the agent to check which is
current. The summary itself is not changed.

**Edits between turns.** If `LEDGER.md`, `MODEL_SPEC.md` or a model file changed since the agent's
last turn (you edited them), the next prompt carries a note naming the changed files and sections
and asking the agent to re-read them rather than rely on what it remembers.

**Output.** `.pi/FLAGS.md`: open questions, the reviewer's ten-line restatement of the model to
compare with what you meant, and the monitor's notices.

## What has been shown, and what has not

Tested so far in one project (bank vole and tree mast dynamics) and on scripted fixtures, with
Sonnet 5.5 as the agent, from 2026-10-04 to 2026-10-05. Every sample below is small; read the
numbers as first evidence, not as rates.

**Shown to work**

- **The note on edits between turns.** When a person changed the ledger, the spec or the code
  between turns and then asked about it, agents without pi-ledger described the old spec or code
  from memory in 7 of 7 replies; with pi-ledger's note, 0 of 3 did, because they re-read the files
  (Fisher's exact test, p ≈ 0.008). This is pi-ledger's clearest measured benefit. Two other
  memory extensions, pi-brain and pi-memento, did not prevent it.
- **Flags that changed a research conclusion.** In a 13-batch real session (about $12 of agent
  time) the reviewer raised that the model counted all voles while the data
  counted adults (F63), that a parameter guard looked at held-out dates (F65), and that the
  held-out score varied by 0.28 across random seeds (F67). Following them up, a clean test without
  the leak failed: the held-out score spread from 0.45 to 1.20 across seeds, and the session's
  acceptance criterion was ruled not robustly met. The earlier passing score had rested on the
  leak and an unstable seed.
- **Goals stayed coherent.** Across that session and an earlier 17-turn run with two forced
  compactions, the agent did not act on a stale aim or retry a crossed-out idea, and recorded the
  human's rulings when the goal changed.
- **Detection on seeded mistakes.** On five fixtures with a planted contradiction (density
  vs frequency transmission, weekly rates in a daily model, and so on) the reviewer found the
  planted mistake 15 of 15 times, with the right type 14 of 15 times. Quote checking removed
  unsupported flags (13 in the first live run).

**Not shown**

- **That the post-compaction note prevents drift.** In no arm of any live run (4 arms, then
  10 repetitions with forced compaction) did an agent drift after compaction: with or without
  pi-ledger, none retried a refuted idea and all followed the ledger's Next. Pi keeps the most
  recent turns verbatim, which seems to be enough for Sonnet 5.5. The note was accurate and
  heeded, but not needed. In a scripted test it named every stale statement in a summary 3 of 3
  times; whether that matters for a weaker model or a longer session is untested. In one early
  run the note did harm: it treated a stale ledger as true, and the agent retracted a correct
  statement. The note now says the two "differ" and asks the agent to check which is current.
- **That the reviewer finds more than an ordinary review.** Asked "Can you review this
  project?", Opus 5.5 found every planted mistake as well (15 of 15), plus real bugs the reviewer
  missed (a month-to-year conversion, an `NA` outside an interpolation range), and it raised design
  problems that pi-ledger leaves alone by design. Once drift has reached the files, a plain review
  catches it as well. What pi-ledger adds over such a review is that it runs without being asked,
  checks its quotes, and keeps its questions until they are answered. There was no plain-review
  arm in the real session, so whether one would also have caught F63, F65 and F67 is unknown.

**Known weaknesses**

- Flags pile up. The real session ended with 29 open flags, 22 of them marked evidence gone. A
  flag reaches the agent only through `/flag send`, so someone has to read and close them.
- Append-only does not mean unchanged. A post-hoc clarification appended under the locked
  Acceptance section passed every check; only a person reading the ledger noticed it.
- One project, one agent model, mostly one reviewer model. Fixtures held their mistakes in dead
  code; mistakes wired into the running model are untested.

Raw results: the drift runs, the plain-review comparison and the session reports are kept with
the project's working files, not in this repository.

## Configuration

Read from `.pi/ledger-config.json`, then `~/.pi/agent/ledger-config.json`. Every key is optional;
see [`examples/project/ledger-config.json`](examples/project/ledger-config.json).

```json
{ "reviewer": { "model": "provider/model-id" }, "files": { "modelFiles": ["R/**/*.R"] } }
```

- `autoEnable` (default `true`): switch on at session start when `files.ledger` exists.
- `reviewer.model` (`null` = the chat model), `reviewer.fallbackModel`, `reviewer.thinking`.
- `files.ledger`, `files.spec`, `files.modelFiles`, `files.ignore` (archives are ignored by default).
- Projects set up for the earlier pi-supervisor-based ledger mode keep working: `supervisor-config.json` is read when
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
