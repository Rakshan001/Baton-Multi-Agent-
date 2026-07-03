# Architecture

How Baton is put together for contributors: a zero-dependency local daemon, an
event bus that feeds Server-Sent Events, lazy status polling, per-worktree file
watchers, SQLite indexes over git history, a serialized graphify build queue, and
two independent TypeScript workspaces.

This page maps the moving parts to source files. For the running inventory of
what is built and where it lives, see [STATUS.md](../STATUS.md); for the
conventions you must not break, see [CLAUDE.md](../CLAUDE.md).

## The big picture

Baton runs one local daemon per repo. `baton serve` starts it; it binds
`127.0.0.1` only and serves both a JSON API (+ SSE) and the built React dashboard
on the same port (default `7077`). Each task lives in an isolated git worktree
under `.baton/`. The daemon never reaches off-machine.

```
                 baton serve  (src/server.ts, raw node:http, 127.0.0.1)
                 ┌──────────────────────────────────────────────┐
  dashboard ◀────│  /api/* JSON  ·  /api/events SSE  ·  static    │
  curl / MCP     │                                                │
                 │   event bus (src/events.ts) ── ring buffer     │
                 │     ▲        ▲          ▲          ▲            │
                 │     │        │          │          │            │
  status poller ─┘     │        │          │          │            │
  (src/poller.ts)      │        │          │          │            │
  fs watchers ─────────┘        │          │          │            │
  (src/watch.ts)                │          │          │            │
  signals/reports/history ──────┘          │          │            │
  (node:sqlite)                            │          │            │
  graphify build queue ────────────────────┘          │            │
  (src/kb/state.ts)                                    │            │
  git via src/util/exec.ts (shell-free) ───────────────┘            │
                 └──────────────────────────────────────────────┘
```

## Zero-dependency daemon

`src/server.ts` is raw `node:http` — **no express/fastify, by convention**. A
single `handle(req, res, root, opts)` function does method/path matching with
plain regexes and returns JSON via a shared `send()` helper. Notable properties:

- **Loopback only.** The server `listen`s on `127.0.0.1`. CORS echoes the request
  Origin only if it is loopback (`corsOrigin`), otherwise falls back to
  `http://localhost:5173`.
- **Central anti-CSRF guard.** Every mutating `/api/*` request must carry a
  loopback `Origin` (`isMutatingMethod` + `isLoopbackOrigin` in
  [src/util/origin.ts](../src/util/origin.ts)), enforced once in `handle()` so new
  endpoints are covered by default. The loopback dashboard and `curl` (no Origin)
  pass; a malicious site you visit cannot fire writes at the daemon.
- **Write gate.** Mutating routes call `denyReadOnly()` unless the daemon was
  started with `--write` (`opts.writeEnabled`). The dashboard reads this from
  `/api/meta`.
- **Body caps.** JSON bodies cap at 1 MB (`readBody`); the KB import upload caps
  at 200 MB; `/api/storage/purge` is additionally guarded by a typed confirm
  phrase.
- **Static SPA.** Non-`/api` requests serve the built dashboard from
  `web/dist` with a traversal guard and SPA fallback; stream errors tear down the
  socket instead of crashing the daemon.

For the full endpoint list see [STATUS.md](../STATUS.md) and the docs
[dashboard](./dashboard.md) page.

## Event bus + SSE

All "live" data flows through one transport-agnostic bus,
[src/events.ts](../src/events.ts). Emitters publish typed `BatonEvent`s
(`status.changed`, `task.created`, `commit.created`, `file.edited`,
`signal.overlap`, `kb.rebuilt`, `agent.*`, `terminal.*`, `memory.updated`, …);
the SSE endpoint is just one subscriber. **New event types go here first** — this
is the seam that keeps the realtime layer SSE-but-swappable.

- `bus` is a single `BatonBus extends EventEmitter` with `setMaxListeners(0)` (each
  SSE connection adds one listener — intentional fan-out, not a leak).
- A **ring buffer** of the last 200 events with monotonic ids lets a reconnecting
  SSE client replay what it missed via `Last-Event-ID` (`bus.since(lastId)`).
- High-volume `terminal.output` bytes are emitted live but **never ringed** — they
  would evict useful events; terminals keep their own per-session scrollback for
  late joiners.

`GET /api/events` (`handleEvents`) writes the SSE stream, replays missed events,
skips `terminal.output`, and sends a `: ping` heartbeat every 25s. Raw terminal
bytes instead flow on the per-session stream `GET /api/tasks/:slug/terminal/stream`
(`handleTerminalStream`), which sends one base64 snapshot frame then live frames.

## Status poller (runs only while watched)

[src/poller.ts](../src/poller.ts) is the daemon-side change detector. Instead of N
dashboard clients each polling git, the daemon scans **once** and pushes diffs to
all of them.

- It is **reference-counted**: each SSE connection calls `poller.retain()` and
  releases on disconnect. The interval starts on the first listener and stops at
  zero — **an idle daemon does no git work**.
- It diffs `collectStatus()` every 2s, publishing `status.changed` on any change
  plus derived `agent.started/stopped` and `commit.created` events. A `running`
  guard skips a beat rather than stacking overlapping git scans.

## Per-worktree fs watchers

[src/watch.ts](../src/watch.ts) gives the "agent X is editing auth.ts right now"
signal without waiting for a commit. `WorktreeWatcher` keeps one
`fs.watch({ recursive: true })` per task worktree (slug → watcher):

- Uses `node:fs.watch` (recursive is supported on macOS/Windows/Linux on the
  Node 20 floor) — **no chokidar, stays dependency-free**.
