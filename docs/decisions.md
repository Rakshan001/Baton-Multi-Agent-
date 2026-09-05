<!-- Copyright (C) 2026 Rakshan Shetty -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Decisions

Decisions that are **not derivable from the code** — the trade-offs, the roads
not taken, and the reasons a later reader would otherwise have to guess at.

A decision belongs here when reversing it would need an argument, not just an
edit. Conventions the code already enforces belong in [CLAUDE.md](../CLAUDE.md);
what was learned while working belongs in project memory (`baton memory`).

Newest last. Never rewrite a decision — supersede it with a new one and say so.

---

## D-001 — Handoff briefs are closed by the agent that finished them

**2026-09-05**

Nothing in the codebase ever wrote `status: done`. `GET /api/handoffs` filtered
closed briefs out of the pickup list, but no code path ever closed one, so
briefs accumulated indefinitely — this repo had twenty open, nearly all derived
automatically from git state at session death.

Closing is now part of finishing the work: `resolve_handoff` (MCP) and
`POST /api/handoffs/:slug/resolve`.

**Why the agent and not a sweeper.** A time-based or heuristic sweeper would
close briefs whose work never happened. Only the agent that did the work knows
it is done, so the close is an explicit act with an author on it.

**Closing appends, never replaces.** The brief records what was *asked*; the
completion note records what *happened*. A reviewer needs both. Re-resolving
replaces the report rather than stacking a second one, so an agent retrying
after a dropped connection cannot corrupt the record.

---

## D-002 — A blocked handoff stays copyable

**2026-09-05**

The pipeline panel dims a brief whose dependencies are unfinished and says what
it waits on, but its copy button still works.

A person may deliberately work out of order — to unblock themselves, to test
something, because they know the dependency is irrelevant today. A UI that
refuses is worse than one that warns: it converts a judgement call into a
support problem, and the user's next move is to bypass the tool entirely.

---

## D-003 — Untrusted quoting does not apply to skills, so skills need a review gate

**2026-09-05**

`src/handoff/untrusted.ts` fences text Baton did not write, and it is applied to
plan task text and handoff bodies. It is deliberately **not** applied to
imported skills.

A handoff brief is *data about* work. A skill **is instructions** — `installSkill`
writes it to `.claude/skills/<id>/SKILL.md`, where the agent's own harness loads
it as directive text. Quoting it as untrusted would break the feature it exists
to provide.

So the defence for a downloaded skill cannot be a quoting rule. It has to be a
**review gate**: scan, quarantine, and a human release. Planned in
[`baton/plans/skill-guard.md`](../baton/plans/skill-guard.md).

Corollary: a scanned skill is **unreviewed**, never *safe*. A regex scanner
cannot decide intent, and any wording that implies otherwise buys trust the code
cannot honour.

---

## D-004 — A memory fact may only claim evidence it names

**2026-09-05**

Auto-capture anchored every fact to whatever files were dirty in the session.
Measured on this repo: ten of eleven facts carried the *same eight* anchors —
one session's entire dirty set — including `.gitignore`, `AGENTS.md` and
`CODEBASE.md`. Unrelated work touched `.gitignore` and withheld them all at
once. `recall_memory` returned **3 fresh facts out of 12**.

An anchor is a claim: *if this file changes, re-check me*. Claiming a file the
fact says nothing about is not weak evidence, it is **false** evidence — and
`gcMemories` acts on it by deleting the fact.

A fact that names no file is now saved with **no anchors at all**. That is worse
for freshness and better for honesty: an anchorless fact ages slowly on commit
distance, where a wrongly-anchored one dies suddenly on somebody else's churn.

The retroactive repair (`pruneUnclaimedAnchors`) took this repo from 3 of 12
served to 9 of 12.

---

## D-005 — Repair asks what changed, not whether the words survived

**2026-09-05**

`repairMemories` re-anchored a stale fact when its verifiable terms still
appeared anywhere in the anchored file. That is too weak, and it was live:

```
fact:  "CSRF_GUARD is enabled in src/server.ts"
file:  const CSRF_GUARD = true;  →  const CSRF_GUARD = false;
```

The term survives. The claim is now false. Repair refreshed it and served it as
verified truth.

`assessAnchor` compares what **changed** against what the fact names. A change
landing on a line the fact names is treated as **undecidable** and left for
review.

**The cost, accepted deliberately.** `"MAX_RETRIES lives in config.ts"` survives
`3 → 5`; `"CSRF_GUARD is enabled"` does not survive `true → false`. Same shape,
opposite answers, and the difference is semantic — exactly what a mechanical
pass cannot read. So recall-time repair now heals fewer facts than it did.

