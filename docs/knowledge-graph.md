# Knowledge base (graphify)

Baton's knowledge base builds a **code graph per sub-project plus a merged
cross-project graph**, generates a token-cheap `CODEBASE.md` map for each
project, and exposes both over MCP so your agents navigate the codebase instead
of re-scanning it. It is driven by the `baton kb` command group and the external
[`graphify`](https://pypi.org/project/graphifyy/) CLI.

## What it is

When you run `baton kb init`, Baton:

- Auto-detects the sub-projects inside a repo (or a folder of repos).
- Builds one graphify graph (`graphify-out/graph.json`) per project, and a
  **merged** graph (`.baton/kb/merged-graph.json`) when there is more than one.
- Writes a `CODEBASE.md` structure map per project (and a root index when
  multi-project).
- Installs a git hook so graphs auto-update on commit.
- Wires `graphify-*` and `baton` MCP servers into `.mcp.json` so agents can query
  the graph natively.

State is persisted at `<repo>/.baton/kb.json` (gitignored, like `tasks.json`).
Source: [`src/commands/kb.ts`](../src/commands/kb.ts),
[`src/kb/graphify.ts`](../src/kb/graphify.ts),
[`src/kb/state.ts`](../src/kb/state.ts).

## Install graphify

The graph engine is the external PyPI package `graphifyy` (it provides the
`graphify` binary). Install it with whichever tool you have:

```bash
uv tool install graphifyy      # recommended
pipx install graphifyy         # alternative
pip install graphifyy          # fallback
```

If graphify is missing, `baton kb init` stops and prints the install hint for
your environment rather than failing mid-pipeline.

> **LLM key is optional.** With an LLM API key configured (`ANTHROPIC_API_KEY`,
> `OPENAI_API_KEY`, `GEMINI_API_KEY`, etc.), Baton uses `graphify extract` for
> semantic enrichment. Without one it falls back to `graphify update` —
> AST-only, fast, and free.

## Commands

| Command | What it does |
|---|---|
| `baton kb init [path]` | Detect projects, build graphs, write `CODEBASE.md`, install the git hook, wire `.mcp.json`. |
| `baton kb status` | Show projects, node/edge/community counts, last build, and `CODEBASE.md` freshness. |
| `baton kb rebuild [project] [--full]` | Rebuild graphs — incremental by default, `--full` re-extracts. |
| `baton kb export [--out <file>]` | Export the KB as a shareable `.tar.gz` pack. |
| `baton kb import <source> [--no-rebuild]` | Adopt an exported pack or a committed `kb/` dir, re-anchored to this repo. |
| `baton kb share [on\|off]` | Toggle committing a `kb/` directory so teammates skip re-indexing. |
| `baton kb mcp [--agent <a>]` | Print MCP config for `claude` (default), `cursor`, `codex`, or `gemini`. |

### init

```bash
baton kb init                  # index the repo root, sub-projects auto-detected
baton kb init ./services       # index a specific folder
```

| Flag | Effect |
|---|---|
| `--no-mcp` | Skip writing graphify MCP servers to `.mcp.json`. |
| `--no-docs` | Skip adding the coordination guide to `AGENTS.md`/`CLAUDE.md`. |
| `--share` | Commit the KB to git (`kb/` directory) so teammates skip re-indexing. |
| `--local` | Keep the KB local-only (skip the interactive share question). |
| `--port <port>` | Daemon port to embed in the generated MCP config URLs (default 7077). Use this when `baton serve` runs on a non-default port. |

Example output:

```text
graphify 0.4.1 ✓
detected 2 projects:
  • api  (/repo/api)
  • web  (/repo/web)
→ extracting api ...
→ extracting web ...
→ merging project graphs ...
✓ git hooks installed (graph auto-updates on commit)
✓ CODEBASE.md ×2 (token-cheap structure maps)
✓ knowledge base ready (.baton/kb.json)
✓ wrote graphify + baton MCP servers to .mcp.json
```

### status

```bash
baton kb status
```

```text
knowledge base @ /repo  (built 2026-06-19T10:22:01.000Z)
  api                       1240 nodes    3180 edges   18 communities
  web                        980 nodes    2410 edges   14 communities
  merged                    2220 nodes    5590 edges
```

Each project line also flags `[building]` while a graph is being built and a
`CODEBASE.md` note (`stale`/`missing`) when the map is out of date.

### rebuild

```bash
baton kb rebuild               # incremental update of every project (no LLM needed)
baton kb rebuild api           # one project by id
baton kb rebuild --full        # full re-extract instead of incremental update
```

Incremental rebuilds use `graphify update` (pure local AST). `--full` runs the
LLM-enriched `graphify extract` when a key is present, otherwise a full AST
re-extract. After rebuilding, the merged graph and every `CODEBASE.md` are
refreshed automatically.

### export / import / share

```bash
# producer
baton kb export                          # → baton-kb-<repo>-<sha>.tar.gz
baton kb share on                        # commit a kb/ dir into the repo instead

# consumer
baton kb import baton-kb-myrepo-a1b2c3d.tar.gz
baton kb import kb/                       # adopt a teammate's committed KB
```

On import, Baton re-anchors the KB to your repo and checks how far behind your
`HEAD` it is. If the pack is behind, it runs an incremental refresh
automatically (pass `--no-rebuild` to skip). `kb share` mirrors the shareable
artifacts into a committed `kb/` directory so teammates clone the graph instead
of re-indexing from scratch.

## Share the project with any chatbot (context pack)

Hit a usage limit on your coding agent and want to continue in ChatGPT, Grok,
or DeepSeek? `baton kb context` renders everything Baton knows about the
project into one paste-able markdown brief — overview, stack, annotated folder
tree, the graph's most-connected symbols, and fresh (evidence-checked) memory
facts. No file contents are included, secret-looking strings are redacted, and
the output is capped at a token budget (default 8k, ChatGPT-free-tier sized —
the footer says which chatbots it fits).

In the dashboard: **Knowledge Graph → Share context** → Copy to clipboard or
Download `.md`. Over HTTP: `GET /api/kb/context?project=<id|all>&format=json`
(read-only). The pack works even before `baton kb init` — it just degrades to
README + structure until a graph exists.

## The CODEBASE.md map and token savings

Every project gets a deterministic `CODEBASE.md` (< ~2k tokens): detected stack,
key scripts, an annotated folder tree, and the most-connected symbols ranked
from the graph. Agents read this **first** to orient themselves instead of
scanning the whole repo.

Baton records the trade-off in `kb.json` per project: `mapTokens` (cost to read
the map) vs `repoTokens` (cost to read all the files). In practice the map runs
roughly **~300× cheaper** — about 824 tokens to read the repo map versus ~248k
tokens to read the files.

```markdown
# CODEBASE — api

> Auto-generated by `baton kb` — the token-cheap map of this project.

**Stack:** node · express

## Structure
...
## Key symbols (most connected in the code graph)
- `Server` — src/server.ts:42 (31 connections)
...
## Query more
- Graph search: MCP tool `query_graph` on server `graphify-api`
```

Source: [`src/kb/codebasemd.ts`](../src/kb/codebasemd.ts).

## Querying the graph over MCP

`baton kb init` writes graphify's MCP servers into `.mcp.json` (one
`graphify-<project>` per project, plus `graphify-merged`), alongside the `baton`
coordination server.

