---
plan: memory-self-improving
goal: Stop the shared memory going dark, then let it improve itself — mechanically by default, and with a coding agent when the user turns that on
requireReview: true
---

## Context for every task in this plan

**Most of this feature already exists.** The 2026-07 research agreed four
rounds; three shipped. M1 BM25 recall is `src/memory-rank.ts` (in-memory FTS5,
zero-dep). M2 progressive disclosure is the preview rows plus `ids` hydration.
M4 zero-LLM auto-capture is `captureDecisions` in
`src/handoff/session-brief.ts`. Only M3, the stale-repair queue, is partial: it
*surfaces* a repair request and nothing mechanically re-anchors.

Do not rebuild any of the above. This plan repairs one defect in what shipped,
then builds on top of it.

**The defect, measured on this repo on 2026-09-05.** `recall_memory` returned
**3 fresh facts out of 12 — 9 withheld as stale.** Three of the withheld facts
carried the *same* three evidence anchors:

```
verify: [.gitignore, AGENTS.md, CODEBASE.md]
```

`src/handoff/session-brief.ts:249`:

```ts
const anchors = [...new Set([...inFlight, ...dirtyFiles.map(porcelainPath)])].slice(0, 8);
```

Auto-captured facts are anchored to **whatever files happened to be dirty in the
session**. Line 133 narrows to files the decision text names, but falls back to
*all* anchors when it names none — which is the common case, because a decision
is usually a sentence about behaviour, not a filename.

So a fact about test-suite flakiness was anchored to `.gitignore`. Unrelated
desktop work touched `.gitignore` and invalidated three unrelated facts at once.
One of them said the full test suite is timing-sensitive on a loaded machine —
which a later session re-derived from scratch across three test runs, because
the fact that already knew it had been withheld.

**This is not a staleness-checking problem. The capture path is asserting
evidence it does not have.**

**And it is destructive, not merely quiet.** `src/memory.ts:1155` — `baton
memory gc` *removes* facts whose anchored files changed, with the reason
`gc: stale anchor`. Under the bug above, gc deletes facts that were correct.

**The architecture this plan must respect.** Baton holds no API keys and buys no
tokens; it launches the user's own agent CLIs under their own credentials
(`src/spawn.ts`), and routes by load and rules (`suggestRoute`,
`agentActiveLoads`). So "LLM-assisted memory" here does **not** mean Baton
calling a model. It means Baton **delegating** the job to a coding agent the
user already runs — the same shape as hermes-agent's background review fork
(`agent/background_review.py`, MIT, Nous Research), and the reason a smaller or
idle agent can do the work while the main one keeps going.

**The tension to hold on to.** The point of this feature is *less*
hallucination. An agent rewriting the facts every other agent trusts is the most
direct way to introduce it. Every task that lets a model near the store must
constrain it to REORGANISING facts agents already wrote — merge, supersede,
re-anchor — and must reject, mechanically, any output that introduces a claim
not present in its inputs. That rule is not advice to the model; it is a check
in code.

**Cross-plan file conflicts — do not dispatch these together.**
`baton/plans/context-cost.md` edits `src/mcp.ts` and `src/mcp-help.ts`;
`baton/plans/agent-visibility.md` edits `src/server.ts`. Land one plan's tasks
on a file before starting another's.

**Non-goals:** no vector database and no embeddings — the research found no
published benchmark where local embeddings beat tuned BM25 at the hundreds-of-
facts scale this store operates at; no deletion of a user's fact by any
automated pass, ever — supersede and keep; no memory feature that requires the
daemon to be running in order for recall to work.

## Phase 1 — Stop the memory going dark

