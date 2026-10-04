# Credits and lineage

Ledger mode changes what the supervisor supervises, but almost every mechanism in it has a visible ancestor. No code was copied from the projects below except the fork itself; `checks.ts` and `register.ts` are new. Check each project's licence before copying any text or code from it.

## Code lineage

- [monotykamary/pi-supervisor](https://github.com/monotykamary/pi-supervisor) (MIT), itself a fork of [tintinweb/pi-supervisor](https://github.com/tintinweb/pi-supervisor). The chassis: supervisor in a separate in-memory Pi session; algorithmic input building that strips thinking and collapses tool calls; `SUPERVISOR.md` overriding the system prompt; user-voice steering; `/supervise`; state persisted in the session file. Ledger mode replaces its goal-completion semantics (reframe tiers, `done`, idle steering) with ledger and coherence checks.

## Designs borrowed from other Pi extensions and skills

- [ruslanlap/memento](https://github.com/ruslanlap/memento) — the ledger's categories and discipline: evidence attached to every claim, hypotheses that cannot authorise action, invalidated claims kept as "false claims a future agent might repeat", one verifiable next action, verify-before-act. The file name `MEMENTO.md` comes from here.
- [waterdrop26651/pi-memento](https://github.com/waterdrop26651/pi-memento) (Memento-skill) — predictions written before a run, hypotheses recorded with what evidence would change them, and a cold archive recalled only when needed. Our locked `## Checks` section and `MEMENTO.archive.md` follow this.
- [fitchmultz/pi-posthorse](https://github.com/fitchmultz/pi-posthorse) — treating older assistant prose as not being state, editing a current-state note section by section rather than rewriting it, and resetting from the note instead of summarising. Our "artefacts over narration" rule and reset-from-ledger practice follow this.
- [davebcn87/pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) — a tool-written, append-only run log that the agent cannot edit; re-reading files from disk after compaction. Our `runs.jsonl` and run recorder follow this.
- [OthmanAdi/planning-with-files](https://github.com/OthmanAdi/planning-with-files) — re-injecting the plan each turn and hashing an approved plan so tampering blocks injection. Our append-only locked sections and the optional anchor re-injection follow this.
- [lhl/pi-multiloop](https://github.com/lhl/pi-multiloop) — compound verifiers, and keeping work counters out of the agent's view so they are not read as a context gauge.
- [thebabush/pi-memento](https://github.com/thebabush/pi-memento), [ttttmr/pi-context](https://github.com/ttttmr/pi-context), pi-rollback — agent-driven context transactions and branch summaries. Not in the plugin, but they shaped the recommendation to run side explorations as `/tree` branches.
- [aerovato/operator-memory](https://github.com/aerovato/operator-memory) — the starting point of the discussion; its observation that agents favour the status quo and hesitate to restructure documents is one reason the ledger is kept small and append-only.
- [monotykamary/pi-loop](https://github.com/monotykamary/pi-loop) — the anti-oscillation discussion behind "never repeat a steer".

## Research whose findings shaped the design

- Zhang et al., *Agentic Context Engineering* (2025): incremental delta updates; monolithic rewrites collapse context → the register and ledger are edited, never regenerated.
- Laban et al., *LLMs Get Lost in Multi-Turn Conversation* (2025): early assumptions persist; consolidated restarts recover → reset from the ledger.
- Martin & Roger, *Classifier Context Rot* (2026): monitor recall falls with transcript length; incremental checks, more reasoning and quote-first prompting help → per-turn monitoring, reviewer with extended thinking, quote-first findings.
- *Agents That Edit Documents* (2026) and Tang et al., *How Coding Agents Fail Their Users* (2026): agents misreport their own edits → the Ledger line is a claim verified against the file hash.
- *ImpossibleBench* (2025) and related reward-hacking work: isolating tests removes cheating → append-only Acceptance and Checks sections.
- *Self-Correction Blind Spot* (2026): models catch errors in others' work, not their own → reviewer in a fresh context, artefacts only.
- Norman, Rivera & Hughes, 21-judge study (2026) and Thakur et al. (2025): judge agreement is weaker than it looks; small judges are worst → code verification of quotes, flags routed to the human, capable reviewer.
- *When Context Changes* (2026) and *Unable to Forget* (2025): stale values win over updates → superseded claims leave the live ledger.
- Lu et al., *Hidden Pitfalls of AI Scientist Systems* (2025): post-hoc selection bias → success criteria fixed and locked before fitting.
- Anthropic, *Harness design for long-running application development* (2026): generator/evaluator separation and evaluators that check artefacts.
- Comparative evidence on specification checking (VeriSpec-style LLM verification vs test-based CASCADE-style checks): reading is low-precision, execution is high-precision → "no running of tests" is a deliberate non-goal, and reading-based flags are questions, not verdicts.
