# Configuration & files

Where Baton keeps its state, which files you commit, and the few knobs you can
tune. Baton is local-first: almost everything lives under `.baton/` in your main
repo and is gitignored. The two things you *do* commit are an optional routing
config and (optionally) a shared knowledge base.

## The `.baton/` directory

Everything Baton writes at runtime lives under `<repo>/.baton/` in your **main**
repo (not inside a worktree). This whole directory is gitignored — it is local
machine state, safe to delete and regenerate.

| Path | What it is | Source |
| --- | --- | --- |
| `.baton/wt/<slug>/` | Per-task git worktrees created by `baton new` | [src/commands/new.ts](../src/commands/new.ts) |
| `.baton/tasks.json` | The task registry (slug, branch, worktree path, base commit) | [src/store.ts](../src/store.ts) |
| `.baton/kb.json` | Knowledge-base state: sub-projects, graph paths, merged graph, share flag | [src/kb/state.ts](../src/kb/state.ts) |
| `.baton/kb/merged-graph.json` | Cross-project merged graph (only when more than one project) | [src/kb/state.ts](../src/kb/state.ts) |
| `.baton/memory/facts/` | One markdown file per evidence-anchored memory fact | [src/memory.ts](../src/memory.ts) |
| `.baton/memory/retention.json` | Persisted memory retention policy | [src/memory.ts](../src/memory.ts) |
| `.baton/reports/<slug>.md` | One report per merged task (human/agent readable mirror) | [src/reports.ts](../src/reports.ts) |
| `.baton/history.db` | Append-only SQLite index of which task/agent/commits touched each file | [src/history.ts](../src/history.ts) |
| `.baton/tmp/` | Scratch space for uploads (e.g. kb imports); reclaimed by `baton clean` | [src/server.ts](../src/server.ts), [src/cleanup.ts](../src/cleanup.ts) |

### tasks.json

Each entry is one task scaffolded by `baton new`:

```json
[
  {
    "slug": "fix-login-redirect",
    "task": "Fix login redirect loop",
    "branch": "baton/fix-login-redirect",
    "worktreePath": "/path/to/repo/.baton/wt/fix-login-redirect",
    "baseBranch": "main",
    "baseCommit": "a1b2c3d",
    "createdAt": "2026-06-19T10:00:00.000Z"
  }
]
```

Writes are atomic (temp file + rename) and serialized per process, so two
concurrent `POST /api/tasks` calls can't clobber each other. A missing, empty,
or corrupt file is treated as an empty list — Baton starts fresh.

### Memory facts

Memory always lives at `.baton/memory/facts/` in the **main repo**, even when an
agent is working from a worktree. Each fact is a markdown file storing the commit
and content-hashes of the files it describes. When those anchors change, the fact
is marked STALE on read and withheld from agents. See
[memory.md](./memory.md).

### Storage buckets

The dashboard's Storage view (and `GET /api/storage`) breaks `.baton/` into the
buckets that actually grow: `memory`, `history`, `reports`, and `graphs`. Only
`history.db` is unbounded; memory is hard-capped. See
[src/storage.ts](../src/storage.ts).

## Committed config: `baton.config.json`

The one config file you create and **commit** to share with your team. It lives
at the repo root and configures task → agent/model routing for `baton route`,
`baton pass`, and the dashboard. It is pure keyword + severity scoring — no LLM
call, deterministic and explainable. Baton works fine without it (built-in
defaults are used). See [src/routing.ts](../src/routing.ts) and
[routing.md](./agent-routing.md).

```json
{
  "routing": {
    "mode": "auto",
    "rules": [
      { "match": ["plan", "architecture", "research"], "agent": "claude", "model": "opus" },
      { "match": ["ui", "frontend", "css", "component"], "agent": "gemini" },
      { "match": ["bug", "fix", "crash", "regression"], "agent": "codex" }
    ],
    "default": "cursor",
    "tiers": {
      "heavy":    [{ "agent": "claude", "model": "opus" }],
      "standard": [{ "agent": "cursor" }, { "agent": "claude", "model": "sonnet" }],
      "light":    [{ "agent": "codex" }, { "agent": "gemini" }],
      "local":    [{ "agent": "aider", "model": "ollama/qwen2.5-coder" }, { "agent": "opencode" }]
    }
  }
}
```

