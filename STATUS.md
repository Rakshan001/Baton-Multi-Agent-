# Baton — Project Status

> Snapshot of what is BUILT, what is PENDING, and where things live.
> Update this file at the end of every working session.
> Last updated: **2026-06-11** (branch: `feat/worktree-orchestration`, merged to `main`)

## What this project is

Baton is a **centralized knowledge base + coordination hub for multiple AI coding
agents** (Claude Code, Cursor, Codex, Gemini CLI, Aider, OpenCode) working on the
same repo. Each task runs in an isolated git worktree; a local daemon + dashboard
give you: a code knowledge graph agents can query, realtime visibility into who is
editing what, warnings when two sessions touch the same file, completion reports so
waiting agents know when a bug is already fixed, and session handoff briefs so work
continues on a cheaper agent when Claude Code hits its session limit.

Vision docs: [README.md](README.md) · [BUILD.md](BUILD.md) · [MVP.md](MVP.md). Setup: [SETUP.md](SETUP.md).

## Built & verified ✅

| Feature | What it does | See it work |
|---|---|---|
| **Graphify knowledge base** | `baton kb init` indexes the repo (sub-projects auto-detected → one graph each + merged view) via the external `graphify` CLI; git hook auto-rebuilds on commit; MCP config generated so agents can `query_graph` | `baton kb init && baton kb status`; dashboard → Knowledge Graph |
| **Knowledge Graph page** | Force-directed canvas of graph.json: search + neighbor highlight, community filters, node inspector with source locations, write-gated Rebuild | dashboard → Knowledge Graph (654 nodes on this repo) |
| **SSE realtime** | `GET /api/events` pushes status/task/commit/agent/file/kb/handoff events; per-worktree fs watcher; daemon-side status diffing; UI shows "Live (push)" and updates instantly | `curl -N localhost:7077/api/events` then touch a file in a worktree |
| **Edit signals** | Live "task X is editing file Y"; 2+ sessions on one path → `signal.overlap` warning in Conflicts + Activity | edit the same file in two worktrees, watch Conflicts page |
| **check-before-edit** | Agents ask "is this file busy?" via `baton mcp` tool `check_files` or `GET /api/signals/check?files=…` | `baton signals` / curl |
| **Completion reports** | On merge: summary + files + commits persisted (`.baton/reports/<slug>.md`), pushed to overlapping sessions, shown in History; `get_report` MCP tool answers "is my bug already fixed?" | merge a task, then `curl localhost:7077/api/reports` |
| **Agent blame** | `baton blame <file>` / `GET /api/blame` — which task/agent touched a file (merged history + live editors) | `baton blame src/cli.ts` |
| **Session handoff** | `baton pass` parses the Claude Code JSONL session → `HANDOFF.md` brief (plan, files touched, git state, graph excerpt); `baton take` prints the execution prompt; `baton done`; Claude Stop/PreCompact hooks via `baton hooks install claude`; Handoff dialog in dashboard drives the real endpoint | `baton pass <slug> --to cursor` then `baton take <slug>` |
| **Static dashboard serving** | `baton serve` serves the built UI at the same port as the API (SPA fallback, traversal-guarded) | `npm run build --prefix web && baton serve` → http://localhost:7077 |
| **Real project switcher** | Connections model: register multiple daemons (one per repo, `baton serve -p <port>`), switch between them in the top-left switcher; identity from each daemon's `/api/meta` | top-left switcher → "Add connection…" |
| **Real Live Session** | Demo's fake website mock + fake dev-servers are gone; real mode streams the SSE feed per session (edits, commits, attach/detach, overlap warnings) with API backfill | open a session → Live |
| **Honest Activity page** | Real mode: active/commits/files/progress cards, per-agent commits+files rollup, live edit-signals section; fake token numbers exist only in demo mode | Activity page with demo OFF |

Tests: 34 vitest tests at root, all green. Both workspaces strict TS, build clean.

## Pending / next 🔜

1. **Final in-browser pass of the real-mode UI items** — code + builds + curl verified;
   the visual walkthrough (add-connection flow with a second daemon, real Live feed,
   real Activity) was interrupted mid-verification. Steps are in the Verification
   section of the last plan; ~15 min.
2. **Launch dialog "attach agent" is still a labelled preview** — worktree creation is
   real (POST /api/tasks); the agent process must be started manually in the worktree.
   Auto-spawn (e.g. `baton new --agent claude` running `claude` in the worktree) is unbuilt.
3. **Real token usage** — no data source yet; the demo showcase keeps illustrative
   numbers behind the demo flag. Possible source: parse session JSONL sizes (the
   handoff parser already estimates tokens).
4. **npm packaging** — `package.json` `files` only ships `dist/`; `web/dist` must be
   included (or copied into `dist/web`) before publishing the CLI to npm.
5. **Roadmap (MVP.md)** — M3 redaction-first secret stripping for safe export; M4 link
   sharing + permissions (hosted phase).

## Where things live

```
src/cli.ts            CLI registration (kb, pass/take/done, hooks, mcp, signals, blame…)
src/server.ts         daemon: /api/* + SSE /api/events + static dashboard serving
src/events.ts         transport-agnostic event bus (ring buffer for SSE replay)
src/watch.ts          per-worktree recursive fs watcher → file.edited events
src/poller.ts         daemon-side status differ (runs only while SSE clients exist)
src/signals.ts        live edit signals + checkFiles (the wait/coordinate layer)
src/reports.ts        completion reports (built at merge time)
src/mcp.ts            `baton mcp` stdio server (check_files, get_report, who_touched…)
src/kb/               graphify wrapper, sub-project detection, kb state, MCP snippets
src/handoff/          Claude JSONL session parser + HANDOFF.md brief builder
web/src/lib/connections.ts   daemon connections (real project switcher)
web/src/hooks/useEvents.ts   SSE client hook
web/src/features/            one file per screen; KnowledgeGraph.tsx is the graph page
.refs/                reference open-source code (graphify etc.) — gitignored, learning only
```

**Demo mode is the showcase, not a bug**: default ON only on the Vite dev origin
(`:5173`); the daemon-served UI (`:7077`) is real by default. Real-mode changes must be
gated on `BatonAPI.demo` so the demo keeps working.
