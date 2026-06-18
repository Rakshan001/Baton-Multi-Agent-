# Troubleshooting & FAQ

Fixes for the common issues you hit running Baton's daemon, dashboard, and
knowledge base — plus answers to the questions people ask first. For first-time
install steps see [SETUP.md](../SETUP.md).

## Common issues

| Symptom | Fix |
| --- | --- |
| `dashboard not built — run: npm run build --prefix web` | The compiled UI is missing. Run `npm run build --prefix web`, then restart `baton serve`. |
| `graphify is not installed` | The knowledge base needs the external `graphify` CLI. Install it with `uv tool install graphifyy` (or `pipx install graphifyy` / `pip install graphifyy`), then re-run your `baton kb` command. |
| Port `7077` is busy | Start on another port: `baton serve -p 7079`. In the dashboard, add it as a connection (switcher → **Add connection…** → `http://localhost:7079`). |
| Knowledge Graph has nodes but no docs/PDF content | Code-only extraction needs no key, but graphify only summarizes docs/PDFs when an LLM key is set. Export one (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, …) and run `baton kb rebuild --full`. |
| Dashboard shows fake **"Orbit"** / demo data | You are on the Vite dev origin (`:5173`), where demo mode defaults **ON**. Turn it off in the Tweaks panel (bottom-right), or just use the real daemon UI at `:7077`. |
| Interactive terminals say tmux is missing | tmux hosts the in-dashboard agent terminals. Install it (`brew install tmux` / `apt install tmux`) and restart the daemon. Headless runs (`baton start`) work without tmux. |
| Mutating buttons (merge, remove, agent start) are greyed out | The daemon is read-only. Restart it with `baton serve --write`. See [Read-only mode](#read-only-mode) below. |
| Action refused even with `--write` | Every mutating request must carry a loopback `Origin` header (a central anti-CSRF guard). The dashboard and `curl` from localhost pass; a request without a loopback origin is rejected by design. |

### Knowledge graph: code vs. docs

Two extraction levels exist:

```bash
baton kb rebuild              # code-only — no LLM key required
baton kb rebuild --full       # also summarizes docs/PDFs — needs an LLM key
```

If a sub-project's docs section is empty in the Knowledge Graph screen, you most
likely ran the code-only path or have no key exported. Check state with:

```bash
baton kb status
```

### Demo data won't go away

Demo mode is intentional — it is the showcase and defaults **ON** only on the
Vite dev origin (`http://localhost:5173`). The daemon-served UI at
`http://localhost:7077` is real by default.

- On `:5173`: open the **Tweaks** panel (bottom-right) and switch demo off. Your
  choice persists and overrides the per-origin default.
- Or just open `http://localhost:7077` — that origin shows real data.

### Read-only mode

By default `baton serve` runs **read-only**: reads and the live SSE feed work,
but every write action is refused. Start with `--write` to enable merges, task
removal, agent start/stop, memory edits, kb rebuild, and skill installs.

```bash
baton serve --write
```

The dashboard follows the daemon: when `--write` is on it reads
`meta.writeEnabled` from `/api/meta` and unlocks the matching controls. You
cannot flip write mode from inside the browser — restart the daemon with the flag
you want.

## Daemon resource use

The daemon is light by design. Its status poller runs **only while a dashboard or
SSE client is connected** — when nothing is watching `/api/events`, it does not
poll, so idle CPU sits around ~0%. (`src/poller.ts` runs only while SSE clients
exist.) Per-worktree file watchers and the SSE event bus add no steady CPU cost.

If you do see sustained CPU, check for a stuck client holding the SSE stream open,
or a runaway external `graphify` rebuild triggered by a commit hook.

## Diagnostics

When something looks wrong, these surface the state quickly:

```bash
baton doctor          # audit junk: orphaned worktrees/branches/tmux/temp files
baton clean           # dry-run report of what could be reclaimed
baton clean --fix     # actually reclaim it (use --force for dirty worktrees)
baton ls              # tasks with git status, ahead/behind, age
baton kb status       # knowledge-base freshness per sub-project
```

The daemon also exposes a read-only audit at `GET /api/doctor`.

### tmux is wedged

A daemon launched inside a sandboxed wrapper can occasionally wedge the shared
tmux server (every tmux command on the machine hangs). Normal use — `baton serve`
from a real terminal — is unaffected. If it happens:

```bash
pkill -f 'tmux -C attach' && rm -rf /tmp/tmux-$UID
```

## FAQ

### Does Baton support agents other than Claude Code?

Yes. Baton coordinates **Claude Code, Cursor, Codex, Gemini CLI, Aider, and
OpenCode** on one repo. Headless print-mode runs (`baton start`) support claude,
codex, and gemini; interactive tmux terminals in the dashboard support all six.
Routing and handoff briefs can target cursor, codex, gemini, or any.

### Where is my data stored?

Everything is local to your repo and machine:

- **Tasks / worktrees** — branches `baton/<slug>` with worktrees under
  `.baton/wt/<slug>`.
- **Memory** — evidence-anchored facts at `.baton/memory/facts/` (always the
  **main** repo, even when written from a worktree).
- **Reports** — completion reports at `.baton/reports/<slug>.md`.
- **History** — a local SQLite file-touch index.
- **Knowledge base** — per-project graphs plus a `CODEBASE.md` map; an `.mcp.json`
  wires agents to query them.

Nothing leaves your machine unless you explicitly export it (`baton kb export`,
`baton kb share`). To permanently reclaim space, use the
**Memory → Storage → Danger Zone** purge (triple-guarded: `--write` + loopback
origin + a typed confirm phrase) or `GET /api/storage/purge` for a dry-run audit.

### Is it safe to run?

Baton is built to run locally only:

- The daemon binds to **`127.0.0.1` only** — it is not reachable from other
  machines. CORS is loopback-only.
- A central **anti-CSRF guard** requires a loopback `Origin` on **every** mutating
  `/api` request, so a malicious site you visit cannot drive your daemon.
- Writes are off until you pass `--write`; the permanent storage purge is
  triple-guarded.
- Skill imports from URLs are SSRF-guarded (private/loopback hosts refused,
  redirects re-validated, size and timeout caps).
- Memory rejects secret-looking content (keys, tokens, JWTs).

### How do I fully stop it?

Stop the daemon with `Ctrl-C` in the terminal running `baton serve` (or kill its
process). To also stop background agent work:

```bash
baton stop <slug>     # stop a headless run
baton doctor          # check for leftover worktrees / tmux sessions
baton clean --fix     # remove orphaned junk
```

Interactive terminals are hosted by tmux and survive a daemon restart; `baton
clean --fix` and `baton rm <slug>` clean up their sessions when you remove a task.

## Related

- [Setup guide](../SETUP.md) — install, first run, and a quick troubleshooting table.
- [The dashboard](./dashboard.md) — screens, read-only vs. write, demo mode.
- [MCP tools for agents](./mcp-tools.md) — wiring agents to Baton's two MCP servers.
- [Project memory](./memory.md) — evidence-anchored facts and stale detection.
