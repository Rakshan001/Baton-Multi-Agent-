---
name: plan-review
description: >-
  Engineering-manager plan review that locks execution BEFORE any code exists. Challenges scope
  first — names the minimum change that achieves the goal, and treats a plan touching more than 8
  files or adding more than 2 services as a smell worth stopping for. Then reviews architecture and
  data flow, builds the error-and-rescue map (happy / nil / empty / upstream-failure for every new
  path), the edge-case map, a test matrix with coverage targets, and a performance pass over hot
  paths, caching and queries. Every finding carries an opinionated recommendation and asks for your
  call rather than assuming one. Ends in an explicit verdict. Use after a design doc or the
  validate-idea skill and before implementation, or when the user says "eng review", "review the
  architecture", "lock in the plan", or "check this plan before I build it". For a diff that
  already exists use code-review instead — this skill reviews plans, not code.
---

# Plan Review (portable)

Lock the execution plan before a line of code exists. Cheap here, expensive later.

⛔ **HARD GATE: write no code.** Not a scaffold, not a "quick example file". If you catch
yourself editing, you have left this skill.

```
SCOPE GATE (what am I reviewing?) → SCOPE CHALLENGE (is this the minimum?) →
ARCHITECTURE + DATA FLOW → ERROR & RESCUE MAP → EDGE-CASE MAP →
TEST MATRIX → PERFORMANCE → VERDICT
```

**Golden rules**
1. Review the plan, never write the code.
2. Challenge scope before reviewing quality — reviewing an overbuilt plan rigorously still
   ships an overbuilt plan.
3. Every finding gets a recommendation *and* a question. You advise; the user decides.
4. An unanswered question is a finding. "We'll figure it out during implementation" is the
   thing this skill exists to prevent.

---

## 0. Coordination pre-check *(Baton — skip if not wired in)*

```bash
baton signals 2>/dev/null || true
```

Read-only planning never blocks on a collision, but knowing another session is live in the
same area changes what you recommend. Recall what is already known before re-deriving it:
`recall_memory`, or `baton memory` from the terminal.

## 1. Scope gate

Ask what to review, and wait:

> A) A plan or design doc — paste it or name the path.
> B) A specific file, directory, or subsystem you are about to change.
> C) The shape of work already on this branch — reviewed as a *plan for what remains*, not as a
>    diff. For reviewing the diff itself, stop and use `code-review`.

Recommend A. Then look for a design doc:

```bash
ls -t docs/*-design*.md 2>/dev/null | head -5
```

Found one → read it; it is the source of truth for the problem statement and constraints.
None → offer the `validate-idea` skill first, which produces exactly that input. If the user
declines, proceed — just say the review is working without a stated problem statement.

## 2. Scope challenge

Before reviewing anything for quality, ask whether it should be built at all:

1. **What already solves part of this?** Map every sub-problem to existing code. Reuse beats
   rebuild — this is the `lean-code` restraint ladder applied to a plan.
2. **What is the minimum change that achieves the stated goal?** Name it explicitly. Flag
   everything deferrable without blocking the core objective.
3. **Complexity check.** More than 8 files touched, or more than 2 new services/classes →
   ⛔ STOP and ask whether to reduce scope or proceed as-is. Do not review past this silently.
4. **Built-in check.** For each pattern the plan introduces: does the runtime, framework, or
   stdlib already do this? Is the chosen approach still current practice? Known footguns?
5. **Completeness check.** Is the plan the complete version, or a shortcut that will need
   redoing? Name which, and say so.

## 3. Architecture & data flow

For each component, draw the flow — ASCII is fine and forces precision:

```
Input --> [Validate] --> [Transform] --> [Persist] --> Output
              |                              |
              v                              v
        [Error path]                   [Event / cache]
```

Then: state transitions for anything stateful, explicit API contracts (input type, output
type, **error type**), dependency direction, and the coupling points that will hurt later.

## 4. Error & rescue map

For every new data flow, trace four paths. An unanswered cell is a finding:

| Path | What happens | Who catches it | What the user sees | How they recover |
| --- | --- | --- | --- | --- |
| Happy | | | | |
| Nil / undefined input | | | | |
| Empty input (`""`, `[]`, `0`) | | | | |
| Upstream failure (timeout, 500) | | | | |

## 5. Edge-case map

Per user-visible interaction: double-click, navigate away mid-action, slow connection, stale
state, back button, empty state, first-run vs power user, concurrent actor. Each gets a
defined behaviour or becomes a finding.

## 6. Test matrix

| Component | Unit | Integration | E2E | Edge cases |
| --- | --- | --- | --- | --- |

Targets: happy path 100%, error paths 100%, edge cases 80%+, critical paths regression-tested.
Say what gets mocked, what runs live, and which test would have caught the failure you most
expect.

## 7. Performance

Hot paths and their latency budget. N+1 queries and unbounded loops. What gets cached, how it
is invalidated, and the TTL. New queries and the indexes they need. Streaming vs batch for
anything large.

## 8. Verdict

Write to `docs/YYYY-MM-DD-<slug>-plan-review.md`:

```markdown
# Plan Review: <feature>

**Date:** YYYY-MM-DD · **Target:** <plan / path / remaining work>

## Scope challenge
<minimum viable change, complexity check result, what to defer>

## Findings
| # | Section | Finding | Severity | Recommendation | User's call |
| --- | --- | --- | --- | --- | --- |

## Architecture / Errors / Edge cases / Tests / Performance
<the maps above>

## VERDICT
APPROVED · APPROVED WITH CONCERNS · REVISIONS NEEDED · REJECTED

## Unresolved decisions
<or: NO UNRESOLVED DECISIONS>
```

Record it *(Baton — skip if not wired in)*: prefer the `save_memory` MCP tool — it takes the
fact as a structured argument. The `baton memory add` CLI is the fallback; pass the fact as a
single quoted argv value and never build it by interpolating a URL or free text into a
double-quoted shell string, where a backtick or `$(…)` in a decision note would execute. Store the decision and its *reason* — a fact, not a diary entry.

## Evidence gate — before you write the verdict

⛔ A plan review's verdict decides whether someone spends days building. Take each finding and try
to **kill it** before it reaches the report — the same refute pass `code-review` runs, and the
reason `bug-fix` will not act below corroborated confidence:

- Can you point at the line of the plan that motivates this finding? If not, drop it.
- Is the "missing" error path handled somewhere you did not read?
- Is the complexity you flagged inherent to the problem, or to this approach? Only the second is a
  finding.
- Would this concern survive the author explaining their reasoning, or does it dissolve?

Anything you cannot ground in the plan's own text is an opinion. Say so, or cut it. And an
APPROVED verdict is a claim too — if you skipped a section for lack of input, the verdict says
"approved on the sections reviewed", never a bare APPROVED.

## Definition of done

- Scope was challenged before quality was reviewed, and the complexity check ran.
- Every new data flow has all four error paths answered.
- Every finding has a recommendation and an explicit user decision.
- A verdict is written, and unresolved decisions are listed or declared absent.
- No code was written.