The asymmetry runs toward withholding because the costs are not symmetric: a
withheld-but-true fact costs one re-derivation; a refreshed-but-false one is
served to every later session as truth. Locked by a test that states this;
loosen it in `assessAnchor`, not by deleting the test.

---

## D-006 — Capture and migration use the same matcher at different strictness

**2026-09-05**

Both ask "does this fact name this file?", and both were briefly given one
shared predicate. Dry-running the migration on the real store showed why that
was wrong: a fact reading *"cross-process agent locks go through tmux session
names"* was about to lose its `src/util/tmux.ts` anchor, because it says `tmux`
and not `tmux.ts`.

The cost of being wrong is **opposite** in the two directions:

| | Risky act | Therefore |
|---|---|---|
| **Capture** | adding a wrong anchor → false evidence, fact dies on churn | strict: path or full basename |
| **Migration** | dropping a real anchor → nothing can ever invalidate the fact, served fresh forever | lenient: also the basename's stem |

`claimedFiles(text, paths, { stem })` — one implementation, one option, and the
reason recorded here so nobody unifies them again for tidiness.

---

## D-007 — Agent-assisted memory delegates to a coding agent; Baton never calls a model

**2026-09-05**

Baton holds no API keys and buys no tokens. It launches the user's own agent
CLIs under their own credentials. An LLM-assisted memory feature that required
Baton to have a billing relationship would break that.

So when agent-assisted consolidation is enabled, Baton **delegates**: it builds
a job and routes it to an idle or cheaper agent the user already runs — the same
shape as hermes-agent's background review fork, using routing Baton already has.

Default **off**, with a Settings toggle that says, next to itself, that it
spends the user's tokens in the background.

**The rule that makes it safe: the model may REORGANISE, never ORIGINATE.**
Merge, supersede, re-anchor — nothing else. Every produced fact must cite the
ids it derives from, and anything containing a claim not traceable to an input
is rejected **by a validator in code**, not by asking the model in a prompt.
A model that cannot invent cannot hallucinate into the store, which is what
makes it safe to point a small, cheap model at the knowledge base.

Consolidation inputs are facts written by other agents, so they are fenced as
untrusted: otherwise a poisoned fact is an injection path into the store every
agent trusts.

Planned in
[`baton/plans/memory-self-improving.md`](../baton/plans/memory-self-improving.md).

---

## D-008 — Tool sets come from configuration, never from inferred state

**2026-09-05**

A real `tools/list` handshake costs **10,672 bytes (~2,668 tokens)** per session
— 3,160 in descriptions, which `test/mcp-help.test.ts` budgets, and **5,687 in
input schemas, which nothing budgeted**. The existing test measured the source
rather than the payload, and so had been policing the smaller half.

Tool sets will cut that. They must resolve from **configuration**, not by
inferring what a session needs from mutable state.

The MCP SDK does support `enable()`/`disable()` and `sendToolListChanged()`, but
clients that cache `tools/list` at connect and ignore the notification would
never see a tool that appeared later. A tool set keyed on "does a handoff exist
right now" would silently differ per client — the worst kind of bug, because it
reproduces nowhere.

An unknown tool-set name is refused loudly rather than resolving to the empty
set: an empty set presents as a broken Baton rather than as a typo.

---

## D-009 — Spend that cannot be measured is reported as absent, never as zero

**2026-09-05**

`src/usage.ts` parses real token usage from Claude Code's session files and
hardcodes `agent: 'claude'`. For a hub built to run several agents at once, a
total that silently covers one of them is not incomplete — it is **misleading**.

Checked on a real machine rather than assumed:

| Agent | Verdict |
|---|---|
| Claude | parsed |
| Codex | parseable — `~/.codex/sessions/**/rollout-*.jsonl` carries `cwd` plus `input_tokens` / `cached_input_tokens` / `output_tokens` |
| Antigravity | partial — a sparse `tokenCount`, no input/output split, so no cost basis |
| Cursor | nothing found to parse |

Where a number cannot be measured it is shown as **absent**, never as `0` or
`$0.00`, and partial data is labelled at the number rather than in a footnote.
"Partial data, clearly labelled" is a successful outcome; a guessed cost sitting
beside two measured ones is the failure being avoided.

---

## D-010 — The dashboard shows plan approval state but never performs it

**2026-09-05**

`pipeline-view.ts` derives the plan list from `tasks.map(t => t.planId)`, so a
plan file that has never been applied appears nowhere. The approval checkpoint
the whole dispatch safety model rests on is the one thing the UI cannot show.

The plan screen will list every plan on disk with its state, and will stay
**read-only**: it shows the `baton plan approve` command rather than offering a
button.

Approval is recorded against the plan's exact bytes, and its entire value is
that a person read them. A button invites approving without reading, which
would leave the checkpoint in place while removing what it checks.
