# MCP tools for agents

Baton speaks [Model Context Protocol](https://modelcontextprotocol.io). It exposes two MCP servers your agents can call directly: a **coordination server** (`baton mcp`) that answers "who is editing what, what shipped, what do we already know," and a separate **graphify server** that answers "where does this symbol live in the codebase." This page lists every tool and shows how to wire each agent.

## The two servers

| Server | Started by | Tools | Answers |
|--------|-----------|-------|---------|
| `baton` (coordination) | `baton mcp` | `check_files`, `list_signals`, `get_report`, `who_touched`, `list_tasks`, `save_memory`, `recall_memory` | Live edit signals, completion reports, agent-blame, sessions, shared memory |
| `graphify-*` (code graph) | shared daemon pool (http proxy) | `query_graph`, `get_node` | Code navigation across the knowledge graph |

The coordination server is plain stdio and zero-config: it reads Baton's state from the current git repo. The graphify servers are shared: the daemon runs a single lazily-started pool of graphify backends and proxies agent requests through `POST /mcp/g/<token>/<projectId>`. The token is stored in `.baton/mcp-token` and embedded in the generated config so only holders of that file can reach the graph. Graphify servers are wired one per sub-project plus a merged cross-project graph (see [knowledge-graph.md](./knowledge-graph.md)).

## Coordination tools (`baton mcp`)

Source: [`src/mcp.ts`](../src/mcp.ts). Every tool returns JSON as text.

### `check_files`

Check whether the given files are currently being edited by another Baton session (live edit signals plus unmerged branch changes).

- **Input:** `paths` — array of repo-relative file paths.
- **When to call:** **before** editing shared files. If a path is busy, prefer waiting or picking other work, then re-check.

### `list_signals`

List every file under live edit across all Baton sessions right now.

- **Input:** none.
- **When to call:** to get a global picture of in-flight work. A result with `level="warning"` means 2 or more sessions are editing the same path.

### `get_report`

Get the completion report of a merged task — summary, files changed, commits.

- **Input:** `slug` (optional) — a task slug; omit to list recent reports.
- **When to call:** after waiting on busy files, to decide whether your issue is **already fixed** by a task that just merged.

### `who_touched`

Agent-blame for a single file: which task / agent / commits touched it (merged history) and who is editing it live right now.

- **Input:** `file` — a repo-relative file path.
- **When to call:** when you need provenance for a file before changing it or to find the right person/session to coordinate with.

### `list_tasks`

List all Baton sessions (worktrees) with status, attached agent, and ahead/behind counts.

- **Input:** none.
- **When to call:** to orient yourself on what work exists across the repo.

### `save_memory`

Persist a fact you **learned** while working (a decision made, a gotcha hit, a convention discovered) so future agent sessions skip re-discovering it.

- **Input:**
  - `fact` — 1–3 sentences: the fact, why it matters, how to apply it.
  - `type` (optional) — one of `decision`, `gotcha`, `convention`, `reference`, `preference`.
  - `files` (optional) — repo-relative files the fact is about (max 8). These become **evidence anchors**: if those files later change, the fact is automatically flagged stale instead of being served as truth.
  - `agent` (optional) — your agent name, e.g. `"claude"`.
  - `task` (optional) — the task slug you are working on.
- **When to call:** at the end of meaningful work. Do **not** store anything derivable from the code itself, task-only context, or secrets — secrets are rejected.

### `recall_memory`

Recall project memory — facts earlier agent sessions learned, evidence-checked against the current code. Stale facts (whose anchored files changed since) are withheld and only counted, so everything returned is safe to trust.

- **Input:**
  - `topic` (optional) — what you are working on; ranks facts by relevance. Omit for the most recent facts.
  - `limit` (optional) — max facts to return (default 10, max 50).
- **When to call:** **before** exploring the repo, so you start from what's already known.

See [memory.md](./memory.md) for how the evidence-anchored memory store works.

## Code-graph tools (graphify server)

The graphify MCP server is graphify's own process, run via `uv` (`uv run --with graphifyy --with mcp -m graphify.serve <graph.json>`). Baton wires one server per project (`graphify-<id>`) and a `graphify-merged` server for the cross-project graph.

| Tool | Purpose |
|------|---------|
| `query_graph` | Search the code knowledge graph for symbols, files, and relationships. |
| `get_node` | Fetch a single node (a function, class, file, …) and its edges. |

Reading the repo map via these tools costs roughly 824 tokens versus ~248k to read the files directly — about 300x cheaper. Build the graph with `baton kb init`; it auto-rebuilds via a git hook on commit. See [knowledge-base.md](./knowledge-graph.md).

## Wiring per agent

Baton writes the MCP config for you. Wiring source: [`src/agents/connect.ts`](../src/agents/connect.ts).

| Agent | Config file | Scope | Format |
|-------|-------------|-------|--------|
| `claude` | `<repo>/.mcp.json` | project | JSON |
| `cursor` | `<repo>/.cursor/mcp.json` | project | JSON |
| `gemini` | `~/.gemini/settings.json` | global | JSON |
| `codex` | `~/.codex/config.toml` | global | TOML |
| `aider`, `opencode` | — | — | no standard MCP config (unsupported) |

Writes are **non-destructive**: JSON files keep every existing key and merge Baton's servers into `mcpServers`; the TOML file only gets server blocks it lacks. If a config file exists but isn't valid JSON, Baton refuses to overwrite it.

### Generate or write the config from the CLI

```bash
# Print the snippet for an agent (does not write):
baton kb mcp --agent claude
baton kb mcp --agent cursor
baton kb mcp --agent gemini
baton kb mcp --agent codex
```

`baton kb init` and `baton setup` can wire MCP automatically (pass `--no-mcp` to skip). Because **global** config files live outside the repo (`gemini`, `codex`), Baton only writes them after an explicit confirmation; project files (`claude`, `cursor`) are safe to write automatically.

### What gets written

For an agent with a knowledge base, the config contains one graphify server per project, a merged graph server, and the coordination server. Claude, Cursor, and Gemini get http-based graphify entries that route through the shared daemon proxy; the JSON shape used by `claude` and `cursor`:

```json
{
  "mcpServers": {
    "graphify-myrepo": {
      "type": "http",
      "url": "http://127.0.0.1:7077/mcp/g/<token>/myrepo"
    },
    "graphify-merged": {
      "type": "http",
      "url": "http://127.0.0.1:7077/mcp/g/<token>/merged"
    },
    "baton": {
      "command": "baton",
      "args": ["mcp"]
    }
  }
}
```

Without a knowledge base, only the coordination server is wired:

```json
{
  "mcpServers": {
    "baton": { "command": "baton", "args": ["mcp"] }
  }
}
```

**Codex note:** Codex's TOML MCP format only supports `command` + `args` keys — url-based servers are not part of its config spec. Baton therefore keeps Codex on the per-session `uv` stdio spawn instead of the shared proxy. All other agents (Claude, Cursor, Gemini) use the http route. The Codex TOML form uses one `[mcp_servers."<name>"]` block per server with `command` and `args`.

### From the dashboard

The **Agents** screen shows a roster of the six supported agents and, for each, whether the `baton` coordination server is already wired in its config file. Use the connect action to write the config. For global targets (`gemini`, `codex`) the dashboard shows a **preview** of the full proposed file and requires you to confirm before anything outside the repo is written. The connect action is a mutating endpoint (`POST /api/agents/:id/connect`), so it needs `baton serve --write`.

## Related

- [Knowledge base (graphify)](./knowledge-graph.md) — building the code graph the `query_graph` / `get_node` tools serve.
- [Project memory](./memory.md) — how `save_memory` / `recall_memory` stay anti-hallucination.
- [Project overview](../README.md) — what Baton is and how the pieces fit together.
