<div align="center">

# 🪄 Baton

### Plan on your expensive agent. Pass the baton to your cheap one.

**Baton is a local coordination hub + knowledge base for running multiple AI coding agents on one repo** — Claude Code, Cursor, Codex, Gemini, Aider, OpenCode. Isolated git worktrees, a realtime dashboard, shared evidence-anchored memory, installable skills, and one-file session handoff.

<a href="https://baton-landing.vercel.app"><img src="https://img.shields.io/badge/Read%20the%20docs-baton--landing.vercel.app-000000?style=for-the-badge&logo=vercel&logoColor=white" alt="Baton documentation website"></a>

### 🌐 [**baton-landing.vercel.app**](https://baton-landing.vercel.app)

[Docs](https://baton-landing.vercel.app/docs) · [Features](https://baton-landing.vercel.app/features) · [How it works](https://baton-landing.vercel.app/how-it-works) · [Use cases](https://baton-landing.vercel.app/use-cases) · [FAQ](https://baton-landing.vercel.app/faq) · [About](https://baton-landing.vercel.app/about)

<sub>In this repo: <a href="docs/quickstart.md">Quickstart</a> · <a href="docs/README.md">Documentation</a> · <a href="docs/cli-reference.md">CLI reference</a> · <a href="docs/architecture.md">Architecture</a></sub>

[![npm](https://img.shields.io/npm/v/batonhq?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/batonhq) [![CI](https://github.com/Rakshan001/Baton-Multi-Agent-/actions/workflows/ci.yml/badge.svg)](https://github.com/Rakshan001/Baton-Multi-Agent-/actions/workflows/ci.yml) ![license](https://img.shields.io/badge/license-AGPL--3.0-blue) ![node](https://img.shields.io/badge/node-%E2%89%A524-339933) ![deps](https://img.shields.io/badge/daemon-zero--dependency-8957e5) ![telemetry](https://img.shields.io/badge/telemetry-none-2F6B4F)

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

Requires **Node ≥ 24** and **git**. Run this in any repo:

```bash
npx batonhq setup
```

It scans the folder, then asks a handful of arrow-key questions — one repo or a hub over several, which agents you use, whether to turn on the knowledge graph. Each option carries a note explaining it, and Enter takes the recommendation. Then:

```bash
baton serve --write  # daemon + dashboard → http://localhost:7077
```

<details>
<summary>Installing it permanently, and the optional knowledge graph</summary>

```bash
npm install -g batonhq     # `baton` on your PATH (setup offers this at the end)
```

Those two — `npx` or a global install — are the ways that work. **Never
`npm i batonhq` inside a project**: Baton is a CLI, nothing imports it, and as a
dependency it makes every `npm install` in that project rebuild the whole tree,
native modules and all.

The knowledge graph needs one extra tool, the Python [`graphify`](https://pypi.org/project/graphifyy/) CLI:

```bash
uv tool install graphifyy  # or pipx install graphifyy
```

Setup offers to install it for you and **never blocks on it** — without it you lose the graph, and worktrees, tasks, edit signals, memory, handoff and the dashboard all still work. See [docs/installation.md](docs/installation.md).

The npm package is **`batonhq`**; the command is **`baton`**. (Unrelated packages named `baton`, `baton-cli` and `create-baton` belong to other projects.)

</details>

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
| 📡 | **Live edit signals** | A realtime dashboard (SSE) shows **who's editing what — and what they're doing** (each session's live intent note + freshness). Two sessions on one file → an **overlap warning before the conflict**. |
| 📌 | **Evidence-anchored memory** | [Shared facts](docs/memory.md) pinned to commits + file content hashes. When an anchored file changes, the fact is **withheld** — agents can't hallucinate from stale knowledge. Nothing is hard-deleted: removed facts go to a journaled archive (`baton memory log`). |
| 🧩 | **Installable skills** | A [catalog of reusable agent playbooks](docs/skills.md) — **one click (or `baton skills install <id>`) installs a skill into every agent at once**, each in its own format (`.claude/skills/…`, `.cursor/rules/…`). Ships a flagship `bug-fix` pipeline, a `lean-code` restraint skill (adapted from [Ponytail](https://github.com/DietrichGebert/ponytail), whose ladder measured **~54% less code and ~20% cheaper** on real agent sessions), and an efficiency & traceability pack. |
| 🐛 | **Bug recurrence** | `baton bugs "<symptom>"` — was this fixed before, and did a later change re-break it? Composes recorded fixes (memory) with commit history to name the **suspect commits**. Zero new storage. |
| 🔀 | **Agent routing** | [`baton route`](docs/agent-routing.md) picks the right agent per task from committed rules (deterministic, no LLM) — and [handoff](docs/session-handoff.md) prefers the **least-loaded** available agent. |
| 🧭 | **MCP tools** | [`baton mcp`](docs/mcp-tools.md) exposes coordination tools (`check_files`, `who_touched`, `recall_memory`, …) to every agent over MCP. |

## When you'd reach for it

Five situations Baton is built for. Each is one command.

**Your good agent is rate-limited, and you still have work to do.**
Plan on the agent that reasons well, execute on the one that's cheap or still has quota. The brief carries the objective, plan, checklist, touched files, git state and a cost estimate — not a transcript dump.
```bash
baton pass fix-checkout --to cursor     # → HANDOFF.md
baton take fix-checkout                 # on the other agent
```

**Two agents just edited the same file.**
Every task gets its own worktree and branch, so they physically cannot collide. Before an agent touches a shared file, it asks — and gets told who's in there and what they're doing.
```bash
baton new "refactor auth"               # isolated worktree + branch
baton signals                           # who is editing what, right now
```

**A session died mid-task** — context ran out, the window closed, you went home.
The next session picks up from a written brief instead of re-deriving everything.
```bash
baton resume fix-checkout
```

**An agent is new to the repo and starts grepping.**
It reads a queryable graph and a `CODEBASE.md` map instead — roughly 300× cheaper than reading the files it would otherwise open to orient.
```bash
baton kb init && baton orient
```

**One product, several repos** (api, web, mobile, infra).
Point setup at the folder holding them: one merged graph, one dashboard, tasks that name their sub-project.
```bash
npx batonhq setup                       # detects the repos, offers the hub
baton new "fix the checkout crash" --project api
```

**Bonus — "didn't we already fix this?"**
Composes recorded fixes with commit history to name the commits that likely re-broke it.
```bash
baton bugs "checkout 500s on empty cart"
```

## Your code stays on your machine

Baton is a local tool. It is worth being precise about this rather than asking you to take it on faith:

- **No telemetry, no analytics, no account.** There is no tracking code in the source — nothing to opt out of, because there is nothing to opt into.
- **Solo mode makes zero outbound requests.** The daemon binds `127.0.0.1` and is unreachable from outside your machine. Your code, graph, memory and tasks live in `.baton/` in your own repo.
- **No install scripts.** `npm i -g batonhq` runs no `postinstall`, so nothing executes on install. It works fine under `npm i --ignore-scripts`.
- **Team mode is opt-in and metadata-only.** Networking happens only after *you* run `baton host set <url>` to link machines. Even then, what crosses the wire is coordination metadata — task slug, agent name, which paths are being edited — **never file contents**. `baton serve --host` likewise binds a public interface only when you explicitly ask it to.
- **Two commands fetch a URL, and both are ones you typed.** `baton join <url>` reads a workspace manifest from a host you name, and `baton skills import <url>` downloads a skill you point it at. Neither runs on its own, and neither uploads anything.
- **Your agents still talk to their own vendors.** Claude Code, Cursor and the rest send your code to Anthropic, OpenAI and so on exactly as they always did. Baton neither adds to that nor can prevent it — it coordinates the agents, it does not sit between them and their APIs.

Everything above is checkable: the outbound calls are in [`src/host-link.ts`](src/host-link.ts), [`src/pipeline-claims.ts`](src/pipeline-claims.ts) and [`src/remote-claims.ts`](src/remote-claims.ts), all gated on a host link you configured. See [docs/security.md](docs/security.md).

## The dashboard

`baton serve` serves a realtime React dashboard at **http://localhost:7077** — a Command Center board, live Activity, Conflicts, the Knowledge Graph, Memory, History, an Agents roster (with one-click MCP wiring), and the Skills catalog. It binds to `127.0.0.1` only and is read-only until you pass `--write`. See [docs/dashboard.md](docs/dashboard.md).

## Do I need the daemon running?

**No — Baton is terminal-first.** You open your own terminals, run `claude` / `cursor` / `codex` yourself, and coordination happens through hooks + MCP tools + a local SQLite file. Start the dashboard only when you want to *look*:

| Works with **no daemon** | Needs `baton serve` |
|---|---|
| Edit signals — sessions warn each other before touching a busy file (the edit hook writes them) | The dashboard UI + realtime (SSE) live view |
| Shared memory, `recall`/`save`, orient briefs, `baton bugs`, reports, blame, handoff | Knowledge-graph *queries* over MCP (the daemon hosts one shared graphify backend per project) |
| Graph rebuilds (git post-commit hook, incremental) | Interactive agent terminals in the browser |
| The whole CLI: `status`, `signals`, `pass`/`take`, `merge`, `doctor` | Headless agent launch from the UI |

History, memory, and reports are plain files + git — so when you *do* open the dashboard later, the past is all there; only live *uncommitted-edit* activity from hook-less agents needs the daemon watching at the time.

## Documentation

> [!TIP]
> ### 🌐 Read the docs on the web → **[baton-landing.vercel.app/docs](https://baton-landing.vercel.app/docs)**
>
> Cross-linked and nicer to read than raw markdown — start with **[How it works](https://baton-landing.vercel.app/how-it-works)** for the handoff flow, **[Use cases](https://baton-landing.vercel.app/use-cases)** for real setups, or the **[FAQ](https://baton-landing.vercel.app/faq)**.
>
> **[Home](https://baton-landing.vercel.app)** · **[Docs](https://baton-landing.vercel.app/docs)** · **[Features](https://baton-landing.vercel.app/features)** · **[How it works](https://baton-landing.vercel.app/how-it-works)** · **[Use cases](https://baton-landing.vercel.app/use-cases)** · **[FAQ](https://baton-landing.vercel.app/faq)** · **[About](https://baton-landing.vercel.app/about)**

The same docs also live in this repo under [**`docs/`**](docs/README.md):

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

Baton is open source (AGPL-3.0) and contributions are welcome — the project is deliberately easy to hack on:

- **Orient first**: [STATUS.md](STATUS.md) is the living map — what's built, what's pending, and where every module lives. [docs/architecture.md](docs/architecture.md) explains the shape; [CLAUDE.md](CLAUDE.md) lists the conventions that must not break (zero-dependency daemon, SSE-only realtime, shell-free git).
- **How changes land**: every feature is TDD'd (the test exists and fails before the code), and non-negotiable behaviors are guarded by *invariant tests* — if a future edit drops a safety rule from a bundled skill, the suite fails loudly.
- **Good first contributions**: an agent adapter (add your CLI to `src/agents/registry.ts`), a bundled skill (`src/skills/bundled/<id>/SKILL.md` — the loader auto-discovers it), a language check against your stack, or a docs fix.

```bash
npm install && npm install --prefix web
npm run build && npx vitest run        # backend build + full test suite
npm run build --prefix web             # dashboard build
node dist/cli.js serve --write         # run it locally on :7077
npm run dev --prefix web               # UI dev server :5173 (demo data ON)
```

Open a PR against `main` with tests. If you're changing coordination behavior, run the suite a few times — flaky is treated as broken here.

## License

**AGPL-3.0-or-later** © Rakshan Shetty. See [LICENSE](LICENSE).

Use it, change it, run it commercially — all fine. The one condition: if you
distribute Baton or **run a modified version as a network service**, the people
using it get the source under the same terms. That second clause is the reason
this is AGPL and not GPL — Baton is a daemon with a web dashboard, so hosting it
without ever shipping a binary would otherwise be a way around the license.

Baton was MIT until 2026-08-07. Copies taken before then keep their MIT
grant — relicensing does not reach backwards. Contributions are accepted under
the terms in [CONTRIBUTING.md](CONTRIBUTING.md).

<div align="center"><sub><b>Pass it on.</b></sub></div>
