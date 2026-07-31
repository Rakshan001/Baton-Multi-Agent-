# Installation

How to get Baton running on a fresh machine. For a guided first run afterwards, see the [Quickstart](./quickstart.md).

## Prerequisites

| Tool | Why | Check |
|---|---|---|
| **Node.js ≥ 24** | The CLI + daemon (uses built-in `node:sqlite` and recursive `fs.watch`). Node 24 is the first release whose bundled SQLite carries **FTS5**, which memory recall ranks with; older runtimes either lack `node:sqlite` entirely or silently fall back to a weaker scorer. | `node --version` |
| **git** | Worktrees, branches, history — the whole model is git-native. | `git --version` |
| **uv** (or pipx/pip) | Installs the [`graphify`](https://pypi.org/project/graphifyy/) CLI for the knowledge graph. | `uv --version` |
| **tmux** *(optional)* | Interactive agent terminals in the dashboard. Without it, headless runs still work. | `tmux -V` |

Install `uv` from <https://docs.astral.sh/uv/>, or use `pipx` / `pip` instead (see below).

## Install

```bash
git clone https://github.com/Rakshan001/Baton-Multi-Agent-.git baton
cd baton

npm install                  # CLI + daemon deps
npm install --prefix web     # dashboard deps

npm run build                # tsc → dist/
npm run build --prefix web   # vite → web/dist/ (served by `baton serve`)

uv tool install graphifyy    # the `graphify` CLI (knowledge graphs)

npm link                     # optional: puts `baton` on your PATH
                             # (otherwise run `node dist/cli.js …`)
```

> If you skip `npm link`, replace every `baton …` in the docs with `node dist/cli.js …`.

### Installing graphify without uv

```bash
pipx install graphifyy       # or
pip install graphifyy
```

Baton detects whichever of `uv` / `pipx` is available and prints tailored guidance if `graphify` is missing.

## Wire up your agents

Baton ships knowing these agent CLIs. Install whichever you use; Baton detects them on your `PATH`.

| Agent | Binary | Headless | Interactive |
|---|---|---|---|
| Claude Code | `claude` | ✅ | ✅ |
| Codex CLI | `codex` | ✅ | ✅ |
| Gemini CLI | `gemini` | ✅ | ✅ |
| Cursor Agent | `cursor-agent` | — | ✅ |
| Aider | `aider` | — | ✅ |
| OpenCode | `opencode` | — | ✅ |
| OpenClaw | `openclaw` | — | — (detection-only) |

*Detection-only* means the agent shows up in the roster and process view, but
Baton won't launch it for you yet — launch flags are only added once they've
been verified against a real install.

### Add your own agent (no Baton release needed)

Any agent CLI not in the table can be taught to Baton with
`~/.baton/agents.json`. Entries are validated on load and `baton doctor`
reports anything that didn't:

```json
{
  "agents": [
    {
      "id": "myagent",
      "label": "My Agent",
      "binary": "myagent",
      "headless":    { "args": ["run", "--model={model}", "-p", "{prompt}"] },
      "interactive": { "args": ["--model={model}"] }
    }
  ]
}
```

- `id` — lowercase letters/digits/dashes; a collision with a built-in is
  refused (a config file must not redefine how `claude` runs).
- `binary` — probed on `PATH`, and matched in the process table for detection
  (add a `detect` regex string only if the default binary-name match is wrong).
- Launcher `args` are an **argv template**, never a shell string: `{prompt}`
  substitutes the prompt, and any token containing `{model}` is dropped when no
  model override was asked for — write `--model={model}` as one token so
  nothing dangles. A token must not mix `{model}` and `{prompt}` (the drop
  would silently discard the prompt too — the launcher is refused). Omit
  `headless`/`interactive` for detection-only.

Give each agent the Baton + graphify MCP tools:

```bash
baton kb init                 # writes .mcp.json (Claude Code picks it up per worktree)
baton kb mcp --agent cursor   # print config for .cursor/mcp.json
baton kb mcp --agent codex    # → ~/.codex/config.toml
baton kb mcp --agent gemini   # → ~/.gemini/settings.json
baton hooks install claude    # auto-handoff brief on Claude session end (Stop/PreCompact)
```

You can also wire MCP per agent from the dashboard's **Agents** screen. See [MCP tools](./mcp-tools.md).

## Verify

```bash
baton kb status     # shows indexed projects + node/edge counts
baton serve --write # → http://localhost:7077 (real data, demo off)
```

Open <http://localhost:7077>. If you see "dashboard not built", run `npm run build --prefix web` and restart.

## Updating

```bash
git pull
npm install && npm install --prefix web
npm run build && npm run build --prefix web   # restart `baton serve` afterwards
```

## Next steps

- [Quickstart](./quickstart.md) — your first session and handoff.
- [CLI reference](./cli-reference.md) — every command.
- [Troubleshooting & FAQ](./troubleshooting.md) — if something didn't work.