### memory-anchor-quality
**scope:** `src/handoff/session-brief.ts`, `test/memory-anchor-quality.test.ts`
**expects:** a captured fact is anchored ONLY to files it has evidence for — a path it names, or a symbol it names that resolves to a file — and a fact with no such evidence is saved with NO anchors rather than with the session's dirty list; anchoring never includes a file merely because it was dirty; repository-wide churn files cannot become anchors through the fallback path; the existing capture behaviour for facts that DO name a file is unchanged; a fact with no anchors still saves, and its freshness degrades by commit distance as it does today; re-running capture on the same decisions produces the same anchors; `npx vitest run` passes with no test deleted
**principles:** no anchor is better than a wrong one — an absent anchor makes a fact age slowly and honestly, while a wrong anchor makes it die suddenly and silently, and `baton memory gc` then deletes it; do not widen what capture stores, only what it CLAIMS as evidence; this task changes no schema and no read path
**skills:** bug-fix, test-driven-development
**model:** sonnet

Reproduce it before fixing it: capture a decision that names no file while three
unrelated files are dirty, and assert the fact does not claim them.

The regression test that matters most is the real one from this repo — a fact
about test timing must never end up anchored to `.gitignore`.

### memory-reanchor
**scope:** `src/memory-repair.ts`, `test/memory-reanchor.test.ts`
**expects:** given a fact whose anchored file changed, determines mechanically whether the change touched the evidence the fact depends on, and re-anchors to the current content hash when it did not; a change to an unrelated region of an anchored file re-anchors rather than marking stale; a change to the cited region leaves the fact stale with its reason intact; a deleted anchor file never re-anchors; the decision is deterministic, uses no LLM and no network, and is a pure function of the fact and the diff; a fact with no anchors is left alone; a binary or unreadable file is treated as "cannot tell" and left stale; `npx vitest run` passes
**principles:** when in doubt, stay stale — a wrongly-refreshed fact is served as trusted truth, which is the exact failure this whole subsystem exists to prevent, so the asymmetry must run toward withholding; pure function, no filesystem writes in this module
**skills:** test-driven-development, lean-code
**model:** sonnet

M3, finished. The repair queue currently tells a human "this might still be
true". Most of the time that judgement is mechanical: if the diff did not touch
the lines the fact cites, the fact still holds.

### memory-repair-wire
**after:** memory-anchor-quality, memory-reanchor
**scope:** `src/memory.ts`, `test/memory-repair-wire.test.ts`
**expects:** the staleness sweep offers re-anchored facts instead of withholding them where the mechanical check says the evidence is intact; `baton memory gc` NEVER removes a fact that the re-anchor check says is still valid; gc reports what it would remove and requires confirmation for anything it cannot mechanically justify; recall's existing withholding behaviour is unchanged for facts whose evidence genuinely moved; the fresh/aging/stale counts change in the direction the fix predicts and the test asserts the actual measured improvement on a fixture, not just "more"; `npx vitest run` passes with no test deleted
**principles:** gc deletes user data and must therefore be the most conservative code in this plan — an automated pass may supersede, never delete; keep `src/memory.ts` from growing: the decision logic lives in `memory-repair.ts` and this task only calls it
**skills:** bug-fix, code-review
**model:** sonnet

Connect the fix to the read path, and make the destructive command safe.

The acceptance number is the one this plan opened with: 3 fresh out of 12. If
the sweep does not move that on a fixture built from these facts, the repair is
not working and the test must say so.

### memory-anchor-migration
**after:** memory-anchor-quality, memory-reanchor, memory-repair-wire
**scope:** `src/memory-repair.ts`, `src/memory.ts`, `test/memory-anchor-migration.test.ts`
**expects:** a one-time pass drops anchors a fact has no textual claim to, keeping the fact's text, id, author, type and creation time exactly as they were; it NEVER deletes a fact; `dryRun` reports what would change without writing; it is idempotent; an anchor the fact names only by concept (`tmux` for `src/util/tmux.ts`) is KEPT, not dropped; every change is journalled so it can be traced; the measured effect on this repo is recorded in the test's header; `npx vitest run` passes
**principles:** the strictness here is the OPPOSITE of capture's and the code must say so — at capture, adding a wrong anchor is the costly error, so it is strict; here, dropping a real anchor leaves a fact nothing can ever invalidate, served as fresh forever, so it must lean toward keeping; a migration over someone's accumulated knowledge is previewable before it runs, or it is not shippable
**skills:** bug-fix, test-driven-development
**model:** sonnet

