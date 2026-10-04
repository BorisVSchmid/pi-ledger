# Credits and lineage

pi-ledger is derived from pi-supervisor, not a mode of it. It started as a
"ledger mode" inside a fork of pi-supervisor and was split out on 2026-10-04
into a standalone extension with one job, integrity, after the goal logic was
removed. Almost every mechanism in it has a visible ancestor. No code was
copied from the projects below except pi-supervisor itself; `monitor.ts`,
`reviewer.ts` and `flags.ts` are new. Check each project's licence before
copying any text or code from it.

## Code lineage

- **monotykamary/pi-supervisor** (MIT), itself a fork of **tintinweb/pi-supervisor**.
  pi-ledger is derived from it and keeps its infrastructure: a second model
  in a separate in-memory Pi session that borrows the parent session's
  provider auth; state persisted in the session file; the hook wiring;
  templated user-voice steering. It drops the goal semantics entirely (goal analysis, reframe
  tiers, `done`, idle steering, `/supervise`, goal inference, and the
  algorithmic input building that served the goal supervisor). The MIT
  notice in `LICENSE` is upstream's.

## Designs borrowed from other Pi extensions and skills

- **ruslanlap/memento** — the ledger's categories and discipline: evidence
  attached to every claim, hypotheses that cannot authorise action, invalidated
  claims kept as "false claims a future agent might repeat", one verifiable
  next action, verify-before-act. The file name `MEMENTO.md` comes from here.
- **waterdrop26651/pi-memento** (Memento-skill) — predictions written before
  a run, hypotheses recorded with what evidence would change them, and a cold
  archive recalled only when needed. Our locked `## Checks` section and
  `MEMENTO.archive.md` follow this.
- **fitchmultz/pi-posthorse** — treating older assistant prose as not being
  state, editing a current-state note section by section rather than
  rewriting it, and resetting from the note instead of summarising. Our
  "artefacts over narration" rule and reset-from-ledger practice follow this.
- **davebcn87/pi-autoresearch** — re-reading files from disk after compaction
  rather than trusting the summary. Our post-compaction note follows this. An
  earlier version also copied its tool-written run log; it was removed as
  unused.
- **OthmanAdi/planning-with-files** — re-injecting the plan each turn and
  hashing an approved plan so tampering blocks injection. Our append-only
  locked sections follow this; the re-injection was not adopted.
- **lhl/pi-multiloop** — compound verifiers, and keeping work counters out of
  the agent's view so they are not read as a context gauge.
- **thebabush/pi-memento**, **ttttmr/pi-context**, **uriafranko/pi-rollback** —
  agent-driven context transactions and branch summaries. Not in the plugin,
  but they shaped the recommendation to run side explorations as `/tree`
  branches.
- **aerovato/operator-memory** — the starting point of the discussion; its
  observation that agents favour the status quo and hesitate to restructure
  documents is one reason the ledger is kept small and append-only.
- **monotykamary/pi-loop** — the anti-oscillation discussion behind "never
  repeat a steer".

## How pi-ledger differs from the projects it overlaps with

### pi-supervisor (tintinweb; monotykamary fork)

Upstream is a goal supervisor. Each time the agent idles, a second model reads
a compacted view of the session and answers one question: is the goal
achieved, and if not, what steer gets the agent there? It escalates similar
steers through reframe tiers (directive, subgoal, pivot, minimal slice),
declares `done` when it judges the goal met, and gates on the model's
self-reported confidence.

pi-ledger keeps the chassis and changes the question. It never asks whether
the work is finished or on track; it asks whether the ledger matches what
happened and whether the model is internally consistent. Consequences:

- No tiers, no `done`, no idle steering, no confidence gate. "Continue" at
  idle is a no-op.
- Two deterministic findings steer the agent (missing `Ledger:` line, ledger
  claim contradicting the file hash). Everything a model judges goes to the
  human as a question and steers only on `/flag send`.
- Different input: the session goal and status sections are dropped; the
  ledger, the spec (read fresh each review), the model files with their diffs
  and the open and closed flags are added.
- Different cadence: a code-only monitor every turn, and a sparse reviewer
  that may be a different, more capable model, run in a fresh session with
  extended thinking.
