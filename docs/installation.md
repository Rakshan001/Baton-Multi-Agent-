# Installation

How to get Baton running on a fresh machine. For a guided first run afterwards, see the [Quickstart](./quickstart.md).

## Prerequisites

| Tool | Why | Check |
|---|---|---|
| **Node.js ≥ 22.13** | The CLI + daemon (uses built-in `node:sqlite` and recursive `fs.watch`). 22.13 is the first release where `node:sqlite` needs no `--experimental-sqlite` flag. | `node --version` |
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

Baton talks to six agent CLIs. Install whichever you use; Baton detects them on your `PATH`.

| Agent | Binary | Headless | Interactive |
|---|---|---|---|
| Claude Code | `claude` | ✅ | ✅ |
| Codex CLI | `codex` | ✅ | ✅ |
| Gemini CLI | `gemini` | ✅ | ✅ |
| Cursor Agent | `cursor-agent` | — | ✅ |
| Aider | `aider` | — | ✅ |
| OpenCode | `opencode` | — | ✅ |

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
