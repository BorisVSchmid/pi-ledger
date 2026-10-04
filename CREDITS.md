# Credits and lineage

Ledger mode changes what the supervisor supervises, but almost every mechanism
in it has a visible ancestor. No code was copied from the projects below
except the fork itself; `checks.ts` and `register.ts` are new. Check each
project's licence before copying any text or code from it.

## Code lineage

- **monotykamary/pi-supervisor** (MIT), itself a fork of **tintinweb/pi-supervisor**.
  The chassis: supervisor in a separate in-memory Pi session; algorithmic
  input building that strips thinking and collapses tool calls; `SUPERVISOR.md`
  overriding the system prompt; user-voice steering; `/supervise`; state
  persisted in the session file. Ledger mode replaces its goal-completion
  semantics (reframe tiers, `done`, idle steering) with ledger and coherence
  checks.

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
- **davebcn87/pi-autoresearch** — a tool-written, append-only run log that the
  agent cannot edit; re-reading files from disk after compaction. Our
  `runs.jsonl` and run recorder follow this.
- **OthmanAdi/planning-with-files** — re-injecting the plan each turn and
  hashing an approved plan so tampering blocks injection. Our append-only
  locked sections and the optional anchor re-injection follow this.
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

## How ledger mode differs from the projects it overlaps with

### pi-supervisor (tintinweb; monotykamary fork)
Upstream is a goal supervisor. Each time the agent idles, a second model reads
a compacted view of the session and answers one question: is the goal
achieved, and if not, what steer gets the agent there? It escalates similar
steers through reframe tiers (directive, subgoal, pivot, minimal slice),
declares `done` when it judges the goal met, and gates on the model's
self-reported confidence.

Ledger mode keeps the chassis and changes the question. It never asks whether
the work is finished or on track; it asks whether the ledger matches what
happened and whether the model is internally consistent. Consequences:
- No tiers, no `done`, no idle steering, no confidence gate. "Continue" at
  idle is a no-op.
- Two deterministic findings steer the agent (missing `Ledger:` line, ledger
  claim contradicting the file hash). Everything a model judges goes to the
  human as a question and steers only on `/flag send`.
- Different input: the session goal and status sections are dropped; the
  ledger, the spec, model-file diffs and a register the supervisor maintains
  across turns are added.
- Different cadence: a code-only monitor every turn, and a sparse reviewer
  that may be a different, more capable model, run in a fresh session with
  extended thinking.
Both lines of pi-supervisor occupy the same hooks and role, so ledger mode
replaces them rather than running next to them.

### ruslanlap/memento
The skill defines a single `MEMENTO.md` with a strict shape (durable
constraints and decisions with evidence, observed state with evidence,
hypotheses that cannot authorise action, invalidated claims, one next
action) and a protocol for the next agent: wake up, verify the note against
reality, then continue. It has no runtime: nothing checks that the agent
kept the note, and it says so.

Ledger mode adopts the categories and the evidence rule almost unchanged and
supplies the missing runtime: the agent's `Ledger:` line is verified against
the file hash each turn; Acceptance and Checks are append-only, with edits
flagged; results must cite run ids from an append-only log the agent cannot
edit; superseded claims move to an archive with a one-line tombstone instead
of staying crossed out in the live file. The skill remains the agent-side
half: it is what tells the agent how to write and resume from the ledger.
Ledger mode does not reimplement its handoff protocol.

### waterdrop26651/pi-memento (Memento-skill)
A research-oriented tracker: current state as the entry point, separate
ledgers for runs and for contrasts (prediction, control, observed delta),
hypotheses with the evidence that would change them, an evidence log, and a
cold archive recalled only on a trigger. A validator checks schema and
cross-references. Nothing fires it; the agent must remember to update it.

Ledger mode shares two ideas with it: predictions written before a run, and
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

Ledger mode takes the stance (artefacts over narration, edit sections rather
than rewrite) and none of the mechanism. It never summarises, rolls over or
touches the context window, and it has no view on when a window should end.
The two are complementary and can run together: posthorse owns compaction
and rollover and writes handoffs; ledger mode checks the content of the note
and the coherence of the model. Two rules when both are installed: ledger
mode's `beforeCompaction` check should run before posthorse's rollover, and
ledger mode must never return a compaction result from
`session_before_compact`.

### davebcn87/pi-autoresearch
Autoresearch is an optimisation loop: run an experiment, measure a metric,
keep or discard, repeat, driven by a living prompt document and an
append-only JSONL log that its own tools write. Hooks before and after each
run can steer the agent, and after compaction it re-prompts the agent to
re-read its files from disk.

