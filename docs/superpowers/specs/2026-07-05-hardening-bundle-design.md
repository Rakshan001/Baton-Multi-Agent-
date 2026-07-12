# Audit hardening bundle — security + perf fixes

**Date:** 2026-07-05 · **Status:** approved · **Scope:** backend (`src/`) only

## Problem

The 2026-07 security/perf audit found no critical vulnerabilities, but left a
bundle of defense-in-depth and efficiency gaps. Its #1 finding — the graphify
process explosion — was already fixed by the shared graphify server
(2026-07-03 plan). This bundle covers the rest. Two corrections to the audit,
verified against current code: memory-freshness hashing is already
mtime-cached (item dropped by user decision), and tasks.json writes are
already crash-atomic via tmp+rename — the remaining gap is lost updates
between concurrent writers (CLI command vs daemon), not torn files.

**Standing correction (from the audit review):** the auditor's proposed
"stop the upward walk at the git repo root" fix for `resolveBatonRoot` must
NOT be applied — hub sub-repos are git repos without `.baton/`, and resolving
the hub root from inside one requires walking past the sub-repo boundary.
Only the ownership check ships.

## Fixes

| # | Fix | Where | Behavior |
|---|-----|-------|----------|
| 1 | kb.json path validation | `src/kb/state.ts` `loadKb()` | After parse, drop any `projects[]` entry whose `path` fails: `realpath` resolves to root or under root; is a directory; contains `.git` (dir **or** file — worktrees). One `console.warn` per unique bad path (module-level seen-set). All callers unchanged; downstream (graphify spawn, `readStats`, merge rebuild) only sees vetted paths. |
| 2 | `.baton` ownership gate | `src/store.ts` `resolveBatonRoot()` | Accept a found `.baton` dir only if `stat.uid === process.getuid()` and it is not world-writable (`(mode & 0o002) === 0`). Group-writable is deliberately allowed — Debian/Ubuntu user-private-group setups (umask 002) make group-writable dirs the norm, and the uid match already rejects dirs planted by another user. Failing dir → warn once, **continue walking up** (planted dir can't hijack; legit hub root above still wins). No-op when `process.getuid` is undefined (Windows). |
| 3 | Scoped merge rebuild | `src/commands/merge.ts:104` | Enqueue a rebuild only for the project whose `path` realpath-equals the merged task's repo (`task.repoRoot ?? repoRoot`). No match → rebuild nothing, log once. Preserve the existing merged-graph refresh mechanism for the affected project (plan pins the exact trigger after code check). |
| 4 | detectAgents TTL cache | `src/agents.ts` | Module-level single-entry cache: key = sorted `worktreePaths` joined, TTL 2000 ms, value = the result `Map`; hits return a defensive copy. Collapses board 2s poll + `/api/status` + `/api/signals` bursts (audit: up to 12 scans/s) to ≤1 `ps`/`lsof` sweep per 2 s. Staleness ≤2 s is invisible at the dashboard's own 2 s cadence. |
| 5 | SSE connection cap | `src/server.ts` | Two counters — `/api/events` streams and terminal streams — each capped at 64 concurrent. At cap: `429 {"error":"too many event streams"}`. Decrement on `close`. `bus.setMaxListeners(0)` stays (intentional); the bound lives at the connection layer where cleanup already exists. |
| 6 | tasks.json cross-process lock | `src/store.ts` | Advisory lock around read-modify-write in `addTask`/`removeTask`: acquire = `mkdir(.baton/tasks.lock)` (atomic), retry 25 ms up to 2 s, break locks older than 5 s, release in `finally`. On timeout: warn and proceed (availability over strictness; tmp+rename keeps writes crash-safe). Existing in-process `serialized()` queue stays. |
| 7 | tmux prefix entropy | `src/util/tmux.ts:41` | SHA1 slice 6 → 10 hex chars (24 → 40 bits). Sessions created under the old prefix stop matching and age out; accepted, no migration. |

## Edge cases

| Case | Behavior |
|------|----------|
| Project path is a symlink escaping root | `realpath` containment rejects it |
| Project is a git worktree (`.git` file) | accepted (stat succeeds on files too) |
| Single-repo mode (`path === root`) | containment allows equality |
| Bad kb.json entry under 2 s polling | warn once per path, not per call |
| `.baton` owned by another user / world-writable | skipped, walk continues, legit root above still found |
| `.baton` group-writable (Ubuntu user-private-group umask 002) | accepted — uid match is the real gate |
| Merge in a repo matching no kb project | no rebuild, single log line (merged graph was never refreshed on merge before; unchanged) |
| Running as a user without `getuid` (Windows) | ownership check skipped entirely |
| 65th concurrent dashboard tab | 429 on the event stream; UI polling still works |
| Daemon + CLI write tasks.json simultaneously | lock serializes; neither update lost |
| Lock left behind by a crashed process | broken after 5 s age |
| Lock never acquirable within 2 s | warn + proceed unlocked (no deadlock) |

## Out of scope

Memory-freshness result TTL (already mtime-cached; dropped by user decision),
the auditor's git-boundary stop (breaks hubs), multi-daemon port coordination,
Windows ACL checks.

## Testing

New vitest coverage: (1) outside-root/symlink-escape/non-git entries dropped,
`.git`-file worktree kept, warn-once behavior; (2) world-writable `.baton`
skipped during walk — POSIX-only test (`chmod`), skipped on Windows; (3) the
project-matching helper for scoped rebuild; (4) TTL cache via fake timers —
second call within TTL does not rescan, after TTL does, defensive copy
verified; (6) interleaved add/remove from two simulated writers both persist;
(7) prefix-length assertions updated. Item 5 verified via the existing
spawned-daemon e2e pattern if cheap, else build + code review. Baseline 292
tests stay green. Zero new dependencies; daemon stays raw `node:http`; all
git via `src/util/exec.ts`.