- Reconciles watchers with the task store on `task.created`/`task.removed`, and
  also watches `.baton/tasks.json` so tasks created by a CLI process (not the HTTP
  API) are still picked up.
- Ignores `.git`, `node_modules`, `dist`, editor swap/temp files, etc., and
  debounces 300ms before publishing `file.edited`.

Those `file.edited` events feed the live edit-signal / overlap-warning layer in
`src/signals.ts`.

## SQLite history & reports index

Bug-tracing and attribution use Node's **built-in `node:sqlite`** — again no
external dependency. Three modules open their own DB under `.baton/` (gitignored):

| Module | DB | Purpose |
|---|---|---|
| [src/history.ts](../src/history.ts) | `history.db` | tasks + commits index — "who/what touched this file?" cheaply, instead of scanning `git log` |
| [src/reports.ts](../src/reports.ts) | `reports.db` | completion reports persisted at merge time |
| [src/signals.ts](../src/signals.ts) | live edit signals | the wait/coordinate layer |

`node:sqlite` is a recent builtin that some bundlers (Vite) cannot statically
resolve, so it is loaded **lazily at runtime** via `createRequire` with a
type-only import for types. DBs open with `WAL` + `synchronous=NORMAL`; the git
history itself (including archived refs) stays the source of truth — these are
just fast indexes. Permanent purge releases the SQLite handle before unlinking
`history.db`.

## Git: shell-free and hardened

**All git goes through [src/util/exec.ts](../src/util/exec.ts)** — a hardened,
shell-free runner. Never shell out to `git` directly. Higher-level helpers live in
`src/git.ts` (`gitRoot`, `currentBranch`, `branchCommits`, archive-ref and gc
helpers used by purge, …). This keeps slugs and arguments injection-proof and is
why deleting a task can leave commits reachable only via hidden
`refs/baton/archive/*` until an explicit purge.

## Graphify build queue

The knowledge base is built by the external `graphify` CLI. To stop two indexer
processes racing on one project, [src/kb/state.ts](../src/kb/state.ts) exports a
serialized `buildQueue` (`BuildQueue`):

- `enqueue(id, job, onDone)` chains jobs **per project id** — at most one graphify
  process per id, same-id builds queue behind each other.
- `isBuilding(id)` / `buildingIds()` expose live status to `GET /api/kb`.
- `POST /api/kb/rebuild` enqueues per-project (incremental `update` or full
  `buildGraph`) plus a merged-graph job, then publishes `kb.rebuilt`. The daemon
  debounces those events to regenerate `CODEBASE.md` once per rebuild burst.

The rest of the KB lives under `src/kb/` (graphify wrapper, sub-project detection,
KB state, MCP snippets, `CODEBASE.md` generation, export/import). See the docs
[skills](./skills.md) and [mcp-tools](./mcp-tools.md) pages for adjacent surfaces,
and [memory](./memory.md) for the evidence-anchored fact store.

## Two TypeScript workspaces (no monorepo tool)

Baton is **two separate `package.json`s with no monorepo tool**:

- **root** — the daemon, CLI, MCP server, and all of `src/`; builds to `dist/`.
- **`web/`** — the React + Vite dashboard; builds to `web/dist/`, which the daemon
  serves.

Both are **strict TypeScript** and build independently. Some logic (e.g. routing
rules) is intentionally mirrored and parity-locked rather than shared via a
package. Demo mode defaults ON only on the Vite dev origin (`:5173`); the
daemon-served UI (`:7077`) is real.

```bash
npm run build && npx vitest run     # backend build + tests
npm run build --prefix web          # dashboard build (served by baton serve)
node dist/cli.js serve --write      # daemon + dashboard on :7077
npm run dev --prefix web            # UI dev server :5173 (demo defaults ON)
```

## Key directories

```
src/cli.ts            CLI registration (kb, pass/take/done, hooks, mcp, signals, blame…)
src/server.ts         daemon: /api/* + SSE /api/events + static dashboard serving
src/events.ts         transport-agnostic event bus (ring buffer for SSE replay)
src/poller.ts         daemon-side status differ (runs only while SSE clients exist)
src/watch.ts          per-worktree recursive fs watcher → file.edited events
src/signals.ts        live edit signals + checkFiles (the wait/coordinate layer)
src/reports.ts        completion reports (built at merge time)
src/history.ts        node:sqlite history index (who/what touched a file)
src/mcp.ts            `baton mcp` stdio server (check_files, get_report, who_touched…)
src/util/exec.ts      hardened, shell-free command runner (all git goes through it)
src/util/origin.ts    loopback-Origin anti-CSRF helpers
src/kb/               graphify wrapper, sub-project detection, kb state, build queue, MCP snippets
src/agents/           agent registry (one entry per CLI) + roster + MCP connect
src/skills/           skill catalog + install/import; bundled/<id>/ = file-backed skills
src/routing.ts        task-type → agent routing (baton.config.json, keyword scoring)
src/spawn.ts          headless agent runs · src/terminals.ts  interactive tmux PTYs
web/src/hooks/useEvents.ts   SSE client hook
web/src/features/            one file per dashboard screen
.refs/                reference open-source code — gitignored, learning only (never import)
```

## Related

- [STATUS.md](../STATUS.md) — what is built / pending and the canonical "where things live" map.
- [dashboard.md](./dashboard.md) — the screens served by the daemon and their endpoints.
- [mcp-tools.md](./mcp-tools.md) — the MCP surface agents call into.
