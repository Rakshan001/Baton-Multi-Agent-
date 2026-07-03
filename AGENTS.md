# Agent instructions — setting up Baton for a user

> **Scope check:** if a human asked you to work on Baton's *own* source code in this
> repo, stop here and read [CLAUDE.md](CLAUDE.md) and [STATUS.md](STATUS.md) instead.
> This file is for the opposite case: a human pointed you (an AI coding agent —
> Cursor, Claude Code, Codex, Gemini, …) at this repository and asked you to
> **install Baton and wire it up for one of their own projects**. Follow it top
> to bottom, and don't skip Step 1 by guessing the answers.

## What you're setting up

Baton is a local CLI + dashboard that coordinates multiple AI coding agents on a
git repo — isolated worktrees, a realtime dashboard, a code knowledge graph, and
session handoff between agents. You are going to: build Baton itself, point it at
the human's own project, wire up the agent CLIs they actually use, start the
dashboard, and leave them a short personalized guide.

## Step 0 — Preflight

Run these and report anything missing before continuing, rather than failing partway through later:

```bash
node --version   # need >= 20
git --version
uv --version || pipx --version || pip --version   # any one, for graphify
tmux -V          # optional — interactive terminals in the dashboard; headless runs work without it
```

If Node is missing/too old or git is missing, stop and tell the human — everything
downstream depends on them. If none of `uv`/`pipx`/`pip` is available, continue but
flag that the knowledge-graph step will need one of them installed first.

## Step 1 — Look first, then ask the human these questions

**Look before asking:** `ls` the target path the human gives you. Is it one git
repo, or a folder that *holds several separate git repos* (e.g. one product split
into `api-server/`, `admin-panel/`, `website/`, …)? Knowing this lets you ask
question 2 concretely instead of abstractly.

Ask all of these up front, before running anything in Step 2+. Do **not** answer
them yourself and do **not** use `baton setup --yes` — that auto-accepts defaults
and skips exactly the decision the human should make.

1. **Target project** — "Which project (folder path) do you want Baton to
   coordinate agents on?" (This is *not* where Baton itself lives — Baton is a
   separate tool you build once and then point at this path.)

2. **Setup mode** — the most important question. Present the three options in the
   human's terms, with your recommendation based on what you saw in `ls`:

   | Option | When it fits | What they get |
   |---|---|---|
   | **Single repo** | The target is one git repo | One knowledge base + dashboard for that repo |
   | **Centralized hub** | One product split across several repos in one folder (e.g. a backend + several frontends) | **One combined knowledge base** (merged cross-repo graph), one dashboard, shared memory across all of them; each task picks which sub-repo it targets |
   | **Individual** | Several unrelated repos that happen to share a folder | A separate, self-contained knowledge base per repo (run per-repo setup for each they choose) |

   Phrase it like: *"This folder holds N git repos. Do you want one **combined**
   knowledge base over all of them (recommended when they're one product — agents
   can see cross-repo context), or **individual** knowledge bases per repo, or is
   just one of these repos the real target?"*

3. **Sharing** — "Should this knowledge base be shareable with teammates?"
   - **Shared (recommended for teams):** the KB is kept in a committed `kb/`
     directory, so anyone who clones the repo gets the graphs + code map with
     **zero re-indexing** — clone-and-go. Enable with `--share` at setup (or
     later with `baton kb share on`).
   - **Local only:** the KB stays in gitignored `.baton/`; a teammate can still
     receive it as a one-file pack via `baton kb export` → `baton kb import`.
   - If unsure: solo project → local; anything with teammates → shared.

4. **Which agent CLIs do you use?** Claude Code / Cursor / Codex / Gemini / Aider
   / OpenCode (multi-select). This decides which `baton kb mcp --agent …` /
   `baton hooks install …` commands to run in Step 3.

5. **Dashboard port** — default is `7077`; ask if they want a different one.

6. **Write mode** — start the dashboard read-only first, or with `--write`
   (enables merge/remove/rebuild from the UI) right away?

## Step 2 — Build Baton

Clone this repo first if it isn't already on disk, then build it:

```bash
git clone https://github.com/Rakshan001/Baton-Multi-Agent-.git baton
cd baton

npm install                  # CLI + daemon deps
npm install --prefix web     # dashboard deps

npm run build                # tsc → dist/
npm run build --prefix web   # vite → web/dist/ (served by `baton serve`)

uv tool install graphifyy    # or: pipx install graphifyy / pip install graphifyy

npm link                     # optional — puts `baton` on PATH
                              # otherwise use `node <path-to-baton>/dist/cli.js …`
```