Fixing capture stops NEW facts being mis-anchored and does nothing for the ones
already damaged. Without this task, phase 1 changes no number a user can see:
measured before, 3 of 12 facts served; after, 9 of 12.

Dry-run it against a real store before trusting it. That is how the concept-name
false positive above was found.

## Phase 2 — Let it improve itself

### memory-capture-nudge
**scope:** `src/mcp-nudge.ts`, `test/memory-nudge.test.ts`
**expects:** a pure function decides whether an agent's next tool answer should carry a reminder to record what it has learned, based on how long the session has run and whether it has saved anything; the nudge is attached to an EXISTING tool answer and never sent as a tool of its own; it fires at most once per interval and never twice in a row; a session that has already saved memory recently is not nudged; the reminder is a few dozen characters, because it is paid for on the answers it rides; no clock reads inside the pure function — time is an argument; `npx vitest run` passes
**principles:** ride the channel that already exists — `groundMovedNotice` proves an answer can carry a message the agent did not ask for, and adding a tool would cost every session the schema tax that `baton/plans/context-cost.md` is about removing; a nudge that fires too often is ignored, which is worse than none because it also costs tokens
**skills:** test-driven-development, lean-code
**model:** sonnet

Hermes nudges its agent every ten turns (`_memory_nudge_interval`). Baton is not
inside the agent's loop, but it answers the agent's tool calls, and that is
enough. A session that dies without a handoff currently captures nothing.

### memory-consolidate
**scope:** `src/memory/consolidate.ts`, `test/memory-consolidate.test.ts`
**expects:** a mechanical pass over the fact store merges exact and near-duplicate facts by fingerprint, marks the older one superseded rather than deleting it, and never alters a fact's text; two facts that contradict each other are reported for a human rather than resolved; the pass is idempotent — running it twice changes nothing the second time; it is a pure function over facts in, operations out, so the caller performs the writes and the decisions are unit-testable; it never runs on a fact edited more recently than the pass started; a store at the 500-fact cap completes in under 100 ms; `npx vitest run` passes
**principles:** supersede, never delete, and never rewrite a human-or-agent-authored sentence — a consolidation pass that edits text is a consolidation pass that can change meaning; contradiction is a signal for a person, not a thing to resolve automatically
**skills:** test-driven-development, lean-code
**model:** sonnet

The zero-LLM default. This is what runs for every user whether or not they ever
open Settings, and it must be genuinely useful on its own.

### memory-consolidate-idle
**after:** memory-consolidate
**scope:** `src/daemons.ts`, `test/memory-consolidate-idle.test.ts`
**expects:** the daemon runs the mechanical pass when nothing else is happening, and never while a task is active; the pass is cancelled rather than queued if work starts; it is skipped entirely when the store has not changed since the last pass; a failure is logged and never crashes or degrades the daemon; `baton memory consolidate` runs the same pass on demand, so the feature works for someone who never leaves the daemon running; the daemon's existing responsibilities are untouched; `npx vitest run` passes
**principles:** idle means idle — a background pass that competes with an agent for CPU makes the tool slower at the exact moment it is being used; every background capability must have a manual equivalent, or users without a long-lived daemon silently get a lesser product
**skills:** lean-code, code-review
**model:** sonnet

Give the mechanical pass somewhere to run without anyone asking for it, and a
command for the people whose daemon is not running.