- Completion is visible but not judged: a status line reports the
  ledger's Acceptance items as passed only when a status line cites a run id.

Built first as a mode switch inside the fork, it became a separate extension
because the two designs share infrastructure, not purpose: one drives the
agent toward a goal, the other refuses to. Convergence is left to loop
drivers, or to upstream pi-supervisor itself pointed at the ledger's
Acceptance; running it next to pi-ledger, with both injecting steers, is
untested.

### ruslanlap/memento

The skill defines a single `MEMENTO.md` with a strict shape (durable
constraints and decisions with evidence, observed state with evidence,
hypotheses that cannot authorise action, invalidated claims, one next
action) and a protocol for the next agent: wake up, verify the note against
reality, then continue. It has no runtime: nothing checks that the agent
kept the note, and it says so.

pi-ledger adopts the categories and the evidence rule almost unchanged and
supplies the missing runtime: the agent's `Ledger:` line is verified against
the file hash each turn; Acceptance and Checks are append-only, with edits
flagged; an Acceptance item counts as passed only when its status line cites
a run id; superseded claims move to an archive with a one-line tombstone instead
of staying crossed out in the live file. The skill remains the agent-side
half: it is what tells the agent how to write and resume from the ledger.
pi-ledger does not reimplement its handoff protocol.

### waterdrop26651/pi-memento (Memento-skill)

A research-oriented tracker: current state as the entry point, separate
ledgers for runs and for contrasts (prediction, control, observed delta),
hypotheses with the evidence that would change them, an evidence log, and a
cold archive recalled only on a trigger. A validator checks schema and
cross-references. Nothing fires it; the agent must remember to update it.

pi-ledger shares two ideas with it: predictions written before a run, and
keeping stale material out of the hot path. It differs in scope and form.
One ledger file plus an archive instead of six files; no validator; and the
additions pi-memento lacks: a trigger (the monitor), verification against the
file, and a reviewer that checks the model, not just the ledger. The two
ledger formats overlap enough that running both would mean two competing
records of the same work. Choose one; the contrasts file is the piece worth
porting if you prefer pi-memento's structure.

### fitchmultz/pi-posthorse

Posthorse manages the context window. At a threshold or on the agent's own
call it rolls over to a fresh window with no summary, carrying a handoff built
from the human's instructions and raw tool evidence; it keeps one
current-state note per task, edited section by section; it treats older
assistant prose as not being current state and keeps the full log searchable.

pi-ledger takes the stance (artefacts over narration, edit sections rather
than rewrite) and none of the mechanism. It never summarises, rolls over or
touches the context window, and it has no view on when a window should end.
The two are complementary and can run together: posthorse owns compaction
and rollover and writes handoffs; pi-ledger checks the content of the note
and the coherence of the model. Two rules when both are installed: pi-ledger's
review before compaction should start before posthorse's rollover, and
pi-ledger must never return a compaction result from
`session_before_compact`.

### davebcn87/pi-autoresearch

Autoresearch is an optimisation loop: run an experiment, measure a metric,
keep or discard, repeat, driven by a living prompt document and an
append-only JSONL log that its own tools write. Hooks before and after each
run can steer the agent, and after compaction it re-prompts the agent to
re-read its files from disk.

pi-ledger borrows the habit of going back to the files after compaction.
It runs nothing, measures nothing and decides nothing. Both can be active,
but then autoresearch's living document and `MEMENTO.md` both claim to be the
state of the work. Either point autoresearch's document at the ledger or
tell the reviewer which one is authoritative.

### OthmanAdi/planning-with-files

It keeps `task_plan.md`, `findings.md` and `progress.md`, re-injects the plan
into every turn, has the agent recite it before tool calls, and hashes the
approved plan so that a tampered plan is not injected.

pi-ledger borrows the hash. Locked ledger sections work the same way:
once written, a change to an existing line is detected and flagged. It does
not borrow the injection or the recitation: the ledger is read at session
start and edited in place, and nothing is pushed into every turn, which
keeps prompt caching stable and avoids a second copy of the state in
context. Running both means two per-turn injections of overlapping state;
keep one.

### lhl/pi-multiloop

