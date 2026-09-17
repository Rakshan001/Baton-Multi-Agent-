# Worktree visibility, liveness and recovery — design

**Date:** 2026-09-17
**Status:** proposed, awaiting review
**Implementation plan:** [`baton/plans/worktree-flow.md`](../../../baton/plans/worktree-flow.md) — 16 tasks, 4 phases

---

## The problem

> "my agents create multiple worktrees so other agent not aware of different
> worktree so one agent may be stopped in between so that worktree work will be
> paused, user will think that work is completed but that work will be lost if
> worktree is lost"

Three failures are bundled in that sentence and they need different fixes:

1. Agents cannot see each other's worktrees.
2. A stopped agent is indistinguishable from a working one.
3. Work in a lost worktree is gone.

The request arrived as "build a worktree graph." Four independent audits found
that the graph addresses none of the three.

## The evidence

### The dashboard launders dead work into looking fresh

`web/src/lib/derive.ts:10-16`:

```ts
if (s.status === "conflict") return "conflict";
if (s.agent === null) return "idle";      // fires first
if (s.status === "dirty") return "dirty"; // never reached
```

When an agent process dies, `agent` becomes `null`. The row is filed under
`idle`, labelled *"Idle · No agent attached"* — before the dirty check runs. A
crashed agent holding hours of uncommitted work renders identically to a task
nobody has started.

`status:'missing'` (`src/git.ts:110` — a recorded worktree whose directory is
gone) has no branch in the derivation at all and falls through the same way.

This is failure (2) and part of (3), in one line of code.

### The detection engine exists and its answer is thrown away

`src/liveness.ts:69` `livenessProbe` fuses an MCP/hook heartbeat with the newest
file mtime in the worktree. `src/pipeline.ts:229` `isStalled` applies a
45-minute grace. Both are correct and well-reasoned.

Every caller is a CLI command or an MCP tool: `src/commands/next.ts:136`,
`src/mcp-pipeline.ts:214`. `StatusRow` (`src/board.ts:14-28`) carries no
liveness field, so **the human's dashboard is the one surface that cannot see
stall.** No HTTP route calls `isStalled`, `takeable` or `livenessProbe`.

### The write path for recovery does not exist

`src/server.ts:28` imports only `cancelTasks, claim, releaseClaim` from the
lifecycle module. `POST /api/pipeline/claim` refuses an already-`active` task.
MCP is stdio-only (`src/mcp.ts:675`), so a browser cannot reach
`take_task {resume:true}` either.

There is no API path to adopt stalled work. "Click a node, hand it to another
agent" is impossible today regardless of what the UI looks like.

### Orphan detection is complete and entirely unwired

`src/cleanup.ts:80` `auditWorktrees` detects `orphan-worktree-task` (row without
directory) and `orphan-worktree-disk` (directory without row); `:115`
`auditBranches` finds `baton/*` branches with no task. Served at
`GET /api/doctor`. `grep -rl doctor web/src/` returns nothing.

### Nothing publishes a lifecycle change

No `bus.publish` call exists in `claim`, `activate`, `pause`, `block` or
`takeover`. A CLI `baton pause` runs in another process, and the daemon's only
reaction to `tasks.json` changing is re-syncing fs watchers
(`src/watch.ts:105-107`). Separately, `web/src/hooks/useEvents.ts:28-43`
whitelists 22 event types and drops `task.cancelled` — an event the dashboard
itself causes.

## Design

### 1. `health` is a four-state vocabulary, computed and never stored

The core decision. `isStalled` is a single 45-minute binary; a global constant
is what trains people to ignore a signal.

| State | Condition | Behaviour |
| --- | --- | --- |
| `working` | progress token advanced within the period | silent |
| `quiet` | token unchanged past period, inside grace | visible on the card; **no notification, no takeover offer** |
| `stalled` | past period + grace, liveness gone, held continuously | notify; offer takeover |
| `abandoned` | no process, no session, worktree on disk with unmerged or uncommitted work | notify; offer recovery |

Two properties make this work:

**The condition is progress, not silence.** A livelocked agent heartbeats
forever while achieving nothing, so "no signal for N" is the wrong test. The
progress token — commit count, `filesChanged`, the `report_progress` line —
already exists and is never diffed over time. Stall is *"the token has not
advanced, **and** liveness says something is nominally still there."*

