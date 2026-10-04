# Example project setup

Copy into a research project:

| File                 | Where it goes                                                       |
| -------------------- | ------------------------------------------------------------------- |
| `ledger-config.json` | `.pi/ledger-config.json` (set `reviewer.model`, `files.modelFiles`) |
| `MEMENTO.md`         | project root; the agent keeps it up to date                         |
| `MODEL_SPEC.md`      | project root; yours, the agent only proposes changes                |
| `AGENTS.snippet.md`  | append to the project's `AGENTS.md`                                 |

With `MEMENTO.md` in the project root the ledger switches on at session start.
Write the Aim and the Acceptance lines (what counts as done, against which data)
before the agent starts fitting; after that they are append-only.

`scripts/ledger-fixture.sh` in this repository builds a small seeded test project to try it on.