**The daemon must be running.** Graph queries route through the daemon's shared
graphify pool (`POST /mcp/g/<token>/<projectId>`). Backends are lazily started
on first use and reaped after 15 minutes idle, so you pay no cost for projects
you don't touch. If `baton serve` is not running, `query_graph` / `get_node`
calls from agents will fail to connect.

| MCP tool | Use |
|---|---|
| `query_graph` | Natural-language / BFS search over the code graph for relevant symbols. |
| `get_node` | Fetch a single node's details by id. |

Print config for any agent:

```bash
baton kb mcp --agent claude    # → .mcp.json (repo root)
baton kb mcp --agent cursor    # → .cursor/mcp.json
baton kb mcp --agent codex     # → ~/.codex/config.toml (stdio; stays local)
baton kb mcp --agent gemini    # → ~/.gemini/settings.json
```

You can also query from the shell without the daemon:

```bash
graphify query "where is auth handled" --graph graphify-out/graph.json
```

The `baton` MCP server (separate, run by `baton mcp`) provides the coordination
tools — `check_files`, `list_signals`, `get_report`, `who_touched`,
`list_tasks`, `save_memory`, `recall_memory`. Source:
[`src/kb/mcp.ts`](../src/kb/mcp.ts), [`src/mcp.ts`](../src/mcp.ts).

## Auto-rebuild on commit

`baton kb init` installs graphify's post-commit / post-checkout hooks. Because
all of a repo's worktrees share `.git/hooks`, every task worktree gets the same
auto-rebuild: when you commit, the affected graph updates and the matching
`CODEBASE.md` is regenerated. If hook installation fails, run
`graphify hook install` manually from the repo root.

Graph changes are picked up automatically by agents: graphify's `--stateless`
backend re-reads the graph file on each request, so a rebuild is reflected in the
next query with no daemon restart needed.

> **Note:** If you run `baton kb init` while the daemon is already running,
> restart the daemon so it picks up the newly wired project paths. The graphify
> pool captures KB state at daemon start time; projects added after startup won't
> be served until you restart.

## Dashboard

Start the daemon and open the **Knowledge Graph** page:

```bash
baton serve            # http://localhost:7077
```

The page renders a force-directed view of the merged graph, with project node/
edge/community counts served from `/api/kb` and the graph data from
`/api/kb/graph`. `/api/kb/mcp` returns the per-agent MCP config shown above.
Rebuilds can be triggered from the daemon when it is started with `--write`
(`POST /api/kb/rebuild`).

## Related

- [../README.md](../README.md) — Baton overview and quick start.
- [01-coordination-and-locking.md](./01-coordination-and-locking.md) — how
  multiple agents coordinate on one repo.
- [02-handoff-market.md](./02-handoff-market.md) — the handoff thesis behind
  passing the baton between agents.
