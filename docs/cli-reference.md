# CLI reference

Every `baton` command. If you didn't run `npm link`, use `node dist/cli.js <command>` instead of `baton <command>`.

```bash
baton --help        # list all commands
baton <cmd> --help  # help for one command
baton --version
```

A **slug** is the kebab-case id of a task (e.g. `refactor-the-auth-middleware`), derived from the task text and shown by `baton ls`. Commands that take `[slug]` default to the worktree you're currently in.

## Setup & sessions

### `setup`
One-command setup. Classifies the target and does the right thing: a single repo → `kb init`; a folder of several separate repos → asks **centralized hub** (merged graph + one dashboard) vs **individual** (per repo); a bare folder → offers `git init`.

```bash
baton setup [path]
```

| Flag | Effect |
|---|---|
| `--hub` / `--individual` | Multi-repo: skip the prompt and pick hub vs. per-repo. |
| `--yes` | Accept recommended defaults without prompting. |
| `--no-mcp` | Don't write graphify MCP servers to `.mcp.json`. |
| `--no-docs` | Don't add the coordination guide to `AGENTS.md` / `CLAUDE.md`. |
| `--share` / `--local` | Commit the KB to git (so teammates skip re-indexing) vs. keep it local. |
| `--serve` / `--headless` | Use the dashboard vs. KB-only (agents over MCP, no dashboard). |

### `new`
Scaffold a branch (`baton/<slug>`) + git worktree (under `.baton/wt/<slug>`) for a task.

```bash
baton new "<task description>"
```

### `ls`
List tasks with git status, ahead/behind counts, and age.

### `status`
Central live view: agent, status, ahead/behind, likely conflicts.

```bash
baton status [-w|--watch]   # --watch auto-refreshes every 2s
```

### `path`
Print a task's worktree path (handy for `cd "$(baton path <slug>)"`).

```bash
baton path <slug>
```

### `rm`
Remove a task's worktree + branch.

```bash
baton rm <slug> [-f|--force]   # --force: remove even with uncommitted changes
```

## Merging & history

### `merge`
Merge a task's branch into the current branch. Squashes to one commit and archives the branch tip by default.

```bash
baton merge <slug> [--no-squash] [--no-archive]
```

### `history`
Trace which task / agent / commits touched a file (from the local index). Omit `[file]` to list all tasks.

```bash
baton history [file]
```

### `blame`
Who touched a file — live editors + merged history.

```bash
baton blame <file>
```

### `signals`
Show live edit signals — which files are being edited by which session right now.

## The daemon & dashboard

### `serve`
Start the local daemon: JSON API + SSE + the built web dashboard.

```bash
baton serve [-p|--port <port>] [--write]
```

| Flag | Effect |
|---|---|
| `-p, --port <port>` | Port to bind (default **7077**). Binds `127.0.0.1` only. |
| `--write` | Enable mutating actions (merge / remove / rebuild / install …) from the dashboard. |

See [Dashboard](./dashboard.md) and [Security](./security.md).

### `doctor` / `clean`
Audit and reclaim junk — orphaned worktrees, `baton/*` branches, ghost tmux sessions, leaked temp files.

```bash
baton doctor                  # audit only
baton clean [--fix] [-f|--force]   # dry-run unless --fix; --force removes dirty worktrees
```

## Knowledge base — `kb`

Code knowledge graphs via [graphify](./knowledge-graph.md).

```bash
baton kb init [path] [--no-mcp] [--no-docs] [--share|--local]   # set up graphs + git hook + MCP
baton kb status                                                 # projects, node/edge counts, last build
baton kb rebuild [project] [--full]                            # incremental by default; --full re-extracts
baton kb export [--out <file>]                                 # → baton-kb-<repo>-<sha>.tar.gz
baton kb import <source> [--no-rebuild]                        # adopt a .tar.gz pack or a kb/ directory
baton kb share [on|off]                                        # toggle committing the KB (kb/ dir)
baton kb mcp [--agent claude|cursor|codex|gemini]              # print MCP config for an agent
```

## Headless agent runs

### `start` / `stop`
Run an agent's print mode inside a task's worktree, streaming output to the dashboard.

```bash
baton start <slug> [--agent claude|codex|gemini] [--model <m>] [--prompt <text>]
baton stop <slug>
```

The prompt defaults to the task's `HANDOFF.md` brief if present, else the task text. Baton never adds permission-bypass flags.

## Handoff — `pass` / `take` / `done`

```bash
baton pass [slug] [--to cursor|codex|gemini|any] [--model <m>] [--note <text>] \
                  [--from <agent>] [--no-commit-pending] [--auto]
baton take [slug]   # print the execution prompt, mark in-progress
baton done [slug]   # mark the brief done
```

| `pass` flag | Effect |
|---|---|
| `--to <agent>` | Receiving agent. Omit to **auto-route** by task type + severity. |
| `--model <m>` | Model for the receiving CLI (advisory, recorded in the brief). |
| `--note <text>` | Extra context for the receiving agent. |
| `--from <agent>` | Handing-off agent (default `claude`). |
| `--no-commit-pending` | Skip the checkpoint commit of uncommitted changes. |
| `--auto` | Quiet hook mode: no-op outside a worktree, skip if a fresh brief exists. |

See [Session handoff](./session-handoff.md).

### `route`
Which agent should take a task — rules from `baton.config.json`, no LLM. See [Agent routing](./agent-routing.md).

```bash
baton route "<task description>"
```

## Shared memory — `memory`

Evidence-anchored facts agents learned. See [Project memory](./memory.md).

```bash
baton memory list                 # default; ● fresh · ◐ aging · ○ stale
baton memory add "<fact>" [--type decision|gotcha|convention|reference|preference] \
                          [--files <comma,paths>] [--task <slug>]
baton memory rm <id>
baton memory gc                   # drop stale facts (anchored files changed)
```

## Agent integration

### `hooks install`
Auto-generate a handoff brief when a Claude Code session ends (Stop / PreCompact hooks).

```bash
baton hooks install claude [--project]   # --project: write into this repo's .claude/settings.json
```

### `mcp`
Run the Baton coordination MCP server over stdio (`check_files`, `get_report`, `who_touched`, `save_memory`, `recall_memory`, …). Usually invoked by an agent via the config from `baton kb mcp`, not by hand. See [MCP tools](./mcp-tools.md).

### `usage`
Real token usage per Claude Code session, parsed from session files (costs estimated).

```bash
baton usage
```

## Related

- [Quickstart](./quickstart.md) · [Dashboard](./dashboard.md) · [Configuration](./configuration.md)
