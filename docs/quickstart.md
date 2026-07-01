# Quickstart

From a clone to the running dashboard and your first agent handoff. Assumes you've finished [Installation](./installation.md) (Node ≥ 20, git, `uv`, and `baton` on your `PATH`).

## 1. Index your repo

Run this once at the root of any git repo. It builds a knowledge graph, installs a git hook to keep it fresh, and writes the MCP config agents use to query it.

```bash
baton kb init
baton kb status   # confirm it indexed (projects + node/edge counts)
```

Baton auto-detects sub-projects (e.g. a repo with `api/` and `web/`) and builds one graph each plus a merged cross-project view. See [Knowledge base](./knowledge-graph.md).

> **One command for everything:** `baton setup` classifies the folder for you — a single repo, or a folder holding several repos (a centralized hub vs. one setup per repo) — and runs the right `kb init`. See [the CLI reference](./cli-reference.md#setup).

## 2. Start the dashboard

```bash
baton serve --write
```

Open **<http://localhost:7077>**. `--write` enables mutating actions (merge, remove, rebuild). Without it the dashboard is read-only. The daemon binds to `127.0.0.1` only — it's never reachable off your machine. See [Dashboard](./dashboard.md) and [Security](./security.md).

## 3. Create an isolated session

Each task gets its own git worktree and `baton/<slug>` branch, so agents never clobber each other.

```bash
baton new "refactor the auth middleware"
# ✓ created baton/refactor-the-auth-middleware
#   worktree: .baton/wt/refactor-the-auth-middleware
```

Start your agent in that worktree:

```bash
cd .baton/wt/refactor-the-auth-middleware
claude     # or cursor-agent / codex / gemini …
```

The new session appears live on the dashboard's Command Center. You can also launch from the UI ("New session"), or run an agent headlessly:

```bash
baton start refactor-the-auth-middleware --agent claude
```

> **Multi-repo hub?** If you ran `baton setup` on a folder of several repos, run `baton serve` from the hub root and tell each task which sub-project it targets — the worktree branches off that repo:
> ```bash
> baton new "fix the checkout crash" --project fatfox-api-server
> ```
> In the dashboard the **Launch** / **New session** dialogs show a project picker instead. List project ids with `baton kb status`.

## 4. Coordinate

While agents work, Baton streams what's happening:

```bash
baton status -w     # live board in the terminal
baton signals       # which files are being edited right now
baton blame src/auth/middleware.ts   # who touched this file (live + history)
```

If two sessions edit the same file, the dashboard's **Conflicts** page raises an overlap warning *before* it becomes a merge conflict. Agents can check first via the [`check_files` MCP tool](./mcp-tools.md).

## 5. Hand the work off

Do the expensive planning on a powerful agent, then pass a curated, execution-ready brief to a cheaper one:

```bash
baton pass refactor-the-auth-middleware --to cursor
# → writes HANDOFF.md (objective, plan, files, git state, cost estimate)
```

Pick it up on the receiving side:

```bash
baton take refactor-the-auth-middleware   # prints the execution prompt
# …the agent edits…
baton done refactor-the-auth-middleware
```

Omit `--to` and Baton auto-routes by task type ([Agent routing](./agent-routing.md)). The dashboard's **Handoff** dialog drives the same flow. See [Session handoff](./session-handoff.md).

## 6. Merge and clean up

```bash
baton merge refactor-the-auth-middleware   # squash + archive into the current branch
baton rm refactor-the-auth-middleware      # remove the worktree + branch (or use the board)
```

On the dashboard, drag a card onto **Ready to merge** to merge (when running `--write`).

## Where to go next

- [The dashboard](./dashboard.md) — every screen explained.
- [Session handoff](./session-handoff.md) — the `HANDOFF.md` format and the Claude hooks.
- [Project memory](./memory.md) — let agents save and recall verified facts.
- [CLI reference](./cli-reference.md) — the full command surface.
