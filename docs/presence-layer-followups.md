# Presence layer (ADD-07) — follow-up backlog

> **Working doc — do not push.** This is a scratch tracker for the code-review
> findings and remaining work on the ADD-07 presence layer. It exists so the
> next session (or the next agent) can pick these up without re-deriving them.
> Once the items are triaged/fixed, fold anything durable into
> [session-continuity-improvements.md](./session-continuity-improvements.md) and
> delete this file.

## Status — 2026-07-15

All six code-review findings addressed (still **uncommitted**). Suite: **582
passing**, +7 new tests. The one remaining failure (`stack-migration.explain.how
too long`) is unrelated `src/skills/catalog.ts` WIP, not ours.

| # | Sev | Resolution |
|---|-----|------------|
| 1 | HIGH | **Fixed** — `getSignals` collapses a `co-*` fs-watch echo on any path a session at that same (canonical) checkout already holds. `src/signals.ts`. Tests: 2. |
| 3 | MED | **Fixed** — `agentAtRoot` canonicalizes path keys (`canonicalRoot`, realpath) and attributes to the most-recently-seen session. `src/signals.ts`. Tests: 2. |
| 4 | MED | **Fixed** — `resync()` reconciles `watched_roots` against the DB (sole-writer table), pruning stale rows on startup. `src/watch.ts`. Tests: 1. |
| 2 | MED | **Documented** — inherent fs-watch limit (shared plain checkout can't attribute per-agent); explicit KNOWN-LIMIT comment in `src/watch.ts`, do not guess an agent. |
| 5 | LOW | **Fixed** — `touchHookSession` (UPDATE-only) + a one-shot registration interceptor in `src/mcp.ts` refresh presence on any tool call. Tests: 2. |
| 6 | LOW | **Fixed** — `hookSessions`/`watchedRoots` queried once in `getSignals` and threaded into `reconcileSignals`. `src/signals.ts`. |

Remaining: **ADD-07 slice C** (below) is still un-started.

### Round 2 — self-review of the fixes (2026-07-15)

A `/code-review` of the six fixes surfaced 6 follow-ups; all addressed (uncommitted, on top of `ddb997b`):

| Finding | Sev | Resolution |
|---------|-----|------------|
| transient probe wipes watched_roots | MED | `checkoutRoots` returns `null` when it can't positively determine the set; `resync` only reconciles the registry on an authoritative probe. `src/watch.ts`. Test: 1. |
| stale-session attribution | MED | `agentAtRoot` skips sessions older than `PRESENCE_WINDOW_MIN`. `src/signals.ts`. Test: 1. |
| uncached `realpathSync` on hot path | MED | per-call memo (`canonOf`) around `canonicalRoot`. `src/signals.ts`. |
| git spawn per resync | LOW-MED | `checkoutRoots` cached with a 4s TTL (`probeCheckouts`). `src/watch.ts`. |
| SDK `registerTool` monkeypatch | LOW-MED | replaced with a typed local `reg` helper (no object reassignment; call-site types preserved). `src/mcp.ts`. |
| DB write per tool call | LOW | `presenceTouch` debounced to `PRESENCE_TOUCH_MS` (30s). `src/mcp.ts`. |

---

## Where we are

Slices **B** (surface `hook_sessions` on the dashboard via `/api/sessions` +
`collectPresence` + the "Connected agents" panel) and **A** (agent-agnostic
fs-watch capture: watch every git checkout in the hub, `watched_roots` registry
driving read-time reconcile + agent attribution) are **implemented, tested, and
E2E-verified** but **uncommitted**.

A `/code-review` on the A+B diff surfaced **6 findings, all in slice A** (slice B
came back clean). They are listed below, most-severe first, each with a concrete
tackle plan. Slice **C** (one coherent hub DB + `doctor` reconcile) is still
un-started and listed at the end.

Nothing here is committed. The pre-existing `test/skills.test.ts` failure
(`stack-migration.explain.how too long`) is unrelated WIP on
`src/skills/catalog.ts` and is **not** ours to fix here.

---

## Code-review findings

### 1. 🔴 HIGH — `co-root` double-counts a hooked session's own edits

- **Where:** `src/watch.ts:110` (`checkoutRoots` → `co-root`), interacting with
  `src/guard.ts` (`recordHookEdit(root, { slug: self.slug, … })`) and
  `src/signals.ts:463` (overlap level) + `checkFiles` exclude logic
  (`src/signals.ts:479-489`).
- **Symptom:** In the single-repo case slice A targets, when Claude/Cursor edits
  a file in the plain repo root, the edit is recorded **twice** — once under the
  session's own slug (`sess-…`) by the guard/hook, and once under `co-root` by
  the fs-watcher. Two distinct holders on one path →
  `new Set(holders.map(h => h.slug)).size >= 2` fires a **false `warning`
  overlap**, and because `checkFiles(root, [rel], self.slug)` only excludes
  `self.slug` (not `co-root`), the guard tells the agent **its own file is busy**
  by another session. This actively degrades the common single-repo flow.
- **Root cause:** two capture paths (hook/guard at session granularity, fs-watch
  at checkout granularity) observe the *same* physical edit and neither knows
  about the other.
- **How to tackle (pick one; A preferred):**
  - **(A) Dedup at the source — suppress the redundant `co-*` signal.** When
    writing a `co-*` signal (or when assembling holders in `getSignals`), drop it
    for a `(path)` already held at that same checkout by a live `hook_sessions`
    row whose `root` resolves to the checkout path. The session-level signal is
    strictly more informative (it knows *who*), so the checkout-level one is pure
    duplication there. Cleanest spot: in `getSignals`, after building `byPath`,
    collapse a `co-<x>` holder into a same-path session holder when
    `watched.get('co-<x>') === session.root` (realpath-normalized — see #3).
  - **(B) Exclude co-slugs of the caller's own checkout in `checkFiles`.** Have
    the guard/`checkFiles` also exclude the `co-*` slug whose watched path equals
    the caller's session root, not just `excludeSlug`. Narrower fix; leaves the
    false `warning` in the read-only signals view, so weaker than (A).
- **Test to add:** single-repo, one hooked session edits `x.ts`; assert exactly
  one holder and `level === 'info'`, and that `checkFiles` reports `x.ts` not
  busy for that session.

### 2. 🟠 MED — two agents in one plain checkout collapse to a single `co-root` holder

- **Where:** `src/signals.ts:463`; root cause in the `edit_signals` PK
  `(slug, path)` + the single `co-root` slug per checkout.
- **Symptom:** Two different agents both editing the same file inside one plain
  (non-worktree) checkout are both recorded under `co-root`. PK `(slug, path)`
  collapses them to one row/one holder, so a **genuine 2-agent conflict fires no
  `warning`** — the exact case the overlap signal exists to catch.
- **Root cause:** checkout-level identity (`co-root`) is coarser than the
  conflict we want to detect (per-agent). fs-watch alone cannot attribute *who*
  touched the file.
- **How to tackle:** this is a known limitation of pure fs-watch capture — accept
  and **document** it (the reliable per-agent signal comes from the guard/hook
  path, which slice A does not replace). If we want real coverage: attribute
  `co-*` edits to a concrete session when exactly one live `hook_sessions` row is
  registered at that checkout (turn the `co-root` holder into that session's
  slug), and only fall back to `co-root` when 0 or ≥2 sessions are present. Ties
  into #1 and #3. Lowest-effort acceptable outcome: a `log`/doc note that
  multi-agent conflict detection in a *shared plain checkout* requires the hook.

### 3. 🟠 MED — `agentAtRoot` attribution is fragile (last-writer-wins + raw-path keys)

- **Where:** `src/signals.ts:442-450`.
- **Symptom:** `agentAtRoot` maps checkout `root` → agent by iterating
  `sessions.values()` in unordered SELECT order, so when two sessions share a
  root the **last one wins arbitrarily**. Worse, the key is a raw path string, so
  after realpath normalization mismatches (macOS `/var` vs `/private/var`,
  trailing slash, symlinked worktree) the lookup **misses** and the agent shows
  as `null`.
- **Root cause:** path used as an identity key without canonicalization; no
  disambiguation when multiple sessions map to one root.
- **How to tackle:**
  - Normalize both sides through a single `realpath`/`resolve` helper before
    using a path as a map key here **and** where `watched_roots.path` /
    `hook_sessions.root` are written, so keys are canonical end-to-end.
  - For the multi-session tie, prefer the most-recently-seen session (`ORDER BY
    at DESC`, keep first) rather than last-writer-wins — deterministic and
    matches "who is most likely active now."
- **Test to add:** register two sessions at the same realpath-variant root;
  assert the fresher agent is attributed and that a `/var` vs `/private/var`
  variant still resolves.

### 4. 🟠 MED — stale `watched_roots` rows never reconciled on daemon startup

- **Where:** `src/watch.ts:88-93` (cleanup loop iterates in-memory
  `this.checkouts`) and `resync`.
- **Symptom:** The unregister loop only walks `this.checkouts`, which is **empty
  on a fresh process**. If a previous daemon crashed (no `stop()`), its
  `watched_roots` rows persist forever, and read-time reconcile then verifies
  signals against a **dead/renamed checkout path**, or attributes to a checkout
  nobody watches.
- **Root cause:** `watched_roots` is process-owned state persisted in a shared DB
  with no startup reconciliation against reality.
- **How to tackle:** on `WorktreeWatcher.start()` (or first `resync`), read all
  existing `watched_roots` rows and **prune any not in the freshly computed
  `checkoutRoots()`** before/while registering the current set — i.e. make
  `resync` authoritative over the whole `co-*` namespace, not just the slugs this
  process has touched. Guard against multiple daemons if that's ever possible
  (today it's single-daemon, so full reconcile is safe).
- **Test to add:** pre-seed a stale `co-ghost` row, start the watcher on a
  single repo, assert `watchedRoots` contains only `co-root` afterward.

### 5. 🟡 LOW — `live` flag misleads for MCP-connected agents that don't edit

- **Where:** `src/board.ts:110`; upstream cause in what refreshes
  `hook_sessions.at`.
- **Symptom:** `live = now - Date.parse(at) < WATCHER_HEARTBEAT_STALE_MS` (2 min).
  But `hook_sessions.at` only refreshes on **connect** or **edit-with-session** —
  MCP `touch_files` / read-only activity does not bump it. A still-connected
  agent that is thinking/reading (not writing) goes grey after 2 min and drops
  out of the 30-min window entirely, even though it is present.
- **How to tackle:** either (a) refresh `hook_sessions.at` on any MCP tool touch
  (add a lightweight `touchHookSession(root, slug)` called from the MCP request
  path / `touch_files`), or (b) reframe the UI label — treat `hook_sessions.at`
  as "last activity" and show live/idle honestly rather than implying
  disconnection. (a) is the real fix; (b) is a cheap stopgap.
- **Note:** low priority — cosmetic until agents complain about vanishing.

### 6. 🟡 LOW — duplicate DB queries on the 5s-polled hot path

- **Where:** `src/signals.ts:408-409` (`reconcileSignals`) and `435-438`
  (`getSignals`) each call `hookSessions(root)` and `watchedRoots(root)`.
- **Symptom:** `getSignals` calls `reconcileSignals` and then repeats the same
  two `hook_sessions` / `watched_roots` SELECTs itself, on a path polled every
  5s by the dashboard. Wasted I/O, minor.
- **How to tackle:** hoist `hookSessions(root)` and `watchedRoots(root)` once in
  `getSignals` and pass them into `reconcileSignals(root, rows, tasks, {
  sessions, watched })`. Pure plumbing; no behavior change. Do this **after** #1
  and #3 since those touch the same call sites and will re-shape the signatures.

---

## Remaining ADD-07 work

### Slice C — one coherent hub DB + `doctor` reconcile (fixes ISS-13)

- **Goal:** guarantee every agent writes to, and the daemon reads from, a
  **single** Baton DB regardless of sub-project `.baton/` dirs. Today a
  sub-project can spawn a shadow `.baton/` and split the signal/session state so
  presence silently misses agents (ISS-13).
- **Scope:**
  - Root resolution: ensure `resolveMcpRoot()` for an agent inside a sub-project
    resolves **up** to the hub root's DB, not a local `.baton/`, when the hub
    owns that checkout (kb lists it as a project).
  - `doctor`: detect shadow `.baton/` dirs under the hub, report them, and offer
    to reconcile (merge/redirect) into the hub DB.
- **Dependency note:** cleaner to land **after** findings #1/#3/#4, because those
  finalize how `watched_roots` / attribution behave, and slice C changes *which
  DB* those tables live in. Sequencing: fix HIGH #1 → MED #3/#4 → slice C → LOW
  #5/#6.

---

## Suggested order

1. **#1 (HIGH)** — real correctness regression in the common single-repo case;
   fix before A+B is committed.
2. **#3, #4 (MED)** — attribution correctness + startup leak; same call sites.
3. **#2 (MED)** — decide: document limitation vs. single-session attribution.
4. **Slice C** — hub DB coherence.
5. **#5, #6 (LOW)** — polish / micro-opt.