### memory-delegate
**after:** memory-consolidate
**scope:** `src/memory/delegate.ts`, `test/memory-delegate.test.ts`
**expects:** when enabled, builds a consolidation job for a coding agent and validates its result; the job's inputs — existing facts — are fenced as untrusted, because they were written by other agents and a fact is an injection path into the store every agent trusts; the validator REJECTS any produced fact that does not cite the ids it derives from, and any that introduces a token of claim not traceable to an input fact, and rejection is mechanical rather than a request to the model; produced facts are provenance-tagged as machine-generated and are distinguishable from agent-authored ones at every read; every operation is reversible and originals are superseded, never deleted; the feature is OFF unless explicitly enabled and the default configuration produces no agent launch; a malformed or truncated agent response changes nothing; the job is rate-limited and records what it spent; `npx vitest run` passes
**principles:** the model may REORGANISE, never ORIGINATE — this is the single rule that keeps a hallucination out of the store that every future session will treat as truth, and it must be enforced by the validator, not by the prompt; Baton launches the user's own agent under their own credentials and adds no permission-bypass flag; route the job like any other work, so it lands on an idle or cheaper agent rather than competing with the one the user is talking to
**skills:** security-review, test-driven-development
**model:** sonnet

This is the user's design: Baton does not buy tokens, it delegates. The same
shape as hermes' background review fork, using routing Baton already has.

The validator is the whole task. An agent that may only merge, supersede and
re-anchor facts that already exist cannot invent one — and that is what makes it
safe to point a small, cheap model at the knowledge base.

### memory-settings
**after:** memory-delegate
**scope:** `web/src/features/Settings.tsx`, `web/src/lib/api.ts`, `web/src/types.ts`
**expects:** a setting enables agent-assisted consolidation, OFF by default, stating plainly that it launches a coding agent under the user's own credentials and spends their tokens; the setting is disabled and explained in read-only mode; when off, the UI states that mechanical consolidation still runs; the last pass is shown with what it changed and what it cost; demo mode renders both states from fixtures; `npx tsc --noEmit` and `npm run build --prefix web` pass
**principles:** a toggle that spends the user's money must say so where the toggle is, not in documentation; never render machine-generated fact text as markup
**skills:** lean-code, security-review
**model:** sonnet

The switch, and the honest label on it. Someone turning this on is agreeing to
let Baton start an agent on their account while they are not watching, and the
screen has to say that in those words.

## Phase 3 — Every agent starts from the same place

### orient-every-agent
**scope:** `src/agents/connect.ts`, `test/orient-binding.test.ts`
**expects:** connecting an agent writes the instruction that makes it call `orient` at session start, in the form that agent actually reads — and the existing MCP server registration is unchanged; a re-run is idempotent and never duplicates an entry; an existing user-authored instruction file is merged into, never overwritten, and a backup path is reported; disconnecting removes exactly what was added and nothing else; an agent Baton cannot bind is reported as unbound rather than silently skipped; `npx vitest run` passes
**principles:** merge, never overwrite — these files are the user's own agent instructions and clobbering one loses work Baton did not create; the MCP `instructions` field is not enough on its own, because not every client surfaces it, which is why this task exists
**skills:** test-driven-development, lean-code
**model:** sonnet

`orient()` already returns a good budgeted brief; the gap is that only some
clients ever call it. This is what makes a different vendor's agent pick up a
session as well as the one that started it.

### memory-self-improving-docs
**after:** memory-repair-wire, memory-delegate
**scope:** `docs/memory.md`
**expects:** documents anchor rules and why a fact with no anchors is preferable to one with wrong anchors; documents the mechanical repair, what it can and cannot decide, and the bias toward withholding; documents both consolidation modes, that the agent-assisted one is off by default and spends the user's tokens, and the reorganise-never-originate rule with the fact that it is enforced in code; records the measured before/after withholding rate on this repo; records the hermes-agent attribution
**principles:** publish the measured numbers, including the bad one — 9 of 12 facts withheld is the reason this work happened and the baseline anyone judges it against
**skills:** lean-code
**model:** sonnet

Write the page someone reads when a fact they know is true stops being served,
and the page someone reads before deciding whether to let an agent near their
knowledge base.
