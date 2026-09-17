---
plan: worktree-flow
goal: Make every live worktree visible, honest about whether it is actually
  moving, and recoverable by another agent — on an n8n-style flow canvas that
  can collapse a group and merge from a node
requireReview: true
---

## Context for every task in this plan

#### The problem, in the reporter's words

> "my agents create multiple worktrees so other agent not aware of different
> worktree so one agent may be stopped in between so that worktree work will be
> paused, user will think that work is completed but that work will be lost if
> worktree is lost"

Three distinct failures are bundled in that sentence, and they have different
fixes:

1. **Agents cannot see each other's worktrees.** There is no MCP tool and no
   HTTP route that answers "what worktrees exist and who holds them."
2. **A stopped agent is indistinguishable from a working one.** The signal that
   tells them apart is computed and never served.
3. **A lost worktree renders as healthy.** This one is a four-line bug.

#### What already exists (audited 2026-09-17, three independent passes)

Most of this feature is built. It is not exposed. Do not rebuild any of it.

| Capability | Where | Served over HTTP? | Drawn in the UI? |
| --- | --- | --- | --- |
| Stall detection | `src/pipeline.ts:229` `isStalled`, `:239` `takeable`, `:55` `STALL_GRACE_MS` | **no** | no |
| Liveness (heartbeat ∪ worktree mtime) | `src/liveness.ts:69` `livenessProbe`, `:33` `newestMtimeIn` | **no** | no |
| Takeover of stalled work | `src/lifecycle.ts:149` `takeover` | **no** | no |
| Pause / block | `src/lifecycle.ts:185` / `:255` | **no** (block readable via `/api/pipeline`) | partial |
| Orphan worktree / branch audit | `src/cleanup.ts:80` `auditWorktrees`, `:115` `auditBranches` | `GET /api/doctor` | **no client at all** |
| Uncommitted work, conflicts, churn | `src/git.ts:338` `worktreeStatus`, `:127` `hasUnsavedWork` | `/api/status` | partial |
| Mid-rebase / mid-merge state | `src/git.ts:314` `repoState` | `/api/status` | **no** |
| Ahead / behind | `src/git.ts:410` `aheadBehind` | `/api/status` | yes |
| Which agent process is in which worktree | `src/agents.ts:195` `detectAgents` | `/api/status` | yes |
| Live edit signals + agent progress notes | `src/signals.ts:867` `getSignals` | `/api/signals` | notes never rendered |
| Progress ledger (plan / next action / flagged) | `src/handoff/progress-ledger.ts:43` | **no route** | no |
| Resume prompt, pre-fenced | `src/handoff/resume.ts:103` `resumePromptFor` | `GET /api/handoffs` | Handoff inbox only |
| Load-aware handoff target | `src/handoff/workload.ts:52` `pickHandoffTarget` | `/api/tasks/:slug/suggest-handoff` | Handoff dialog |
| Draggable worktree canvas | `web/src/features/Canvas.tsx:45` | n/a | yes — see below |

#### Why the existing canvas is being replaced, not extended

`web/src/features/Canvas.tsx` is 415 lines of hand-rolled pan/zoom/drag: manual
transform math, a `localStorage` layout map, a hand-written minimap, and
`autoLayout` that drops nodes into board lanes. It has no edge routing, no
handles, no grouping, no collapse, no selection model, no keyboard support and
no layout engine. Its only edges are conflict-file overlaps computed O(n²) at
`Canvas.tsx:68-76`.

That is why it does not feel like n8n: n8n's editor canvas is built on **React
Flow** (`@xyflow/react`), and the hand-rolled version is missing the library.

#### Decision: add `@xyflow/react` to `web/`

MIT licensed, maintained by the xyflow team, and the same library n8n's canvas
rewrite standardised on. It brings multi-selection, panning, zooming, keyboard
shortcuts, and production `MiniMap` / `Controls` / `Background` components —
all of which `Canvas.tsx` currently reimplements badly or not at all.

**This is a deliberate exception to the project's minimal-dependency habit and
must be reviewed as one.** It does NOT touch the zero-dependency rule, which
binds `src/server.ts` (raw `node:http`, per CLAUDE.md); `web/` already carries
`react`, `react-router-dom`, `force-graph` and `xterm`. If review rejects the
dependency, Phase 3 is the only phase that changes — Phases 1, 2 and 4 stand on
their own and deliver the reported bug fixes without any canvas at all.