| Key | Meaning |
| --- | --- |
| `routing.mode` | `auto` (rules then severity), `manual` (advisory only), or `single` |
| `routing.rules[].match` | Keywords matched against the task text |
| `routing.rules[].agent` / `.model` | Direct target for a matched rule |
| `routing.rules[].tier` | Route a matched rule into a tier chain instead of a fixed agent |
| `routing.default` | Tier name or agent id used when nothing matches |
| `routing.tiers` | Named ordered fallback chains; the first **installed** agent wins |
| `routing.single` | Target agent/model when `mode` is `single` |

Invalid config never throws — Baton falls back to built-in defaults and surfaces
the errors.

## Generated files

These are produced by `baton kb` and the graphify tooling. The machine-specific
ones are gitignored and regenerate on `baton kb init` / `baton kb rebuild`.

| File | Purpose | Committed? |
| --- | --- | --- |
| `.mcp.json` | Per-machine MCP config so agents can `query_graph` the code graph (absolute paths) | No — gitignored |
| `graphify-out/` | Generated code graph per sub-project | No — gitignored |
| `CODEBASE.md` | A < 2k-token repo map per project (root index for multi-project) | Yes (it's a doc) |
| `AGENTS.md` | Agent-facing project context | Yes (it's a doc) |

`.mcp.json` and `graphify-out/` hold absolute paths or large generated data, so
they're gitignored and rebuilt locally. `CODEBASE.md` is the cheap map that
agents read instead of the whole tree (~824 tokens vs ~248k — roughly 300x
cheaper).

## The shared `kb/` directory

When KB share mode is on, `baton kb rebuild` mirrors the shareable artifacts
(graphs + `CODEBASE.md` files) into a committed `kb/` directory at the repo root.
Commit it so teammates and agents get the code graph **without re-indexing**.
After cloning a repo that has `kb/`:

```bash
baton kb import kb/     # adopt the shared graphs locally
baton kb rebuild        # refresh to your current HEAD (incremental)
```

`kb/` is regenerated by `baton kb rebuild` while share mode is on — do not edit
it by hand. See [src/kb/transfer.ts](../src/kb/transfer.ts).

## Environment variables

Baton itself needs no API keys for AST-based indexing or coordination. Keys
matter only for graphify's **semantic** extraction: if a backend key is set,
graphify enriches the graph with an LLM; otherwise it does pure AST extraction
(fast, free).

| Variable | Used for |
| --- | --- |
| `ANTHROPIC_API_KEY` | graphify semantic extraction backend |
| `OPENAI_API_KEY` | graphify semantic extraction backend |
| `GEMINI_API_KEY` | graphify semantic extraction backend |
| `MOONSHOT_API_KEY` | graphify semantic extraction backend |
| `DEEPSEEK_API_KEY` | graphify semantic extraction backend |
| `OLLAMA_BASE_URL` | Local LLM backend for graphify |

With none of these set, `baton kb init` reports `AST-only extraction (fast,
free)`. See [src/kb/graphify.ts](../src/kb/graphify.ts). Note: these keys are
read by the agent CLIs and graphify, not by the Baton daemon. Put them in your
shell environment, not in `baton.config.json`. The repo's `.gitignore` ignores
`.env` and `.env.*` (keeping `.env.example`) so secrets stay out of git.

## What is committed vs gitignored

From the repo [.gitignore](../.gitignore):

| Path | Status | Why |
| --- | --- | --- |
| `.baton/` | gitignored | Local runtime state (tasks, memory, history, worktrees) |
| `graphify-out/` | gitignored | Generated graphs — rebuild with `baton kb init` |
| `.mcp.json` | gitignored | Machine-specific absolute paths — regenerate with `baton kb init` |
| `.env`, `.env.*` | gitignored | Secrets (except `.env.example`) |
| `baton.config.json` | **commit** | Team-shared routing config |
| `kb/` | **commit** | Shared knowledge base so teammates skip re-indexing |
| `CODEBASE.md`, `AGENTS.md` | **commit** | Generated docs agents read |

## Next steps

- [routing.md](./agent-routing.md) — how `baton.config.json` rules and tiers resolve.
- [knowledge-base.md](./knowledge-graph.md) — graphify, `CODEBASE.md`, and the `kb/` share dir.
- [memory.md](./memory.md) — evidence-anchored facts under `.baton/memory/facts/`.
- [../README.md](../README.md) — project overview and quickstart.
