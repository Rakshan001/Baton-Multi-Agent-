# Installation

How to get Baton running on a fresh machine. For a guided first run afterwards, see the [Quickstart](./quickstart.md).

## Prerequisites

| Tool | Required? | Why | Check |
|---|---|---|---|
| **Node.js ≥ 24** | **yes** | The CLI + daemon (uses built-in `node:sqlite` and recursive `fs.watch`). Node 24 is the first release whose bundled SQLite carries **FTS5**, which memory recall ranks with; older runtimes either lack `node:sqlite` entirely or silently fall back to a weaker scorer. Baton refuses to start below 24 rather than degrading quietly. | `node --version` |
| **git** | **yes** | Worktrees, branches, history — the whole model is git-native. | `git --version` |
| **uv** (or pipx) | optional | Installs the [`graphify`](https://pypi.org/project/graphifyy/) CLI for the knowledge graph. Without it you lose the graph and nothing else. | `uv --version` |
| **tmux** | optional | Interactive agent terminals in the dashboard. Without it, headless runs still work. | `tmux -V` |

## Install

One command, in any repo:

```bash
npx batonhq setup
```

The wizard scans the folder first and shows what it found, then asks:

1. **one repo, or a hub over several?** — detected automatically; a folder holding 2+ git repos can become one centralized hub (merged graph, one dashboard) or be set up individually
2. **which agents do you use?** — recommends the ones already on your `PATH`
3. **turn on the knowledge graph?** — offers to run `uv tool install graphifyy`
4. **install the bundled skills?**
5. **install `baton` globally?** — only when you came in via `npx`

Every question has a recommended answer; pressing Enter takes it.

There is deliberately no "dashboard or headless" question. The dashboard is a
viewer, not a mode: the knowledge graph, the KB, the MCP servers, the git hooks,
the skills and the agent wiring are set up either way, and `baton serve` is
there whenever you want to watch. Nothing is gated behind running it.

> **Do not `npm i batonhq` inside your project.** Baton is a command-line tool;
> no code in your project imports it. Adding it as a dependency makes every
> `npm install` there rebuild it and everything alongside it — native modules
> included — and when one of those rebuilds fails, the backtrace names Baton and
> looks like Baton's fault. Use `npx batonhq <command>`, or install it globally.

### Installing it permanently

```bash
npm install -g batonhq   # the package is `batonhq`; the command is `baton`
```

The npm name differs from the command because `baton`, `baton-cli` and
`create-baton` are all taken on npm by unrelated projects.

### Unattended installs

```bash
baton setup --yes --agents claude,codex
```

`--yes` accepts every default that touches **your project**, and installs no
software — no `uv tool install`, no `npm i -g`. That rule exists because `--yes`
is what CI, Dockerfiles and provisioning scripts run, which is exactly where a
surprise network install is least welcome. Anything it skips is printed as a
command you can run yourself.

With no TTY (a pipe, CI, `nohup`) every prompt takes its default rather than
waiting on stdin, so setup never hangs.

### The knowledge graph, later

Setup never blocks on `graphify`. If you skip it, the knowledge base is skipped
too and Baton says so — worktrees, tasks, edit signals, memory, handoff and the
dashboard all work without it. When you want the graph:

```bash
uv tool install graphifyy    # or: pipx install graphifyy
baton kb init                # finish the part that was skipped
```

Baton detects whichever of `uv` / `pipx` is available and prints tailored
guidance. It will not install through bare `pip`, which would land the package
in whichever Python happens to lead your `PATH`.

### Building from source

For hacking on Baton itself, see [CONTRIBUTING.md](../CONTRIBUTING.md). In short:

```bash
git clone https://github.com/Rakshan001/Baton-Multi-Agent-.git baton && cd baton
npm install && npm install --prefix web
npm run build && npm run build:web
npm link                     # otherwise run `node dist/cli.js …`
```

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
`~/.baton/agents.json` — or, for an agent only one repo's team uses, with
`.baton/agents.json` inside that project (commit it and the whole team gets
it — Baton's managed `.gitignore` block leaves exactly this file unignored;
on a repo initialized by an older Baton, re-run `baton kb init` once or
`git add -f` it). Both use the same format. Layering is additive and earlier-wins:
built-ins, then `~/.baton`, then the project file — a config file adds
agents, it never redefines one. The machine-global file loads at startup;
the project file reloads on every use, so edits need no daemon restart.
Entries are validated on load and `baton doctor` reports anything that
didn't:

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
  **In a project file this must be an installed command name — never a path.**
  `~/.baton/agents.json` is written by you, so `/opt/tools/mycli` is fine
  there; a project file arrives with the code (a clone, a PR branch, a pull
  you didn't read), and Baton probes every known binary with `<bin> --version`
  on a poll. A repo-relative `./scripts/x` would therefore run a file the repo
  itself ships, with no click anywhere — so project entries naming a path are
  refused and reported in `baton doctor`. The same rule covers launcher `cmd`.
  A project file can still only select software already on the machine, but
  reviewing `.baton/agents.json` is worth the same attention as reviewing a
  CI config in a PR.
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