Grouping and collapse: React Flow supports parent/child nodes via `parentId`
plus `extent: 'parent'`. Collapse is **not** built in — it is implemented by
setting `hidden` on descendants and rerouting the group's edges to the group
node. Phase 3 owns that.

#### Scope boundary: no stacked worktrees

An earlier draft proposed letting a task branch off another task's branch, so
worktrees would form a real git tree. A dedicated audit found three
showstoppers and the idea is dropped:

- `src/integrate.ts:52` — a phase would report "integrated" when a child merges
  into its parent, inverting the barrier that stops agents building on moving
  foundations.
- `src/integrate.ts:106` — `group[0]!.baseBranch` trial-merges a whole phase
  onto one arbitrary task's base.
- `git branch -D` is reached unconditionally from `src/commands/rm.ts:61`,
  `src/cleanup.ts:262`, `:270` and `src/purge.ts:194` with no dependency check
  anywhere. Deleting a parent's base ref wedges `phaseIntegrated` permanently
  with no recovery path in the product.

The tree the canvas draws therefore comes from **`planId` → `phase` → task plus
the `dependsOn` DAG** — already validated acyclic at `src/plan.ts:470`, already
carrying transitive stranding at `src/pipeline.ts:406` `blastRadius`. Same
picture on screen, no git-semantics risk.

#### The bug this plan must not lose sight of

`web/src/lib/derive.ts:10-16`:

```ts
if (s.status === "conflict") return "conflict";
if (s.agent === null) return "idle";      // ← fires first
if (s.status === "dirty") return "dirty"; // ← never reached
```

When an agent process dies, `agent` becomes `null`, so the row is filed under
`idle` — labelled *"Idle · No agent attached"* — **before the dirty check
runs**. A crashed agent holding hours of uncommitted work renders identically
to a task nobody has started. `status:'missing'` (`src/git.ts:110`, a recorded
worktree whose directory is gone) has no branch at all and falls through the
same way.

That is the reported symptom in one line of code: the dashboard launders dead
work into looking fresh. Fixed in Phase 1, dependent on nothing else here, and
worth more than the entire canvas.

#### The state vocabulary: four names, not a boolean

