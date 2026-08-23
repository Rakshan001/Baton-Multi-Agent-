---
plan: roadmap-parallel
goal: The Baton roadmap phases that have no unmet dependency, plus the one chain that unblocks the Orcabaton repo
requireReview: true
---

<!--
Written by the Orcabaton session. See docs/CHANGES-FROM-ORCABATON-SESSION.md.

  baton plan check roadmap-parallel
  baton plan apply roadmap-parallel
  baton plan approve roadmap-parallel     # prints exactly what would launch
  baton dispatch roadmap-parallel --max 3

Rewritten 2026-08-22. Five tasks were removed because they shipped:
  orca-backend       P4 — 30 agents launchable through the orca CLI
  dispatch-skill     P5 — the bundled skill a dispatched agent reads
  skill-git-exclude  Q22 — and it was two defects, not the one call it looked
                     like: installs excluded nothing (and the one caller that
                     did exclude named SKILL.md while missing references/), and
                     the HTTP route installed into the daemon root rather than
                     the worktree. Closed P30 in the other repo.
  model-endpoints    P15 — the `endpoints` block, the per-agent reach table,
                     and `baton doctor`. Landed in `src/endpoints/**`, NOT
                     `src/endpoints/**` as this plan first guessed: PLAN.md names
                     `src/endpoints/config.ts` and `reach.ts`, and `routing.ts`
                     was never touched. A literal credential refuses to load; a
                     keyRef that resolves to nothing marks the endpoint
                     unusable rather than calling the gateway without a key.
  launch-injection   P16 — per-launch env (never ~/.claude/settings.json), the
                     no-endpoint / endpoint-unreachable / endpoint-unauthorized
                     refusals, and the cost rule: a gateway outage NEVER
                     promotes a task onto a paid model without consent. Two
                     bugs in it were found by running it, not by testing it.

🔴 WHAT CHANGED, AND WHY IT MATTERS

As of 2026-08-22 the Orcabaton repo has NO startable task left — its plan file
was deleted rather than kept open with an invented task. Every phase it owns
waits on a certificate or on a phase in THIS repo. The project's critical path
is now entirely here.

There is no chain left. `model-catalog` (P17) is the last thing standing
between the current state and Orcabaton's P19, and it now has no unmet
dependency — model-endpoints (P15) and launch-injection (P16) both shipped on
2026-08-22, and P27 is unblocked already. Nothing else on this list unblocks anything, so if only one agent is
working, it should start at the head of that chain.

Everything is in phase 1 on purpose: the phase barrier is for work that must
not overlap, and none of this must not. Real ordering is `after:`, which gates
one task without holding back the others.
-->

## Phase 1 — everything that can start now

### model-catalog
**scope:** `src/endpoints/**`, `src/server.ts`
**expects:** a live catalog of reachable models with health; a model that goes away is reported, not cached as healthy

P17. **This is the task that unblocks Orcabaton's P19 fleet pane** — the last
phase in the other repo that is waiting on engineering rather than on a
certificate.

### graph-extractor
**scope:** `src/kb/extract/**`, `src/kb/projects.ts`
**expects:** a TypeScript/WASM extractor produces a graph without the graphify Python dependency; existing graph consumers keep working
**principles:** the current graphify path must keep working until this replaces it

P11. Load-bearing for P12 and for Orcabaton's P21.

Now measurable rather than assumed: this repo's `graphify-out/graph.json` is
**144,502,085 bytes for 98,266 nodes and 286,680 links** — the file is mostly
pretty-printing. `/api/kb/neighbours` (2026-08-22) parses it in 464 ms and
retains 94 MB, which is what a replacement has to beat. Emitting compact JSON
would be most of the win on its own.

### grammar-packaging
**after:** graph-extractor
**scope:** `src/kb/extract/**`
**expects:** grammars ship with the binary; a rebuild after one file changes does not re-parse the repo

P12. Genuinely blocked on the extractor, which is why it carries `after:`
rather than sitting in a later phase.

### kb-sync
**scope:** `src/kb/state.ts`, `src/kb/transfer.ts`, `src/federation.ts`
**expects:** two members converge on one knowledge base; a member offline during a rebuild catches up rather than diverging

P13. Independent of the extractor: it moves whatever the graph currently is.

### incident-reporting
**scope:** `src/reports.ts`, `src/evidence.ts`
**expects:** a report is opt-in, readable before it is sent, and never leaves the machine unasked
**principles:** no telemetry without an explicit action

P22. Small and self-contained.

### supervisor-role
**scope:** `src/access.ts`, `src/operator.ts`, `src/members.ts`
**expects:** a supervisor can approve what an operator cannot; the chain is recorded and inspectable

P23. Touches the access rules, so it should not run in the same window as
anything else that edits `access.ts` — nothing else here does.

### fleet-enrollment
**scope:** `src/teams.ts`, `src/host-link.ts`
**expects:** a machine joins a fleet and appears in the roster; leaving revokes it

P18. Independent of P15–P17 despite the shared "fleet" word: this is
enrollment, those are models.

### neighbours-index-per-project
**scope:** `src/kb/neighbours.ts`
**expects:** a hub daemon serving several projects answers graph queries for all of them without re-parsing on every switch

Follow-up to the 2026-08-22 neighbours work, and the one thing I knowingly left
single-project. The index is global and keyed by one graph path, so a hub
daemon will thrash between projects: every alternating query pays the full
parse (464 ms and a 328 MB peak on this repo's graph).

A small LRU keyed by graph path fixes it. It is deliberately NOT urgent — the
single-project case is correct today, and guessing at hub usage before anyone
runs one is how the wrong cache size gets baked in.
