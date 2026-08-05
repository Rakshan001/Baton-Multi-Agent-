# Task pipeline — design

**Date:** 2026-08-05
**Status:** design, pending review
**Supersedes:** nothing. Extends the existing `Task` record in `src/store.ts`.

## Problem

Baton coordinates agents that are *already working*. It has no notion of work that
has not started yet. Concretely, `Task` (`src/store.ts:9`) has no assignee, no
ordering, and no lifecycle — `status` in `src/board.ts:15` is git dirtiness
(`clean | dirty | conflict`), not a state. So:

- No agent can be asked "is there work for you?" — `list_tasks` returns everything
  to everyone.
- Nothing expresses "task B may not start until task A lands", so 5–7 parallel
  agents interleave phases and build on foundations that are still moving.
- There is nowhere to record "stopped at step 4 of 7, session limit hit", so an
  interrupted task is indistinguishable from a finished one.
- An agent can declare completion with nothing behind it.

The goal is that any agent, in any editor, can be asked *"do you have work?"* and
get a correct, ordered, contract-bearing answer — and that when it stops early,
that fact survives.

## Non-goals

- Not a CI system. Baton never executes project commands (see §6).
- Not a merge queue. Integration is one step per phase, not per commit.
- Not a replacement for `baton pass` / handoff briefs; those remain for
  free-form context transfer between sessions.

---

## 1. Architecture — split by lifetime

Four stores, chosen so no single loss is fatal.

```
baton/                    TRACKED    durable, shared, survives clone
  plans/<date>-<name>.md    the plan (markdown + frontmatter)
  memory/facts/*.md         shared knowledge base
.baton/                   GITIGNORED volatile, local, rebuildable
  tasks.json                task state          worktrees/  checkouts
  tasks.lock                claim lock          history.db  rebuildable index
HUB (baton serve)         EPHEMERAL  live, atomic, single-writer
  claims · presence · progress · liveness
git branches + trailers   DURABLE    code + lineage
```

Consequences, stated as invariants:

- **Hub loss degrades liveness, never knowledge.** Plans, KB, code, lineage are
  all in git.
- **`.baton/` loss costs nothing permanent.** `baton history reindex` rebuilds
  the index by walking `Baton-Task:` trailers in git log.
- **`baton/` is the only new tracked directory.** `.baton/` stays gitignored.

### 1.1 Solo vs team

|                | solo                       | team                                    |
| -------------- | -------------------------- | --------------------------------------- |
| task branches  | local, never pushed        | auto-pushed — pushing *is* the transport |
| `done` means   | commits exist              | commits exist **and are pushed**         |
| claim arbiter  | `.baton/tasks.lock`        | hub (single writer)                      |
| KB             | `baton/` tracked           | same, plus pull                          |
| remote history | untouched, stays clean     | carries `baton/*` task branches          |

Auto-push covers **task branches only** — never `main`, never `--force`, and
never when the diff touches CI configuration (§7.4). Integration into the base
branch requires operator **and** explicit confirmation: it is the one write that
touches shared history.

---

## 2. Data model

Every new field is optional, so existing `tasks.json` files load unchanged.

```ts
interface Task {
  // --- existing ---
  slug: string
  task: string
  scope?: string[]
  projectId?: string
  repoRoot?: string
  createdAt: string

  // --- now optional: null until claimed (lazy worktree) ---
  branch?: string
  worktreePath?: string
  baseBranch?: string
  baseCommit?: string | null

  // --- graph ---
  planId?: string
  phase?: number            // 1-based; absent = phase 0 (legacy)
  dependsOn?: string[]      // slugs within the same plan
  assignee?: string | null  // agent id from AGENTS registry; null = open pool

  // --- contract, from the plan file ---
  skills?: string[]
  principles?: string[]
  expects?: string[]

  // --- lifecycle ---
  state?: TaskState
  claimedBy?: { agent: string; sessionSlug: string; at: string }
  contributors?: Array<{ agent: string; from: string; to?: string }>
  stoppedReason?: string
  cancelledBy?: { actor: string; at: string; reason?: string }
  pushedSha?: string        // team mode: proof the work is fetchable
  reviewedBy?: { actor: string; at: string; verdict: 'approve' | 'reject' }
}

type TaskState =
  | 'queued' | 'claimed' | 'active'
  | 'blocked'            // agent reported it cannot proceed; still owned
  | 'review'             // evidence passed, awaiting verdict
  | 'done' | 'cancelled'
```

