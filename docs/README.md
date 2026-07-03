# Baton documentation

Everything you need to run multiple AI coding agents on one repo with Baton. New here? Start with **[Installation](./installation.md)** → **[Quickstart](./quickstart.md)**.

> Baton is a local, zero-dependency coordination hub + knowledge base for AI coding agents. A daemon (`baton serve`) gives you a realtime dashboard at `http://localhost:7077`; the CLI scaffolds isolated git worktrees, packages session handoffs, and indexes your repo into a queryable knowledge graph. See the [README](../README.md) for the elevator pitch.

## Getting started

| Page | What it covers |
|---|---|
| [Installation](./installation.md) | Prerequisites (Node ≥ 20, git, uv, tmux) and a from-scratch install. |
| [Quickstart](./quickstart.md) | From clone to the running dashboard and your first handoff, in ~10 minutes. |
| [CLI reference](./cli-reference.md) | Every `baton` command, argument, and flag. |

## Features

| Page | What it covers |
|---|---|
| [The dashboard](./dashboard.md) | The realtime web UI: screens, project switcher, read-only vs `--write`, demo mode. |
| [Knowledge base](./knowledge-graph.md) | `baton kb` — graphify code graphs, the `CODEBASE.md` map, export/import/share. |
| [Session handoff](./session-handoff.md) | `baton pass` / `take` / `done`, the `HANDOFF.md` brief, and the Claude hooks. |
| [Skills](./skills.md) | The skills catalog, installing into agent config, and importing your own. |
| [Project memory](./memory.md) | Evidence-anchored shared facts and the anti-hallucination model. |
| [MCP tools](./mcp-tools.md) | The coordination tools agents get over MCP, and how to wire each agent. |
| [Agent routing](./agent-routing.md) | Picking the right agent per task — modes, severity, tiers. |

## Operating Baton

| Page | What it covers |
|---|---|
| [Configuration & files](./configuration.md) | The `.baton/` layout, `baton.config.json`, generated config, and env vars. |
| [Security model](./security.md) | Loopback binding, the anti-CSRF gate, the `--write` gate, and what's hardened. |
| [Architecture](./architecture.md) | How the daemon, event bus, watchers, and storage fit together (for contributors). |
| [Troubleshooting & FAQ](./troubleshooting.md) | Common problems with fixes, plus frequently asked questions. |

## Reference & design notes

Project status and setup live at the repo root:

- [STATUS.md](../STATUS.md) — what's built, what's pending, where things live.
- [SETUP.md](../SETUP.md) — fresh-machine setup.
- [BUILD.md](../BUILD.md) / [MVP.md](../MVP.md) — product vision and scope.
- [CLAUDE.md](../CLAUDE.md) — context auto-loaded by Claude Code (conventions + commands).

The research that scoped Baton (2026-06 snapshot) is preserved under [`research/`](./research/) and the numbered notes in this folder:

- [01 — Coordination & locking](./01-coordination-and-locking.md)
- [02 — Handoff market](./02-handoff-market.md)
- [03 — Session export tools](./03-session-export-tools.md)
- [Tiered routing plan](./TIERED-ROUTING-PLAN.md) · [KB token & storage research](./research/kb-token-and-storage.md)
- [Landing-page build prompt](./landing-page-prompt.md) — brief for the marketing site (see [`site/`](../site/)).