Multiloop drives iterations with compound verifiers (a metric plus mechanical
and prompt-based checks, all of which must pass for a keep), supports a
research mode that logs every result instead of keeping or discarding, and
deliberately hides time, turn and token counters from the agent because a
running total reads like a context gauge.

pi-ledger keeps two principles: a claim needs more than one kind of
evidence, and budget counters never reach the agent. It is not a loop driver:
no lanes, no iteration budget, no metric, no decision tool, no
auto-continuation. The two do not conflict.

### Compaction replacements (Pi Continuity, pi-custom-compactor, pi-omni-compact, pi-vcc)

These own `session_before_compact` and replace Pi's default summary with
their own structured state. pi-ledger does not compact. Its only use of
that hook is to start a background
review of the model on artefacts, which does not delay compaction; after
compaction it may add a separate note listing statements in the summary that
differ from the ledger, leaving the summary unchanged. It must not return a compaction result from the hook; the
compaction extension does that. Only one extension should own compaction in
a session, and that extension is not pi-ledger.

## Research whose findings shaped the design

- Zhang et al., [_Agentic Context Engineering_](https://arxiv.org/abs/2510.04618)
  (2025): incremental delta updates; monolithic rewrites collapse context →
  the ledger is edited, never regenerated.
- Laban et al., [_LLMs Get Lost in Multi-Turn Conversation_](https://arxiv.org/abs/2505.06120)
  (2025): early assumptions persist; consolidated restarts recover → reset
  from the ledger.
- Martin & Roger, [_Classifier Context Rot_](https://arxiv.org/abs/2605.12366)
  (2026): monitor recall falls with transcript length; incremental checks,
  more reasoning and quote-first prompting help → per-turn monitoring,
  reviewer with extended thinking, quote-first findings.
- Tang et al., [_How Coding Agents Fail Their Users_](https://arxiv.org/abs/2605.29442)
  (2026), and Ren et al., [_Agents That Edit Documents_](https://arxiv.org/abs/2609.23953)
  (2026): inaccurate self-reporting grows as sessions go on; agents misreport
  their own edits (41% of runs that edited the wrong thing filed a receipt
  claiming an edit the file did not contain) → the Ledger line is a claim
  verified against the file hash.
- Zhong et al., [_ImpossibleBench_](https://arxiv.org/abs/2510.20270) (2025)
  and related reward-hacking work: isolating tests removes cheating →
  append-only Acceptance and Checks sections.
- Tsui, [_Self-Correction Bench_](https://arxiv.org/abs/2507.02778) (2025),
  the "self-correction blind spot": models correct an error when it is
  attributed to someone else, not when it is in their own output → reviewer
  in a fresh context, artefacts only.
- Norman, Rivera & Hughes, [_Reliability without Validity_](https://arxiv.org/abs/2606.19544)
  (2026), a 21-judge study, and Thakur et al.,
  [_Judging the Judges_](https://arxiv.org/abs/2406.12624) (2025): judge
  agreement is weaker than it looks; only the strongest judges align
  reasonably with humans → code verification of quotes, flags routed to the
  human, capable reviewer.
- Guo et al., [_When Context Changes_](https://arxiv.org/abs/2609.38866)
  (2026), and [_Unable to Forget_](https://arxiv.org/abs/2506.08184) (2025):
  stale values win over updates → superseded claims leave the live ledger.
- Luo, Kasirzadeh & Shah, [_The More You Automate, the Less You See: Hidden
  Pitfalls of AI Scientist Systems_](https://arxiv.org/abs/2509.08713) (2025):
  post-hoc selection bias → success criteria fixed and locked before fitting.
- Anthropic, [_Harness design for long-running application development_](https://www.anthropic.com/engineering/harness-design-long-running-apps)
  (2026): generator/evaluator separation and evaluators that check artefacts.
- Comparative evidence on specification checking (LLM verification such as
  [VeriSpec](https://arxiv.org/abs/2610.01847) vs test-based checks such as
  [CASCADE](https://arxiv.org/abs/2604.19400)): reading is low-precision,
  execution is high-precision → "no running of tests" is a deliberate
  non-goal, and reading-based flags are questions, not verdicts.