Each step is idempotent — skip ones already satisfied (e.g. `dist/` already
built) instead of blindly re-running, but re-run if the human's answers imply
something changed (e.g. a fresh clone).

## Step 3 — Wire up the target project

Run the setup that matches the **Step 1 answers** — pass the mode explicitly
instead of letting the classifier guess:

```bash
cd <target project from Step 1>

# Single repo:
baton setup [--share]

# Centralized hub (one combined KB over all repos in this folder):
baton setup --hub [--share]

# Individual KBs (run once per repo the human chose):
cd <repo-a> && baton setup [--share]
cd <repo-b> && baton setup [--share]
```

(If `npm link` wasn't run, use `node <path-to-baton>/dist/cli.js setup …` —
and the same substitution for every `baton …` command below.)

Verify it worked before moving on: `baton kb status` should list the indexed
project(s) with node/edge counts. For a hub, confirm every sub-repo appears.

Then, only for the agent CLIs the human named in Step 1:

```bash
baton kb mcp --agent cursor    # prints config → write it to .cursor/mcp.json
baton kb mcp --agent codex     # → ~/.codex/config.toml
baton kb mcp --agent gemini    # → ~/.gemini/settings.json
baton hooks install claude     # Claude Code: auto-handoff brief on session end
```

`baton setup`/`kb init` already wrote `.mcp.json`, which Claude Code picks up
automatically in every worktree — no extra step for Claude Code beyond
`hooks install`. Aider and OpenCode have no CLI wiring command; mention they can
be wired from the dashboard's **Agents** screen after Step 4.

## Step 4 — Start the dashboard

```bash
baton serve -p <port from Step 1> [--write]   # include --write only if the human asked for it
```

Confirm `http://localhost:<port>` loads. If it says "dashboard not built," go
back to the Baton checkout and run `npm run build --prefix web`, then retry. If
the port's busy, pick another and use it consistently from here on.

For a **hub**, also confirm the Launch / New-session dialogs show a **Project**
picker listing the sub-repos — that's how each task chooses which repo its
worktree branches off (CLI equivalent: `baton new "<task>" --project <id>`).

## Step 5 — Write the personalized guide

Create `GETTING_STARTED.md` in the target project's root (next to the `.baton/`
folder `kb init` just created — or the hub root, for a multi-repo hub). Don't
overwrite an existing one without asking first. Fill this shape in with the
human's actual answers, not placeholders:

```markdown
# Getting started with Baton (this project)

Set up on <date>. Dashboard: http://localhost:<port>

## What's wired up
- Baton indexed: <single repo | combined hub over: repo-a, repo-b, … | individual: repo-a>
- Knowledge base sharing: <committed kb/ (teammates clone-and-go) | local only (share with `baton kb export`)>
- Agents wired: <e.g. Claude Code (MCP + hooks), Cursor (MCP)>

## Day to day
\`\`\`bash
baton new "<task description>"        # new isolated worktree + branch
# hub only: add --project <id> to pick which sub-repo the task targets
cd .baton/wt/<slug>                   # start your agent here
baton status -w                       # live board
baton signals                         # who's editing what right now
baton pass <slug> --to <agent>        # hand off with a curated brief
baton take <slug>                     # pick up a handoff
baton merge <slug>                    # squash + merge when done
\`\`\`

## Sharing the knowledge base
\`\`\`bash
baton kb export                       # one-file pack → send to a teammate
baton kb import <pack>                # teammate: import, zero re-indexing
baton kb share on                     # or: keep a committed kb/ dir in git
\`\`\`

## If something breaks
See the troubleshooting table in Baton's own SETUP.md or docs/troubleshooting.md
(wherever you checked out the Baton repo in Step 2).
```

## Step 6 — Summary

Tell the human, in plain language: what got installed, **which setup mode you
used and why**, whether the KB is shared or local, the dashboard URL, and where
`GETTING_STARTED.md` landed. Point to [docs/README.md](docs/README.md) in the
Baton checkout for anything deeper (dashboard walkthrough, session handoff,
project memory, MCP tools).

---

> Note: if you later run `baton kb init`/`baton setup` on this Baton repo
> itself, it may append a `baton:coordination`-tagged block below this line —
> that's an auto-generated coordination guide for agents editing Baton's own
> source, and is unrelated to the onboarding steps above.
