# Baton — Fresh Machine Setup

From zero to the running dashboard in ~10 minutes. (What/why: [STATUS.md](STATUS.md).)

> Setting Baton up on **someone else's** project via an AI agent (Cursor, Claude
> Code, …) instead of by hand? Point the agent at [AGENTS.md](AGENTS.md) — it
> walks the agent through the same steps interactively, including wiring up the
> target project and generating a personalized guide.

## Supported platforms

| Platform | Status |
| --- | --- |
| macOS | supported |
| Linux | supported |
| Windows (WSL2) | supported — it is Linux as far as Baton is concerned |
| Windows (native) | **not supported** |

Agent detection is POSIX-only: Baton finds a running agent by walking process
tables with `ps`/`lsof` on macOS and `/proc/<pid>/cwd` on Linux
([`src/agents.ts`](src/agents.ts)), and PATH repair returns nothing on `win32`
([`src/util/path-env.ts`](src/util/path-env.ts)). On native Windows the CLI and
the knowledge base still work, but the roster stays empty and terminals do not
attach — so run it under WSL2.

## Prerequisites

- **Node.js ≥ 24** (`node --version`) — the floor is `node:sqlite` + FTS5, which
  memory recall ranks with; older runtimes silently degrade it
- **git**
- **uv** (Python tool manager, for graphify): https://docs.astral.sh/uv/ — or pipx/pip
- **tmux** (interactive agent terminals in the dashboard): `brew install tmux` /
  `apt install tmux` — optional; without it, headless runs still work

## Install

```bash
git clone git@github.com:Rakshan001/Baton-Multi-Agent-.git baton
cd baton

npm install                  # CLI + daemon deps
npm install --prefix web     # dashboard deps

npm run build                # tsc → dist/
npm run build --prefix web   # vite → web/dist/ (served by baton serve)

uv tool install graphifyy    # the `graphify` CLI (knowledge graphs)

npm link                     # optional: puts `baton` on your PATH
                             # (otherwise use `node dist/cli.js …`)
```

## First run

```bash
baton kb init                # build the knowledge graph(s) + git hooks + .mcp.json
baton serve --write          # daemon + dashboard on http://localhost:7077
```

Open **http://localhost:7077** — real data, demo mode off. Create a task:

```bash
baton new "try the dashboard"   # makes a worktree under .baton/wt/
cd .baton/wt/try-the-dashboard  # start your agent here (claude / cursor / codex)
```

## Dev loop (working on Baton itself)

```bash
npm run dev --prefix web     # Vite on :5173, /api proxied to :7077
                             # NOTE: demo mode defaults ON here (showcase) —
                             # turn it off in the Tweaks panel (bottom-right)
npx vitest run               # 34 tests (root)
npx tsc --noEmit             # typecheck (run in root and in web/)
```

After backend changes: `npm run build` and restart `baton serve`.

## Wire up the agents

```bash
baton kb init                       # already wrote .mcp.json (Claude Code picks it
                                    # up in every worktree; gitignored — per machine)
baton kb mcp --agent cursor         # print config for .cursor/mcp.json
baton kb mcp --agent codex          # → ~/.codex/config.toml
baton kb mcp --agent gemini         # → ~/.gemini/settings.json
baton hooks install claude          # auto-handoff brief on session end (Stop/PreCompact)
```

Agents then get: `query_graph`/`get_node` (graphify, code navigation) and
`check_files`/`get_report`/`who_touched` (baton, coordination).

## Using Baton on another project

Each repo runs its own daemon:

```bash
cd ~/code/other-repo
baton kb init
baton serve -p 7078 --write
```

Then in the dashboard: top-left switcher → **Add connection…** → `http://localhost:7078`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `dashboard not built — run: npm run build --prefix web` | exactly that, then restart `baton serve` |
| `graphify is not installed` | `uv tool install graphifyy` (or `pipx install graphifyy`) |
| Port 7077 busy | `baton serve -p 7079` (then add it as a connection) |
| Graph missing docs/PDF content | set an LLM key (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`…) and `baton kb rebuild --full` — code-only extraction needs no key |
| Dashboard shows fake "Orbit" data | you're on the Vite dev origin with demo mode on — Tweaks panel → demo off, or use :7077 |