**`quiet` is the state that makes the rest safe.** It is the two-stage
transition cron monitoring settled on (Healthchecks' *period* then *grace*;
Cronitor's duration assertions in both directions): a visible-but-silent step
before anything raises an alarm. Without it, every notification budget is spent
on false positives within a week.

A fifth value, `unknown`, is reported when the git calls behind a row fail.
It is not a state in the machine — it means the daemon could not answer, and it
must never be collapsed into `working`.

**Period and grace are global in v1**, derived from the existing
`STALL_GRACE_MS` rather than a new constant. Setting the period from each
task's own observed commit cadence — so a task that has committed every six
minutes for an hour is anomalous at twenty minutes of silence, while a research
task that made one commit in ninety is not — is a real improvement and a real
source of false positives if it is tuned badly. It is deliberately deferred
until the global version has been lived with, and is not in scope here.

Computed, never written — consistent with the existing doctrine in
`pipeline.ts` that stalled and locked are derived.

Over-eager detection is worse than none. In Kubernetes an aggressive liveness
probe causes cascading restarts; here "restart" means handing another agent
someone's dirty worktree, which is a data-loss operation rather than a retry.

### 2. One read-model: `GET /api/worktrees`

A single join over what four subsystems already know — `listWorktrees` (git's
own truth), `tasks.json`, `collectStatus`, `livenessProbe`/`isStalled`, and the
orphan items from `auditJunk`.

It serves the derived judgment, not just facts. Every consumer that
re-implements "is this stuck?" will disagree with the daemon exactly when it
matters — the mistake `Pipeline.tsx` was explicitly designed to avoid.

Two fields carry most of the value:

- **`holderRunning`** — is a process actually alive in this worktree, from
  `detectAgents` ∪ the headless registry. *"Agent claimed this, nothing is
  running"* is the single highest-value sentence this feature can say, and
  nothing surfaces it today.
- **`unprotected`** — uncommitted lines plus commits that exist only on this
  local branch. `src/board.ts:56` computes `ahead` against `baseBranch`
  *locally*; extending it to compare against the remote distinguishes
  "committed but nowhere else on earth" from safe. Sorted descending, this
  answers the reporter's fear directly: the top row is what you lose if the
  disk dies.

### 3. Agents learn about each other over MCP, not the dashboard

Agents do not read the dashboard. Baton tells them who holds which *files*
(`check_files`, `list_signals`) and never which *worktrees* exist, who holds
them, or which have gone quiet.

A `list_worktrees` MCP tool reading the same model closes failure (1). No UI
substitutes for it. The tool description plus schema must stay inside the
budget asserted by `test/mcp-help.test.ts` — schemas are the larger half of
per-session cost (see `baton/plans/context-cost.md`).

### 4. Uncommitted work is preserved without asking anyone

When a worktree enters `stalled` or `abandoned` with uncommitted changes, write
them to `refs/baton/wip/<slug>` as a dangling commit: invisible to
`git branch`, unaffected by `git worktree remove`, recoverable long after the
directory is gone.

Everything else in this design makes lost work *visible*. This is the only part
that makes it *not lost*, and it needs no UI. The precedent is Jujutsu's
auto-snapshot — the recoverable state must not depend on the agent remembering
to save. It also defuses the reported failure where an OS temp sweep removed a
worktree along with its 70-byte `.git` symlink.

The same precedent's cautionary half applies: a size guard, and gitignored
paths are never snapshotted, or the first thing captured is someone's `.env`.

### 5. Recovery is framed as rescue, not cleanup

`src/cleanup.ts` is written as *junk to delete*. The need here is *work to
rescue*. Same data, opposite verb — and the verb decides which button is
primary. Orphans and WIP refs are listed by unmerged commits descending, with
"recover into a new task" primary and delete secondary.

### 6. The canvas

A Worktrees screen built on `@xyflow/react` (React Flow — MIT, the library
n8n's canvas rewrite standardised on), replacing
`web/src/features/Canvas.tsx`.

`Canvas.tsx` is 415 lines of hand-rolled pan/zoom/drag with manual transform
maths, a localStorage layout map, a hand-written minimap, and no edge routing,
handles, grouping, collapse, selection model, keyboard support or layout
engine. It does not feel like n8n because it is missing the library.

Three constraints on the canvas:

- **Deterministic layered layout, never force-directed.** Non-deterministic
  layout means the same fleet looks different on every render, which makes
  "did anything change since I last looked?" unanswerable by eye.
- **Never re-seed the graph on a poll.** Merge fields into existing node
  objects keyed by slug so positions survive; `zoomToFit` once, on first load.
- **State is categorical, health is a modifier.** Reuse `TaskState` and
  `STATE_COLOR`; do not introduce a peer state the daemon never issues. Quiet
  time renders as a decay ring, so stall is shown as evidence rather than as a
  verdict.

Grouping uses React Flow's `parentId` + `extent:'parent'`. Collapse is not
built in — it is implemented by hiding descendants and rerouting the group's
edges. A collapsed group reports the **worst** child's health, not an average,
or collapsing becomes a way to hide problems.

## Decisions and rejected alternatives

### Rejected: stacked worktrees

Letting a task branch off another task's branch, so worktrees form a real git
tree. Rejected on three showstoppers:

- `src/integrate.ts:52` — a phase would report "integrated" when a child merges
  into its parent, inverting the barrier that stops agents building on moving
  foundations.
- `src/integrate.ts:106` — `group[0]!.baseBranch` trial-merges an entire phase
  onto one arbitrary task's base, inventing conflicts between siblings and
  missing real ones.
- `git branch -D` is reached unconditionally from `src/commands/rm.ts:61`,
  `src/cleanup.ts:262`, `:270` and `src/purge.ts:194` with no dependency check.
  Deleting a parent's base ref wedges `phaseIntegrated` permanently, with no
  recovery path in the product.

A fourth argument is decisive on its own: auto-rebase is not implementable
here. Baton has no positive "an agent is editing right now" signal — every
probe lags, is memoized, is capped, or sees only daemon-launched processes.
`takeover` deliberately refuses on *absence of proof of death*; auto-rebase
would mutate a worktree on *absence of proof of life*. Worse, a rebase rewrites
every file, so `newestMtimeIn` returns ~now and the task looks maximally alive
immediately after Baton touched it — attacking the stall detection this design
exists to provide.

The safe restack rule needs six simultaneous preconditions, which reduce to
"the child's agent is not working." A child nobody is working on does not need
to be current. Stacking's value and its only safe operation do not intersect.

Finally, it makes the reported problem worse: today a lost worktree loses one
task; in a stack, an abandoned parent strands every descendant, converting
independent failures into correlated ones.

The tree the canvas draws therefore comes from `planId` → `phase` → task plus
the `dependsOn` DAG — already validated acyclic at `src/plan.ts:470`, already
carrying transitive stranding at `src/pipeline.ts:406`. Same picture, no git
risk.

### Decision: keep the canvas, but sequence it last

Three audits argued the graph is decoration: a Baton repo is one root plus N
siblings, which is a star whose edges carry no information; the surveyed
category (16 agent-orchestration tools) ships zero graphs; and comparable DAG
views (GitHub's network graph, Airflow's Graph view, Jenkins Blue Ocean) were
deprecated, displaced or rolled back in favour of grids and lists.

The counter-argument is that node-link genuinely wins connectivity and path
tasks, and "if I abandon this worktree, what else breaks?" is one.

Resolution: the canvas is built, because it is what the product owner asked
for, but it is **Phase 3**. Phases 1–2 deliver the bug fix, the liveness
contract, the snapshot and the MCP tool without it. If the dependency is
rejected at review, only Phase 3 changes.

### Decision: new dependency in `web/`, not in the daemon

`@xyflow/react` is a deliberate exception to the project's minimal-dependency
habit and should be reviewed as one. It does not touch the zero-dependency
rule, which binds `src/server.ts`; `web/` already carries `react`,
`react-router-dom`, `force-graph` and `xterm`.

### Deferred: suspicious-completion detection

A task reaching `done` with zero files changed, or far faster than any prior
task in the repo, should be flagged and routed to review rather than green.
Justified by a 20,574-session study finding inaccurate self-reporting in 22.6%
of misalignment episodes, and the done-gate already refuses zero-commit tasks.

It attacks "the user thinks it is complete" from the opposite direction — the
agent lying rather than the agent dying — and deserves its own design.

### Out of scope: the `claim.ts` base-branch mismatch

`src/commands/claim.ts:193-196` computes `baseBranch` from `currentBranch(repo)`
then calls `createWorktree(..., 'HEAD', repo)`, recording one base and cutting
from another. `src/commands/new.ts:93-95` has the same shape. Harmless today
only because the two are the same commit. Its own fix, its own regression test.

## Error handling

- Every refusal is surfaced verbatim, never re-worded. `takeover`'s stall guard
  must not be weakened to make a button feel better — its refusal text is the
  product.
- `GET /api/worktrees` degrades per row: a worktree whose git calls fail
  reports `health:'unknown'` rather than omitting the row or reporting healthy.
  Silent degradation to "looks fine" is the bug this design exists to fix.
- Write verbs route through the existing central Origin gate; no per-endpoint
  CSRF check.
- Demo mode: no SSE, so the screen must not require it; fixtures live in a
  `web/src/lib/demo*.ts` module; anything needing a real daemon renders
  disabled with "Not available in demo mode" rather than hidden.

## Testing

- `wt-stopped-column` ships a regression test that fails without the reorder —
  the bug is a branch-ordering mistake, so only an ordering test catches it.
- `wt-health-api` tests each of the four states from fixed clock inputs; the
  state machine must be testable without sleeping.
- `wt-wip-snapshot` tests that the ref survives `git worktree remove`, that a
  clean worktree writes nothing, that a repeat with no change writes one ref,
  and that gitignored paths are excluded.
- `wt-lifecycle-events` tests that a CLI-originated pause reaches a connected
  SSE client.
- Demo fixtures cover busy, offline and empty for every new screen.

## Risks

| Risk | Mitigation |
| --- | --- |
| Notification fatigue trains users to ignore the real alert | `quiet` never notifies; only `stalled`, `abandoned` and needs-input do |
| `wt-wip-snapshot` captures a secret | size guard + gitignored paths excluded, tested |
| Canvas built and never used | sequenced last; Phases 1–2 stand alone |
| The read-model becomes a per-request git fan-out | reuse the poller's cached rows; document which numbers are cached |
| Two health vocabularies drift | one definition in the read-model, consumed by the MCP tool and the UI alike |