### 2.1 Computed, never stored

`stalled`, `locked`, `eligible`, `takeable` are **derived at read time** and never
written. This is the same lazy pattern `reconcileSignals` already uses in
`src/signals.ts`, and it is what makes the pipeline work with no daemon running.
A crashed process can therefore never leave a board that lies.

`cancelled` replaces the earlier `abandoned`: one terminal non-success state with
a recorded reason is enough, and fewer states is fewer transitions to get wrong.

---

## 3. Eligibility — one pure function

The entire pipeline reduces to this. No filesystem, no network, fully unit-testable
including the team-mode rule.

```ts
openPhase(ts)        = lowest phase with any task not in (done | cancelled)

eligibleFor(a, ts)   = ts.filter(t =>
       t.state === 'queued'
    && (t.assignee === a || t.assignee == null)
    && t.phase <= openPhase(ts)
    && t.dependsOn.every(d => bySlug(d).state === 'done'
         && (mode === 'solo' || isFetchable(bySlug(d).pushedSha))))

takeableBy(a, ts, now) = ts.filter(t =>
       t.state === 'active'
    && now - liveness(t) > STALL_GRACE_MS)
```

Three consequences:

- A phase completes when every task is `done` **or `cancelled`** — otherwise one
  dropped task wedges the pipeline permanently.
- A task whose dependency was cancelled is never eligible; it surfaces as
  `blocked: dependency auth-schema cancelled` and requires a human decision. It
  never silently disappears.
- `assignee: null` is the open pool. Leaving the tail tasks of a phase unassigned
  is how an idle Cursor helps finish a phase full of Claude-assigned work.

### 3.1 Liveness is not the MCP heartbeat alone

**This corrects a flaw in the first draft.** Heartbeat is refreshed on MCP tool
calls (`PRESENCE_TOUCH_MS = 30_000`, `src/mcp.ts:42`). An agent running a
20-minute build makes no tool calls, so a purely heartbeat-based rule would
declare a perfectly healthy agent stalled and offer its work to someone else —
the exact double-write we are trying to prevent.

```ts
liveness(t) = max(
  heartbeatOf(t.claimedBy),          // MCP tool activity
  newestMtimeIn(t.worktreePath),     // statSync, already used in src/watch.ts
)
```

File mtime proves an agent is alive even while it is silent. `STALL_GRACE_MS`
defaults to **45 minutes** against that combined signal, and the UI distinguishes
*silent 12m* (informational) from *STALLED* (takeable). Takeover of a task whose
worktree changed within the last 5 minutes requires confirmation regardless.

### 3.2 Why nothing is eligible

An agent that asks for work and is told "none" learns nothing. Every empty result
carries its cause, and a pipeline that cannot advance says so:

```
$ baton next
  nothing eligible for claude.
  phase 2 holds the barrier: 1 of 3 remaining
    auth-api   BLOCKED on you — "needs staging DB credentials"
  phase 3 locked behind it (6 tasks)
  PIPELINE STALLED: no agent can proceed until auth-api is resolved.
```

Deadlock is a first-class output, not silence.

---

## 4. The plan file

Markdown with frontmatter — readable in the UI as-is, diffable in git, and
editable by telling an agent to fix it. This matches the format `readBrief`
already parses for handoff briefs, so it is consistent rather than novel.