Ledger mode borrows exactly one thing: a run log written by the tooling,
not by the agent, that the agent cannot edit. It runs nothing, measures
nothing and decides nothing; `runs.jsonl` exists so that Observed entries can
cite a run id that the recorder, not the agent, produced. Both can be active,
but then autoresearch's living document and `MEMENTO.md` both claim to be the
state of the work. Either point autoresearch's document at the ledger or
tell the reviewer which one is authoritative.

### OthmanAdi/planning-with-files
It keeps `task_plan.md`, `findings.md` and `progress.md`, re-injects the plan
into every turn, has the agent recite it before tool calls, and hashes the
approved plan so that a tampered plan is not injected.

Ledger mode borrows the hash. Locked ledger sections work the same way:
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

Ledger mode keeps two principles: a claim needs more than one kind of
evidence, and budget counters never reach the agent. It is not a loop driver:
no lanes, no iteration budget, no metric, no decision tool, no
auto-continuation. The two do not conflict.

### Compaction replacements (Pi Continuity, pi-custom-compactor, pi-omni-compact, pi-vcc)
These own `session_before_compact` and replace Pi's default summary with
their own structured state. Ledger mode does not compact. Its only use of
that hook, when `beforeCompaction` is enabled, is to run the monitor and, if
the ledger is behind, ask the agent for one update before compaction
proceeds. It must not return a compaction result from the hook; the
compaction extension does that. Only one extension should own compaction in
a session, and that extension is not ledger mode.

## Research whose findings shaped the design

- Zhang et al., [*Agentic Context Engineering*](https://arxiv.org/abs/2510.04618)
  (2025): incremental delta updates; monolithic rewrites collapse context →
  the register and ledger are edited, never regenerated.
- Laban et al., [*LLMs Get Lost in Multi-Turn Conversation*](https://arxiv.org/abs/2505.06120)
  (2025): early assumptions persist; consolidated restarts recover → reset
  from the ledger.
- Martin & Roger, [*Classifier Context Rot*](https://arxiv.org/abs/2605.12366)
  (2026): monitor recall falls with transcript length; incremental checks,
  more reasoning and quote-first prompting help → per-turn monitoring,
  reviewer with extended thinking, quote-first findings.
- Tang et al., [*How Coding Agents Fail Their Users*](https://arxiv.org/abs/2605.29442)
  (2026), and [*Agents That Edit Documents*](https://arxiv.org/abs/2609.23953)
  (2026): inaccurate self-reporting grows as sessions go on; agents misreport
  their own edits → the Ledger line is a claim verified against the file hash.
- Zhong et al., [*ImpossibleBench*](https://arxiv.org/abs/2510.20270) (2025)
  and related reward-hacking work: isolating tests removes cheating →
  append-only Acceptance and Checks sections.
- Tsui, [*Self-Correction Bench*](https://arxiv.org/abs/2507.02778) (2025),
  the "self-correction blind spot": models correct an error when it is
  attributed to someone else, not when it is in their own output → reviewer
  in a fresh context, artefacts only.
- Norman, Rivera & Hughes, [*Reliability without Validity*](https://arxiv.org/abs/2606.19544)
  (2026), a 21-judge study, and Thakur et al.,
  [*Judging the Judges*](https://arxiv.org/abs/2406.12624) (2025): judge
  agreement is weaker than it looks; only the strongest judges align
  reasonably with humans → code verification of quotes, flags routed to the
  human, capable reviewer.
- Guo et al., [*When Context Changes*](https://arxiv.org/abs/2609.38866)
  (2026), and [*Unable to Forget*](https://arxiv.org/abs/2506.08184) (2025):
  stale values win over updates → superseded claims leave the live ledger.
- Luo, Kasirzadeh & Shah, [*The More You Automate, the Less You See: Hidden
  Pitfalls of AI Scientist Systems*](https://arxiv.org/abs/2509.08713) (2025):
  post-hoc selection bias → success criteria fixed and locked before fitting.
- Anthropic, [*Harness design for long-running application development*](https://www.anthropic.com/engineering/harness-design-long-running-apps)
  (2026): generator/evaluator separation and evaluators that check artefacts.
- Comparative evidence on specification checking (LLM verification such as
  [VeriSpec](https://arxiv.org/abs/2610.01847) vs test-based checks such as
  [CASCADE](https://arxiv.org/abs/2604.19400)): reading is low-precision,
  execution is high-precision → "no running of tests" is a deliberate
  non-goal, and reading-based flags are questions, not verdicts.
