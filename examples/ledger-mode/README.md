# Ledger mode example

Copy into a research project:

| File                     | Where it goes                                                           |
| ------------------------ | ----------------------------------------------------------------------- |
| `supervisor-config.json` | `.pi/supervisor-config.json` (set `reviewer.model`, `files.modelFiles`) |
| `MEMENTO.md`             | project root; the agent keeps it up to date                             |
| `MODEL_SPEC.md`          | project root; yours, the agent only proposes changes                    |
| `AGENTS.snippet.md`      | append to the project's `AGENTS.md`                                     |

`scripts/ledger-fixture.sh` in this repository builds a small seeded test project to try it on.
