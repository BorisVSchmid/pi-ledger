## Research ledger (MEMENTO.md) and model spec

- MEMENTO.md is the state of this investigation. Read it at session start and
  verify the Next item against the current files before acting.
- Record in the same turn: assumptions you rely on (Assumptions), choices
  between alternatives (Decisions), and results (Observed, with a run id).
  Evidence is a path, run id, command or commit, never "as discussed".
- Before any fit, analysis or experiment, add one line under Checks stating
  the expected result and what would count as failure. Lines under Acceptance
  and Checks are append-only: resolve them with a status, never rewrite them.
- Claims that something fits, works or converges need a run id and, where it
  exists, held-out evidence.
- When a result refutes a recorded item, move it to Crossed out with the run
  id and a one-line reason. Keep full text in MEMENTO.archive.md.
- Edit sections in place; never regenerate the whole file. Keep it under
  ~2,000 words.
- End every turn with exactly one line:
  `Ledger: <ids changed> — <≤15 words>`  or  `Ledger: unchanged`.
- Code that implements a modelling process carries a tag on the line above:
  `# @concept P1` (ids from MODEL_SPEC.md; propose a new id if the concept is
  new). One concept, one place in code wherever possible.
- Write all output and ledger content in English.
- Aim and MODEL_SPEC.md belong to the human. Propose changes in your reply.
- Questions for the human go to the human. A "Ledger check" message is a
  request to record, cite or reconcile; it is not an answer to your question.