`isStalled` (`src/pipeline.ts:229`) is a single 45-minute binary. A global
constant is what trains people to ignore a signal. Cron monitoring solved this
with two numbers and a two-stage transition (Healthchecks' *period* then
*grace*; Cronitor's duration assertions in both directions), and Kubernetes
names the distinction that matters: liveness catches *"an application that is
running, but unable to make progress."*

So `health` is four computed names, never stored — consistent with the existing
"stalled and locked are COMPUTED, never written" doctrine in `pipeline.ts`:

- **`working`** — the progress token advanced within the period. Silent.
- **`quiet`** — token unchanged past the period, still inside grace. **Visible
  on the card, no notification, no takeover offer.** This is the state that
  buys zero false alarms: a human can see it before anything shouts.
- **`stalled`** — past period + grace, and liveness is gone. Notify, offer
  takeover. Must hold continuously, not fire on one sample.
- **`abandoned`** — no process, no session, worktree still on disk with
  unmerged or uncommitted work. The terminal state the reporter is afraid of.

The **progress token** is the point. "No signal for N" is the wrong condition —
a livelocked agent heartbeats happily forever while making zero progress. The
token is what already exists and is never diffed over time: commit count,
`filesChanged`, and the `report_progress` line. Stall is "the token has not
advanced, *and* liveness says something is nominally still there."

Over-eager detection is worse than none. In Kubernetes an aggressive liveness
probe causes cascading restarts; here "restart" means handing another agent
someone's dirty worktree, which is a data-loss operation, not a retry.

#### A follow-up this plan deliberately does not cover

A task that reaches `done` with zero files changed, or far faster than any
prior task in the repo, should be flagged `suspicious-completion` and routed to
review rather than green. Justified by a 20,574-session study finding
inaccurate self-reporting in 22.6% of misalignment episodes, and the done-gate
already refuses zero-commit tasks, so the hook exists. It attacks "the user
thinks it is complete" from the opposite direction to `wt-stopped-column` — the
agent lying rather than the agent dying. Its own plan; not this one.

#### A separate, unrelated bug found on the way in

`src/commands/claim.ts:193-196` computes `baseBranch` from `currentBranch(repo)`
and then calls `createWorktree(..., 'HEAD', repo)` — it records one base and
cuts from another. `src/commands/new.ts:93-95` has the same shape. Harmless
today only because the two are the same commit. **Not in this plan** — it wants
its own fix and its own regression test. Filed here so it is not forgotten.

#### Conventions that bind every task below

- Daemon stays zero-dependency: `src/server.ts` is raw `node:http`.
- Realtime is SSE. A new event type goes in `src/events.ts` FIRST, then in the
  client whitelist at `web/src/hooks/useEvents.ts:28-43`, or the browser drops
  it silently.
- Demo mode must keep working. Every new client method takes the
  `if (this.demo) { await this.demoGate(n); return FIXTURE; }` shape; fixtures
  live in a `web/src/lib/demo*.ts` module, never inline in a component. Gate
  anything needing a real daemon to disabled + "Not available in demo mode",
  never hidden. There is no SSE in demo (`useEvents.ts:63`).
- Git calls go through `src/util/exec.ts`.
- Strict TypeScript in both workspaces.
- Never assemble a resume prompt in the browser. `web/` cannot import `src/`, so
  a browser-side fence would be a second implementation of a security
  primitive — the daemon serves it pre-built (`src/handoff/resume.ts:33-40`).

---

## Phase 1 — Serve the truth

*Nothing in this phase has a UI dependency. All three tasks are independently
useful and together they fix the reported bug.*

### wt-health-api
**scope:** `src/worktrees.ts`, `src/server.ts`, `test/worktree-health.test.ts`
**expects:** `GET /api/worktrees` returns one row per worktree with `slug`, `branch`, `worktreePath`, `state`, `health`, `quietForMs`, `lastActivityAt`, `unprotected`, `filesChanged`, `ahead`, `behind`, `repoState`, `agent`, `claimedBy`, `holderRunning`, `planId`, `phase`, `dependsOn`, `orphan`, `wipRef`; `health` is one of `working|quiet|stalled|abandoned` plus the git-truth modifiers, computed and never stored; a row whose git calls fail reports `unknown` and never `working`; a worktree with a dead holder and uncommitted work reports `abandoned`; vitest `test/worktree-health.test.ts` passes; the route is read-only and needs no `--write`

One read-model, joining what four subsystems already know. There is no
`/api/worktrees` today — `listWorktrees` (`src/git.ts:201`) is called only from
`src/cleanup.ts:218` and the CLI, never from a route.

Join, per worktree: `listWorktrees` (git's own truth) + `tasks.json`
(`src/store.ts:22`) + `collectStatus` (`src/board.ts:30`) + `livenessProbe`
(`src/liveness.ts:69`) + `isStalled` (`src/pipeline.ts:229`) + the orphan items
from `auditJunk` (`src/cleanup.ts:216`).

`health` is derived and distinct from `state`. `state` is the lifecycle value
the daemon already owns (`queued|claimed|active|blocked|review|done|cancelled`)
— do not invent a peer for it. `health` is the evidence layer:
`ok | stalled | dirty | conflict | rebasing | missing | orphan-disk`.

Serve `unprotected` — uncommitted lines plus commits that exist only on this
local branch. `src/board.ts:56` already computes `ahead` against `baseBranch`
*locally*; extend it so "committed but nowhere else on earth" is
distinguishable from safe. Sorting a list by this descending answers the
reporter's fear directly: the row at the top is what you lose if the disk dies.

Serve `holderRunning` — whether a process is actually alive in the worktree,
from `detectAgents` ∪ the headless registry (`src/board.ts:43,62`). "Agent
claimed this, no process is running" is the single highest-value fact this
feature can state and nothing surfaces it today.

Respect the existing cost discipline: `newestMtimeIn` is capped at 2000 entries
/ depth 6 (`src/liveness.ts:33-37`) and `collectStatus` already runs per poll
tick. Do not add a per-request git subprocess fan-out — reuse the poller's
cached rows where they exist and say in a comment which numbers are cached.

### wt-stopped-column
**scope:** `web/src/lib/derive.ts`, `web/src/components/SessionCard.tsx`, `test/derive-stopped.test.ts`
**expects:** a row with `agent === null` and uncommitted or unpushed work derives to a distinct "Stopped · work at risk" column and never to `idle`; a row with `status:'missing'` derives to that column too and never to `active` or `idle`; regression tests fail without the fix; `repoState` of `merging`/`rebasing`/`cherry-picking`/`reverting` renders a distinct badge rather than plain "dirty"

**The reported bug. Ship this first and alone if nothing else in this plan
happens.**

Reorder `deriveColumn` so unprotected work outranks agent-absence, and add the
sixth column. Today `agent === null` short-circuits to `idle` — hint text *"No
agent attached"* — so a crashed agent's dirty worktree is filed beside tasks
nobody has started.

`repoState` (`src/git.ts:314`) is already typed in the web contract at
`web/src/types.ts:43` and read by **no component** — a worktree wedged
mid-rebase draws as ordinary "dirty". Surface it here; Phase 3 reuses whatever
this lands.

Reuse `STATUS_META` / `StatusPill` (`web/src/components/primitives.tsx:49-69`)
and the existing `--dirty` / `--conflict` tokens. The new column needs a label
that names the risk, not the absence: "Stopped" describes the agent, "work at
risk" describes what the human must act on.

### wt-wip-snapshot
**scope:** `src/wip-snapshot.ts`, `src/poller.ts`, `test/wip-snapshot.test.ts`
**expects:** a worktree entering `stalled` or `abandoned` with uncommitted changes has them written to `refs/baton/wip/<slug>` as a dangling commit; the ref survives deletion of the worktree directory and is recoverable with `git show`; gitignored paths are never snapshotted and a size cap is enforced; nothing is written for a clean worktree; snapshotting twice with no change writes one ref, not two

**This is the task that makes "that work will be lost" false.**

Everything else in this plan makes lost work *visible*. This one stops it being
lost. When a worktree goes quiet with uncommitted changes, write them to a
dangling commit under `refs/baton/wip/<slug>` — invisible to `git branch`,
unaffected by `git worktree remove`, recoverable long after the directory is
gone. The precedent is Jujutsu's auto-snapshot: the recoverable state must not
depend on the agent remembering to save.

It also defuses the failure where the OS purges the worktree — a real, reported
loss where the temp directory was swept and the 70-byte `.git` symlink went
with it, taking access to the code.

Mind the cautionary half of the same precedent: **apply a size guard and skip
gitignored paths**, or the first thing you snapshot is somebody's `.env`. Git
calls go through `src/util/exec.ts`.

No UI. Report the ref in `wt-health-api`'s payload so `wt-recover` can offer it.

### wt-mcp-awareness
**scope:** `src/mcp.ts`, `src/mcp-help.ts`, `test/mcp-worktrees.test.ts`
**expects:** an MCP tool lists every worktree with slug, branch, holder, state, health and quiet time; the tool description plus schema stays inside the budget asserted by `test/mcp-help.test.ts`; calling it from a worktree marks that worktree as the caller's own in the result

*This is the "so all agents aware of different worktrees" half of the request,
and it is the part no UI can deliver* — agents do not read the dashboard.

Baton already tells an agent who is editing which **files** (`check_files`,
`list_signals`). It never tells them which **worktrees** exist, who holds them,
or which ones have gone quiet. Add that, reading `wt-health-api`'s model so
there is exactly one definition of health in the codebase.

Budget matters: `test/mcp-help.test.ts` caps the tool descriptions, and the
schemas are the larger half (see `baton/plans/context-cost.md`). Keep the
schema minimal — this tool takes at most a filter.

---

## Phase 2 — Make it actionable

### wt-write-verbs
**after:** wt-health-api
**scope:** `src/server.ts`, `src/endpoints/worktrees.ts`, `test/worktree-verbs.test.ts`
**expects:** `POST /api/worktrees/:slug/takeover` transfers ownership through `lifecycle.ts` `takeover` and returns 409 with the refusal reason when the task is not stalled; `POST /api/worktrees/:slug/pause` records `stoppedReason`; both are `--write` gated and refused with the existing read-only error otherwise; the anti-CSRF Origin gate applies with no per-endpoint check

**The missing endpoint.** `src/server.ts:28` imports only
`cancelTasks, claim, releaseClaim` from the lifecycle module. `POST
/api/pipeline/claim` refuses an already-`active` task. MCP is stdio-only
(`src/mcp.ts:675`), so a browser cannot reach `take_task {resume:true}` either.

Consequence today: **there is no API path to adopt stalled work.** Clicking
"hand this to another agent" in a dashboard is impossible without this task.

Do not weaken `takeover`'s stall guard to make the button feel better. Its
refusal at `lifecycle.ts:165-168` — *"Two agents in one worktree is the failure
this prevents"* — is the point. Surface the refusal text; let the human read it.

Route through the existing central Origin gate; do not add a per-endpoint
check (see the CSRF decision record).

### wt-lifecycle-events
**after:** wt-health-api
**scope:** `src/events.ts`, `src/lifecycle.ts`, `src/mcp-pipeline.ts`, `src/commands/pause.ts`, `src/commands/claim.ts`, `web/src/hooks/useEvents.ts`, `test/worktree-events.test.ts`
**expects:** a pause, block, claim, activate or takeover publishes an event on the bus regardless of whether it originated from HTTP, CLI or MCP; the client whitelist accepts the new types and `task.cancelled`; a dashboard open during a CLI `baton pause` updates without waiting for its poll

Today no event is published by `claim`, `activate`, `pause`, `block` or
`takeover` — grep `bus.publish` across `src/mcp-pipeline.ts`,
`src/commands/pause.ts`, `src/commands/claim.ts`: zero hits. A CLI `baton pause`
runs in a different process, and the daemon's only reaction to `tasks.json`
changing is re-syncing fs watchers (`src/watch.ts:105-107`).

Also fix the client side: `web/src/hooks/useEvents.ts:28-43` whitelists 22
types and **drops `task.cancelled`** — an event the dashboard itself causes.
Cancel from the Pipeline screen today updates on the 5-second poll, not on the
event it just generated.

Cross-process is the hard half. Prefer having the CLI write through a path the
daemon already observes over inventing a second IPC channel; if that is not
possible, say so in the task's report rather than adding one quietly.

### wt-stall-brief
**after:** wt-lifecycle-events
**scope:** `src/handoff/auto-brief.ts`, `src/handoff/brief.ts`, `test/stall-brief.test.ts`
**expects:** a worktree entering `stalled` gets a handoff brief composed automatically — last commit, uncommitted diffstat, the `report_progress` line, the block reason, claimed files — and it appears in `GET /api/handoffs` without a human asking; re-entering `stalled` does not duplicate an unresolved brief; a brief is never composed for `quiet`

Baton already has briefs, contributor chains, `save_progress` and takeover. The
only missing step is composing the brief at the moment it becomes needed rather
than when someone thinks to ask.

This turns "hand a half-finished worktree to another agent" from a workflow
started cold into one click on an artifact that already exists. It reuses
`buildBrief` (`src/handoff/brief.ts:193`) wholesale — do not write a second
brief format.

Compose on `stalled`, never on `quiet`. A brief for work that is merely between
commits is noise, and noise is how a signal gets ignored.

### wt-progress-route
**after:** wt-write-verbs
**scope:** `src/server.ts`, `src/handoff/progress-ledger.ts`, `test/progress-route.test.ts`
**expects:** the progress ledger for a slug is readable over HTTP — plan, next action, files edited, and the `flagged` overclaim marker; a worktree with no ledger returns an honest empty result rather than a 404

`ProgressLedger` (`src/handoff/progress-ledger.ts:43-56`) is written by MCP
`save_progress` and read only by `buildBrief`. It is the richest statement of
what a worktree is actually doing that exists in the system, and no route
serves it. It is what turns "quiet for 34m" into "quiet for 34m, and the last
thing it said it was doing was X."

Carry the `flagged` marker through. An agent claiming progress it cannot
evidence is precisely what a human reviewing stuck work needs to see.

---

## Phase 3 — The flow canvas

*Gated on the dependency decision in the context section. If `@xyflow/react` is
rejected at review, this phase is replaced by a ranked list view over
`wt-health-api` and the plan still delivers.*

### wt-flow-canvas
**after:** wt-health-api, wt-lifecycle-events
**scope:** `web/package.json`, `web/src/features/Worktrees.tsx`, `web/src/components/flow/**`, `web/src/App.tsx`
**expects:** `@xyflow/react` builds in `npm run build --prefix web`; a Worktrees screen renders one node per worktree from `GET /api/worktrees`; pan, zoom, fit, minimap and multi-select work; the viewport does not move when data refreshes; `Canvas.tsx` is deleted in the same change, not left beside it

Replace `web/src/features/Canvas.tsx` — do not run both. Two canvases with
different node vocabularies is the drift this repo has already paid for once in
the skills layer.

Layout comes from the plan DAG: `planId` → `phase` → task, with `dependsOn`
edges. Use a deterministic layered layout, left to right, so the same data
always produces the same picture — a force simulation that re-settles on every
poll is the single fastest way to make this screen unusable.

**Never re-seed the graph on a poll.** Keep a `Map<slug, node>` and merge
fields into existing node objects so positions survive; only allocate for
genuinely new slugs. `zoomToFit` exactly once, on first load.

Theme note: `web/src/components/GraphCanvas.tsx:60-65` reads CSS tokens once in
a `[]` effect, so that graph keeps the old palette across a theme switch. Do
not reproduce that bug here — read tokens per paint or key the effect on the
theme attribute.

### wt-flow-nodes
**after:** wt-flow-canvas
**scope:** `web/src/components/flow/**`, `web/src/styles/**`
**expects:** node appearance distinguishes every `state` and every `health` value using at least three non-colour channels; `prefers-reduced-motion` suppresses all node animation, checked in JS rather than relying on CSS; a stalled node is identifiable in a greyscale screenshot

Reuse the existing vocabulary. `TaskState` is already
`queued|claimed|active|paused|review|blocked|done|cancelled` and `STATE_COLOR`
(`web/src/features/Pipeline.tsx:47-56`) already maps it to tokens. Health is a
*modifier* on top, never a peer state.

Quiet time renders as a **decay ring** that shortens from full to empty across
`STALL_GRACE_MS`. An `active` node with an empty ring reads as "claimed two
hours ago, nothing has happened in forty-five minutes" — stalled expressed as
evidence rather than as a verdict the daemon never issued.

Use the semantic tokens at `web/src/styles/tokens.css:124-147`
(`--clean --dirty --conflict --ready --idle`), not new hues. 11px is the
documented legibility floor.

While here: `web/src/features/Pipeline.tsx:73` animates a keyframe named
`pulse`, and `web/src/styles/base.css:77` defines `pulse-dot`. There is no
`pulse`. That animation has never run.

### wt-flow-groups
**after:** wt-flow-nodes
**scope:** `web/src/components/flow/**`, `web/src/features/Worktrees.tsx`
**expects:** worktrees group by plan and phase using React Flow `parentId` + `extent:'parent'`; a group collapses to a single node carrying a rolled-up count and the worst health of its children; edges crossing a collapsed boundary reroute to the group node rather than disappearing; collapse state survives a reload

*"easily they can collapse those worktree"* — this task.

React Flow has parent/child nodes but **no built-in collapse**. It is
implemented by setting `hidden` on descendants and rerouting edges to the group
node. Budget for it; it is the fiddliest task in this plan.

The rolled-up health must be the WORST child's, not an average. A group
containing one stalled worktree reads as stalled when collapsed, or collapsing
becomes a way to hide problems.

### wt-node-actions
**after:** wt-flow-groups, wt-write-verbs, wt-progress-route
**scope:** `web/src/features/Worktrees.tsx`, `web/src/lib/api.ts`, `web/src/lib/demoWorktrees.ts`
**expects:** selecting a node opens a detail panel ordered diagnosis-first; Copy prompt copies the daemon-built `resumePrompt` verbatim and never assembles prompt text in the browser; Take over, Pause, Hand off, Open Live and Diff all work and are `writeEnabled`-gated with the standard read-only tooltip; every action works against demo fixtures

Panel order is diagnosis before identity — this panel is read by someone who
has just found stuck work:

1. Verdict — state pill + quiet time, largest type in the panel
2. Why — `blocker` rendered verbatim; the dashboard must not invent a second
   vocabulary for a refusal the CLI answers to
3. Who — agent badge, and **whether a process is actually running**
4. Work in flight — ahead/behind, files changed, conflicts
5. What it said it was doing — the progress ledger from `wt-progress-route`
6. Identity — title, branch, worktree path as copy fields
7. Actions

Copy prompt: if an open brief exists, copy `brief.resumePrompt` from
`GET /api/handoffs` verbatim. If none exists and the daemon is read-only, copy
the pickup command — not a fabricated brief.

Reuse `Sheet` below 900px (it already becomes a bottom sheet and is
focus-trapped) and an inline aside above it. One selection state, two
presentations.

### wt-recover
**after:** wt-node-actions, wt-wip-snapshot
**scope:** `web/src/features/Recover.tsx`, `web/src/lib/api.ts`, `web/src/lib/demoRecover.ts`
**expects:** orphaned worktrees, `baton/*` branches with no task, and `refs/baton/wip/*` snapshots are listed and sorted by unmerged commits descending; the primary action recovers work into a new task and delete is secondary; the screen works in demo mode

Surface the audit that already exists at `GET /api/doctor` — **but invert its
framing.** `src/cleanup.ts` is written as *junk to delete*; the reporter's need
is *work to rescue*. Same data, opposite verb, and the verb decides which
button is primary.

Sort by unmerged commits descending so the most valuable strandings are at the
top. Include the `wt-wip-snapshot` refs: a worktree whose directory is gone may
still have its last uncommitted state recoverable, and this is the only screen
that would ever say so.

### wt-merge-from-node
**after:** wt-recover
**scope:** `web/src/features/Worktrees.tsx`, `web/src/lib/api.ts`, `test/worktree-merge-ui.test.ts`
**expects:** a node offers Merge only when the worktree is clean, conflict-free and its task is `done` or approved; the confirmation names the exact target branch and commit count; a failed merge rolls back and says so; merging a task whose phase is not integrated is refused with the reason

*"and merge right"* — this task.

`baton merge` merges into `currentBranch(gitRepo)` (`src/commands/merge.ts:104`)
with no reference to the task's own base. From a canvas where several
worktrees are visible at once that is dangerous: the button must state the
target branch it will merge into, read from the daemon rather than assumed.

Reuse the optimistic-write-plus-rollback pattern already at
`web/src/features/Board.tsx:111-125`, and the `ConfirmDialog` convention of
naming the consequence in mono.

Refuse rather than warn when the phase barrier says no. `integrationHold`
(`src/pipeline.ts:142`) exists to stop exactly this.

---

## Phase 4 — Write it down

### wt-notify
**after:** wt-lifecycle-events
**scope:** `electron/notify.ts`, `electron/main.ts`, `test/electron-notify.test.ts`
**expects:** entering `stalled` or `abandoned`, or a task needing input, raises a desktop notification and a dock badge; `quiet` never notifies; a hotkey jumps to the next worktree needing attention; notifications can be turned off and the setting persists

`grep -rn "Notification" electron/` finds nothing outside `node_modules`. Baton
ships a desktop app that never tells you anything — and across the surveyed
category this is the single most-requested missing feature, with five separate
open requests on one competitor alone.

The discipline is the hard part, not the API: **every notification must be
actionable.** Fire only from `stalled`, `abandoned` and needs-input. Never from
`quiet` — that state exists precisely so the UI can show concern without
raising an alarm. A notification stream people learn to dismiss is worse than
silence, because it also teaches them to dismiss the real one.

### wt-docs
**after:** wt-node-actions, wt-mcp-awareness
**scope:** `docs/dashboard.md`, `docs/mcp-tools.md`, `CODEBASE.md`, `STATUS.md`
**expects:** the Worktrees screen, the health vocabulary and the new MCP tool are documented; the `state` vs `health` distinction is stated once, in one place, and linked from both; STATUS.md reflects what shipped

Document the distinction explicitly: `state` is what the daemon was told,
`health` is what the disk says. Anyone who later adds a third state field will
read this first.
