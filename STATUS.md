# Baton — Project Status

> Snapshot of what is BUILT, what is PENDING, and where things live.
> Update this file at the end of every working session.
> Last updated: **2026-06-11 (session 4: UI verification pass)** (branch: `feat/worktree-orchestration`, merged to `main`)

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
| **CODEBASE.md layer** | `baton kb init/rebuild` generates a <2k-token deterministic map per project (stack, tree, top graph symbols, query pointers) + a root index for multi-server containers; staleness footer tied to the graph's commit; AGENTS.md tells agents to read it first. Prior art: Aider repo-map, Repomix, llms.txt | `baton kb rebuild` → open CODEBASE.md; `baton kb status` flags staleness |
| **Agent routing** | `baton.config.json` (committed): plan→claude/opus, UI→gemini, bugfix→codex, default cursor; `baton pass` without `--to` auto-routes (word-boundary keyword scoring, no LLM); `baton route "<task>"`; `/api/routing`; Handoff dialog preselects with a "suggested" chip, Launch shows a suggestion row, Settings shows the rules. Prior art: claude-code-router | `baton route "fix the crash"` → codex; `baton pass <slug>` → routed frontmatter |
| **KB export/import/share** | `baton kb export` → .tar.gz pack (graphs + CODEBASE.md + manifest with git HEAD); `baton kb import <pack\|kb/>` re-anchors paths, validates graphs, reports "N commits behind" and auto-refreshes; dashboard Export/Import buttons on the Knowledge Graph page; `baton kb share on` keeps a committed `kb/` dir so teammates clone-and-go | export, clone repo elsewhere, `baton kb import <pack>` → graphs appear with zero re-indexing |
| **Real token usage** | `baton usage` + `GET /api/usage`: parses Claude Code session JSONLs (input/output/cache tokens + est cost per session, mtime-cached), mapped to task slugs; Activity shows a real "Tokens used (Claude)" card + per-session tokens; KB page shows the savings metric (this repo: map ≈ 824 tokens vs ≈ 248k reading it — ~300× cheaper). Prior art: Orca | `baton usage` |
| **Headless agent launch** | `baton start <slug> [--agent claude\|codex\|gemini]` runs the agent's print mode in the worktree (prompt = HANDOFF.md brief when present), output streamed as `agent.output` SSE events into the Live screen; `baton stop`; Detail "Start agent" button; Launch dialog "start headless after create" (its Preview badge disappears on that path); 409 on double-start; never adds permission-bypass flags. Prior art: Rover | `baton start <slug> --prompt "say hi"` |
| **Interactive agent terminals** | Real PTY sessions in the dashboard: tmux hosts each session (`baton-<repoHash>-<slug>`, zero new daemon deps, survives daemon restarts), driven via one control-mode client per session; output → per-session SSE stream (`/api/tasks/:slug/terminal/stream`, snapshot+live), input/resize → POST (hex-encoded send-keys, injection-proof); xterm.js panel in the Live screen (Terminal tab, auto-selected when live), Launch dialog 3-way start mode (worktree only / interactive / headless), Detail "Open terminal" button; mutual 409 with headless runs; kill-on-task-remove; tmux-missing → capability flag + install hint; demo mode plays a canned transcript. All six agents launchable (`cursor-agent` for cursor; aider/opencode bare). Prior art: handler.dev (tmux+capture-pane), claude-squad | Launch → "Open interactive terminal" → type into the live claude TUI; `tmux ls`; kill daemon, restart → session reattaches |

Tests: 34 vitest tests at root, all green. Both workspaces strict TS, build clean.

## Pending / next 🔜

1. **Headless one-shot runs still aren't shown as "active" on the status board**
   (`claude -p` children are too short-lived for the `src/agents.ts` ps scan).
   Interactive tmux terminals DO show as active — the agent process persists with
   the worktree cwd, so the scan catches it (verified 2026-06-12). Worth wiring
   `runningHeadless()` into `collectStatus` for the one-shot case too.
2. **tmux test-environment caveat** (2026-06-12): a daemon launched inside a
   sandboxed wrapper (e.g. the IDE preview helper) can wedge the shared tmux server
   (orphaned control client stops draining → every tmux command on the machine
   hangs). Hardening added: control clients attach with `-d` (kick stale clients),
   all one-shot tmux calls have a 10s timeout, errors surface as clean 4xx/503.
   Normal usage — `baton serve` run from a real terminal — is unaffected (verified
   end-to-end). If tmux ever wedges: `pkill -f 'tmux -C attach' && rm -rf /tmp/tmux-$UID`.
3. **Visual pass** — confirmed in-browser 2026-06-12: Launch 3-way start mode (radio
   group, Preview badge clears on real modes), real claude TUI rendering in the Live
   Terminal tab via SSE, keystrokes from the browser moving the TUI selector, tmux
   session create/adopt/kill from the UI. Still pending a look when Chrome MCP is up:
   Handoff "suggested" chip (demo-verified earlier).
3. **Non-Claude token usage** — codex/gemini session formats aren't parsed yet
   (src/usage.ts is Claude-only); their sessions show no token data.
4. **Fleet broadcast** (Daintree-style: one prompt → N sessions at once) — researched,
   deferred by user choice this round.
5. **npm packaging** — `package.json` `files` only ships `dist/`; `web/dist` must be
   included (or copied into `dist/web`) before publishing the CLI to npm.
6. **Roadmap (MVP.md)** — M3 redaction-first secret stripping for safe export; M4 link
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
src/kb/codebasemd.ts  CODEBASE.md generation (tree, stack, god-nodes, staleness footer)
src/kb/transfer.ts    KB export/import/share (tar pack, re-anchor, committed kb/ dir)
src/routing.ts        task-type → agent routing (baton.config.json, keyword scoring)
src/usage.ts          real token usage from Claude session JSONLs (+ cost estimates)
src/spawn.ts          headless agent runs (claude -p / codex exec / gemini -p)
src/handoff/          Claude JSONL session parser + HANDOFF.md brief builder
web/src/lib/connections.ts   daemon connections (real project switcher)
web/src/hooks/useEvents.ts   SSE client hook
web/src/features/            one file per screen; KnowledgeGraph.tsx is the graph page
.refs/                reference open-source code (graphify etc.) — gitignored, learning only
```

**Demo mode is the showcase, not a bug**: default ON only on the Vite dev origin
(`:5173`); the daemon-served UI (`:7077`) is real by default. Real-mode changes must be
gated on `BatonAPI.demo` so the demo keeps working.