```markdown
---
plan: 2026-08-05-auth
goal: Ship JWT auth end to end
requireReview: true
---

## Phase 1 — Foundation

### auth-schema  @claude
**scope:** `src/db/**`
**expects:** migration runs up and down; `vitest test/schema` passes
**principles:** no raw SQL outside `src/db`

Add users + refresh_tokens tables.
```

Markdown parsing is more fragile than YAML, so `plan apply` validates strictly and
fails loudly rather than guessing.

### 4.1 Rejected at apply, before anything exists

- dependency cycles (topological sort)
- a dependency in a later phase
- unknown dependency slugs
- duplicate slugs
- **overlapping `scope` between two tasks in the same phase** — see §5

### 4.2 Editing a plan that is already running

Re-apply is idempotent by slug. A dry run is mandatory before any in-flight task
is touched:

```
$ baton plan apply baton/plans/auth.md --dry-run
  + rate-limit      new, phase 2
  ~ auth-api        expects changed          ACTIVE (antigravity)
  - login-ui        removed                  queued, safe
  ~ auth-schema     scope changed            DONE — will not rewind

  1 in-flight task affected. --force to proceed.
```

Rules: never silently mutate a task an agent is inside; never rewind a `done`
task; removed tasks are flagged, not deleted. A renamed slug reads as
remove + add and loses lineage — the dry run makes that visible, which is
sufficient; slugs are the identity.

---

## 5. Two agents, one file — the within-phase hole

The phase barrier gates *between* phases. It does nothing *within* a phase, and
within a phase is exactly where N agents run concurrently by design. Two phase-2
tasks both touching `src/db.ts` will collide, and the barrier will not catch it.
`scope` is currently documented as *"Advisory, not enforced"* (`src/store.ts:22`),
which is fine for one human and insufficient for seven parallel agents.

Three layers, each building on machinery that already exists:

| when       | mechanism                                                             | status                                                    |
| ---------- | --------------------------------------------------------------------- | --------------------------------------------------------- |
| plan time  | overlapping scope within one phase is a **hard error**                 | `canCollide` / `taskRepos` exist in `src/conflicts.ts`; elevate warn → reject |
| edit time  | `baton guard` PreToolUse hook warns on out-of-scope edits              | hook exists (`src/commands/guard.ts`); needs task-scope awareness |
| barrier    | integration conflict holds the barrier and keeps the next phase locked | new                                                       |

A second agent opened manually inside an existing worktree is detected by
comparing `BATON_SLUG` and the worktree path against `claimedBy`, and warned.

---

## 6. The done gate

Baton never executes project commands. A plan file is inert data — which is what
makes it safe to `plan apply` a plan that arrived over git.

```
$ baton done auth-api
  ok  3 commits since 8f2a1c
  ok  diff touches src/auth/** (declared scope)
  !   diff ALSO touches src/db/** (not declared) — recorded
  ok  working tree clean
  ok  no conflict markers
  ?   expects: "vitest test/auth passes" — paste output or --attest
  [team] ok pushed to origin @ 9c4e1a
  -> state: review        (requireReview: true)
```

Zero commits is a hard refusal. Out-of-scope changes are allowed but recorded and
flagged. Test results are an agent *attestation*, not a verification.

### 6.1 Review — and its honest limits

**Decision: `requireReview` defaults to on, opt out per plan.**

The evidence gate proves work *happened*. It is fully satisfiable by three
commits of confident, wrong code. Review is the only layer in this design that
targets correctness rather than existence, so it is on unless a plan opts out.

- The reviewer must not be a contributor to the task. Enforced.
- `--reject` returns the task to `active` with notes attached; it does not lose
  the branch.
- A task in `review` does not count toward phase completion.
- Builds on `src/reviews.ts`.

Stated plainly: a reviewing agent is itself capable of hallucinating. Review
reduces wrong-code risk; it does not eliminate it. This design does not claim
otherwise.

### 6.2 Hallucination surface

| failure                        | caught by                                                     | verdict            |
| ------------------------------ | ------------------------------------------------------------- | ------------------ |
| "done" with no work            | zero-commit refusal                                           | solid              |
| done, code is wrong            | review gate (§6.1)                                            | reduced, not solved |
| fabricated checkpoint          | each checkpoint stamped with the diff-stat at that moment; a checkpoint claiming progress with zero changed files is flagged | solid              |
| acting on stale peer state     | state served with freshness — "done 12m ago at sha X", not just "done" | solid              |
| marks the wrong task done      | slug verified against caller's claim                          | solid              |
| works in the wrong worktree    | `BATON_SLUG` ↔ worktree path assertion                        | solid              |
| builds the wrong thing         | `expects` is the contract, returned at claim                  | partial            |

---

## 7. Security

### 7.1 Secrets in a tracked KB — a regression this design introduces

Moving memory facts from gitignored `.baton/memory/facts` (`src/memory.ts:296`)
into tracked `baton/memory/facts` means a fact containing an API key is committed
and pushed. Today the same fact stays on one disk.

**Secret scanning in `save_memory` is a hard prerequisite of the tracked-KB
phase, not a follow-up.** Key-shaped content is refused by default; `--local-only`
stores it in the untracked area instead, so a false positive costs a flag rather
than the fact. A leak discovered after a push is unrecoverable — it is a key
rotation, not a file deletion.

### 7.2 Tracked plans are a prompt-injection vector

Plans are inert as *data* and live as *prompt*: `task`, `principles`, and `skills`
flow into agent context. A plan obtained by cloning a repo is untrusted input.
Mitigation: plans not authored in this repo require explicit trust before apply,
and plan text is injected labelled as data, never as instruction.

### 7.3 Slug traversal

Slugs previously came from a human typing `baton new`; they now arrive in files
that may have travelled over git. `slug: ../../.ssh` becomes a worktree path and a
branch name. `src/util/slug.ts` must be applied on the plan-ingest path, with a
test proving traversal is rejected.

### 7.4 Auto-push and CI

A task scoped to `.github/workflows/`, an agent that edits it, and auto-push
together form remote code execution on the CI runner. Auto-push refuses when the
diff touches CI configuration, and re-checks task state at push time so a
cancelled task cannot push.

### 7.5 Trailer poisoning

`history reindex` must not trust `Baton-Task:` trailers from arbitrary commits —
anyone who can push can forge lineage. Only index trailers on branches Baton
created, cross-checked against `tasks.json`.

### 7.6 Authorization

Reuses `src/access.ts` unchanged; one `isOperator()` check per route.

| operator only        | any authenticated member  |
| -------------------- | ------------------------- |
| `plan apply`         | list my tasks             |
| assign / reassign    | `take` (if eligible)      |
| `phase open --force` | `save_progress`           |
| `task rm`            | `done` (own task)         |
| cancel               | `take --resume` (stalled) |
| integrate            | report blocked            |

**Claims fail closed.** Reads degrade open — an unreachable hub yields "unknown,
proceed with caution" via the existing `reachable` flag in `src/remote-claims.ts`.
Claiming does not: in team mode a claim requires the hub, because two machines
both claiming one task is the failure this whole design exists to prevent.

---

## 8. Cancellation

Baton cannot stop an agent mid-thought. Cancellation is **cooperative**: it sets
state the agent observes on its next MCP call. Between the click and that call the
agent keeps writing. That window is real and cannot be engineered away.

What keeps it short: `src/mcp.ts:92` already wraps every tool registration in a
`reg()` helper for presence. The same wrapper checks "is my task still mine, still
live?" on every call, so the notice lands on the agent's very next tool use.

```
scope:   task | phase | plan
effect:  state -> cancelled; work is NEVER deleted
         branch preserved, checkpoint preserved, worktree preserved
agent's next tool call:
   "auth-api was cancelled by rakshan 4m ago. Stop. Do not commit further."
done on a cancelled task -> refused
push  on a cancelled task -> refused
```

Never deleting the branch matters: cancellation is a reversal of a decision, not a
destructive act.

**Hard stop is deliberately out of scope for now.** `killSessionFor`
(`src/util/tmux.ts:78`) passes a bare session name to `tmux -t`, which resolves by
prefix — so cancelling `fix` would kill `fix-login`'s agent. Until that is fixed
(§10, phase 0) Baton must not offer a hard stop.

---

## 9. Integration at the barrier

When the last task in phase N reaches `done`, the barrier lifts and all phase-N
branches integrate into the base in one step. Phase N+1 worktrees branch from the
integrated base, so every agent in a phase starts from identical, complete
foundations.

```
phase 1 done (4/4) -> integrate
    baton/auth-schema  ok
    baton/db-seed      ok
    baton/config       CONFLICT src/db.ts
  -> barrier HOLDS, phase 2 stays locked, resolve and retry
  -> on success: base @ 7fa2c1, phase 2 branches from there
```

One integration commit per phase, not one per task. A phase whose tasks were all
cancelled integrates nothing and opens the next phase without error.

---

## 10. Delivery phases

**Phase 0 — prerequisites.** Each blocks something downstream; none are optional.

| fix                                                              | blocks              |
| ---------------------------------------------------------------- | ------------------- |
| `withTasksLock` unbounded spin (`src/store.ts:218`) + strict CAS variant | all claiming        |
| tmux bare `-t` prefix match (`src/util/tmux.ts`, `src/terminals.ts`) | cancellation, terminals |
| `localClaimsPayload` publishes `projectId: null` (`src/server.ts:116`) | hub correctness     |
| `commit_files` missing repo column (`src/history.ts`)             | lineage in hub mode |
| secret scanning in `save_memory`                                  | tracked KB (§7.1)   |
| slug hardening on plan ingest (`src/util/slug.ts`)                | `plan apply` (§7.3) |

**Phase 1 — model + eligibility.** Pure functions, full unit tests, zero I/O.
**Phase 2 — plan intake.** `baton/` dir, markdown parser + strict validation, `plan apply` with dry run, `task add`, `baton ls` phase view.
**Phase 3 — lifecycle.** `take` (lazy worktree, CAS), `done` (evidence gate), liveness + stall computation, `--resume` takeover with contributor chain.
**Phase 3.5 — review gate.** `baton review --approve/--reject`, reviewer ≠ contributor.
**Phase 4 — MCP surface.** `my_tasks`, `take_task`, `complete_task`, `report_blocked`; cancellation notice in the `reg()` wrapper; checkpoint diff-stamping. *This is where "any tasks for me?" starts working in every agent.*
**Phase 5 — integration + history.** Barrier integration, `Baton-Task:` trailers, `history reindex`, lineage in `who_touched`.
**Phase 6 — team mode.** Memory migration to `baton/`, push/fetch gating, `isFetchable` with caching, operator/member split, claims fail-closed.
**Phase 7 — UI.** Phase swimlanes, markdown plan view, cancel controls with blast radius ("cancelling phase 2 stops 3 active agents"), demo fixtures kept working.

Each phase ships standalone. Phases 1–3 are load-bearing and invisible; phase 4 is
where it becomes useful day to day.

---

## 11. Testing

- Eligibility, `openPhase`, plan validation, and state transitions are pure →
  unit tests, no filesystem.
- Claim races get a real concurrent test: N processes, one task, assert exactly
  one winner.
- Liveness gets a test proving a silent-but-editing agent is **not** takeable.
- Traversal: `slug: ../../x` is rejected at ingest.
- Secret scanning: a key-shaped fact is refused from the tracked path.
- Every fix verified by mutation — revert it, confirm exactly the intended tests
  fail, restore.

---

## 12. Migration

- Existing tasks lack `phase`/`state`: treated as phase 0; state inferred from
  worktree presence (`active` if it exists, else `queued`).
- Existing memory facts move `.baton/memory/facts` → `baton/memory/facts` once,
  behind the §7.1 secret scan, with `.gitignore` updated in the managed block.
- `.baton/history.db` is rebuildable; no migration needed.

## 13. Open questions

1. Phase renumbering when a phase is inserted mid-plan — currently derived from
   document order, so insertion shifts every later phase. Visible in the dry run,
   but a stable phase id may be worth it.
2. `isFetchable` cost in team mode — needs a fetch-once-then-check-locally
   strategy with caching, not a network call per task per query.
3. Whether review should itself be a task in the graph (elegant, composable) or a
   state transition (simpler). Currently a state transition.
