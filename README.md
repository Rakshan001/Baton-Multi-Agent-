<div align="center">

# 🪄 Baton

### Plan on your expensive agent. Pass the baton to your cheap one.

**Baton is a local coordination hub + knowledge base for running multiple AI coding agents on one repo** — Claude Code, Cursor, Codex, Gemini, Aider, OpenCode. Isolated git worktrees, a realtime dashboard, shared evidence-anchored memory, installable skills, and one-file session handoff.

[Quickstart](docs/quickstart.md) · [Documentation](docs/README.md) · [CLI reference](docs/cli-reference.md) · [Architecture](docs/architecture.md)

![status](https://img.shields.io/badge/status-active-2ea043) ![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%E2%89%A520-339933) ![deps](https://img.shields.io/badge/daemon-zero--dependency-8957e5)

</div>

---

## Why Baton

Developers increasingly run two or three AI coding tools at once and split work to save money and quota — *plan and reason on a powerful (often plan-included) agent, then do the bulk editing on a cheaper one.* But the agents don't know about each other:

- They **clobber the same files** with no warning.
- Switching tools **loses all the context** — the plan, the diff, the remaining tasks die with the session.
- Each one **re-reads the whole repo** to orient, burning tokens.

Baton coordinates them on one repo: every task runs in its own **git worktree**, a local daemon streams **who's editing what** in realtime, a queryable **knowledge graph** lets agents navigate instead of grepping, **shared memory** carries verified facts between sessions, and a single **`HANDOFF.md`** carries a curated, execution-ready brief — with a cost estimate — from one agent to the next.

> One file (`HANDOFF.md`). No server lock-in. No database. Open source.

## The core idea: pass the baton

```
Claude Code (plan / think)                 Cursor · Codex · Gemini (edit cheap)
──────────────────────────                 ─────────────────────────────────────
  baton pass my-task --to cursor ─────────▶  HANDOFF.md  ─────────▶  baton take my-task
  (curated brief + est_cost_usd)            (objective · plan ·      (prints the execution
                                             files · git state ·      prompt, marks in-progress)
                                             graph excerpt)                  …agent edits…
                                                                            baton done
```

Do the expensive thinking where it's powerful (or included in your plan); do the bulk editing where it's cheap. Baton emits a **minimal, cheap-to-execute brief with a token/cost estimate** — not a raw history dump.

## Quick start

> **Prefer to have an agent do this for you?** Paste this repo into Cursor or
> Claude Code and say "set this up for me" — it'll follow [AGENTS.md](AGENTS.md),
> ask what it needs to know (which project to wire up, which agents you use,
> which port), run every command itself, and leave you a personalized
> `GETTING_STARTED.md` in your project when it's done.

Requires **Node ≥ 20**, **git**, and [**uv**](https://docs.astral.sh/uv/) (for the graphify knowledge graph). See [docs/installation.md](docs/installation.md) for details.

```bash
git clone https://github.com/Rakshan001/Baton-Multi-Agent-.git baton && cd baton

npm install && npm install --prefix web   # CLI/daemon + dashboard deps
npm run build && npm run build --prefix web
uv tool install graphifyy                 # the graphify CLI (code graphs)
npm link                                  # optional: puts `baton` on your PATH

baton kb init        # index the repo into a knowledge graph + wire up agents
baton serve --write  # daemon + dashboard → http://localhost:7077
```

Then create an isolated session and point an agent at it:

```bash
baton new "refactor the auth middleware"   # → branch baton/… + worktree under .baton/wt/
cd .baton/wt/refactor-the-auth-middleware  # start claude / cursor / codex here
```

**Working across several repos?** Run `baton setup` on the folder that holds them to create one **hub** — a single dashboard + merged knowledge graph over all of them. `baton serve` runs from the hub root (which needn't be a git repo); each task just names its sub-project, and the worktree branches off that repo:

```bash
baton new "fix the checkout crash" --project api-server   # or pick it in the dashboard
```

## What you get

| | Feature | What it does |
|---|---|---|
| 🌳 | **Worktree isolation** | Every task gets its own git worktree + `baton/<slug>` branch. No clobbered branches, ever. |
| 🧠 | **Knowledge graph** | [`baton kb`](docs/knowledge-graph.md) indexes your repo into a queryable graph (via [graphify](https://pypi.org/project/graphifyy/)) + a `CODEBASE.md` map. Agents navigate instead of grepping — the map is **~300× cheaper** than reading the files. |
| 🤝 | **Session handoff** | [`baton pass`](docs/session-handoff.md) packages a session into one `HANDOFF.md` — objective, plan, checklist, files, git state, **cost estimate** — and `baton take` turns it into an execution prompt. |
| 📡 | **Live edit signals** | A realtime dashboard (SSE) shows who's editing what. Two sessions on one file → an **overlap warning before the conflict**. |
| 📌 | **Evidence-anchored memory** | [Shared facts](docs/memory.md) pinned to commits + file content hashes. When an anchored file changes, the fact is **withheld** — agents can't hallucinate from stale knowledge. |
| 🧩 | **Installable skills** | A [catalog of reusable agent playbooks](docs/skills.md) — one click writes a skill into the agent's own config (`.claude/skills/…`, `.cursor/rules/…`). Ships a flagship `bug-fix` skill + an efficiency & traceability pack. |
| 🔀 | **Agent routing** | [`baton route`](docs/agent-routing.md) picks the right agent per task from committed rules (deterministic, no LLM). |
| 🧭 | **MCP tools** | [`baton mcp`](docs/mcp-tools.md) exposes coordination tools (`check_files`, `who_touched`, `recall_memory`, …) to every agent over MCP. |

## The dashboard

`baton serve` serves a realtime React dashboard at **http://localhost:7077** — a Command Center board, live Activity, Conflicts, the Knowledge Graph, Memory, History, an Agents roster (with one-click MCP wiring), and the Skills catalog. It binds to `127.0.0.1` only and is read-only until you pass `--write`. See [docs/dashboard.md](docs/dashboard.md).

## Documentation

Full docs live in [**`docs/`**](docs/README.md):

- **[Installation](docs/installation.md)** · **[Quickstart](docs/quickstart.md)** · **[CLI reference](docs/cli-reference.md)**
- **[Dashboard](docs/dashboard.md)** · **[Knowledge base](docs/knowledge-graph.md)** · **[Session handoff](docs/session-handoff.md)**
- **[Skills](docs/skills.md)** · **[Project memory](docs/memory.md)** · **[MCP tools](docs/mcp-tools.md)** · **[Agent routing](docs/agent-routing.md)**
- **[Configuration](docs/configuration.md)** · **[Security model](docs/security.md)** · **[Architecture](docs/architecture.md)** · **[Troubleshooting & FAQ](docs/troubleshooting.md)**

## How it's built

- **Zero-dependency daemon** — `src/server.ts` is raw `node:http`. No express, no fastify.
- **Realtime is SSE**, not socket.io — every live event flows through one bus.
- **Git-native** — no external database; a small local SQLite index over your real git history. All git runs **shell-free** through a hardened wrapper.
- **Loopback-only + write-gated** — the daemon binds `127.0.0.1`, and every mutating request requires a loopback origin and (mostly) `--write`. See [the security model](docs/security.md).
- **Strict TypeScript** in two workspaces (root + `web/`).

## Contributing

Baton is an open-source personal project. Issues and PRs welcome. Start with [STATUS.md](STATUS.md) (what's built, what's pending, where things live) and [docs/architecture.md](docs/architecture.md).

```bash
npm run build && npx vitest run        # backend build + tests
npm run build --prefix web             # dashboard build
node dist/cli.js serve --write         # run it locally
```

## License

MIT © Rakshan Shetty. See [LICENSE](LICENSE).

<div align="center"><sub><b>Pass it on.</b></sub></div>
