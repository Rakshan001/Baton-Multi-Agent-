# The dashboard

Baton ships a built React dashboard that the local daemon serves at
`http://localhost:7077`. It is a live, read-only-by-default view of every task,
agent, conflict, and the knowledge base for the repo the daemon is running in.

## Starting it

The dashboard is served by `baton serve`. There is no separate UI process — the
daemon hosts the JSON API, the SSE event stream, and the compiled dashboard from
one port.

```bash
baton serve              # API + dashboard on http://localhost:7077 (read-only)
baton serve --write      # also enable mutating actions (merge, remove, etc.)
baton serve -p 7078      # use a different port
```

The daemon binds to `127.0.0.1` only — it is not reachable from other machines.
Open the URL it prints in your browser:

```text
$ baton serve --write
baton serve → dashboard http://localhost:7077
  API: /api/status · /api/history · /api/meta · /api/tasks/:slug · /api/events (SSE) · /api/kb · /api/doctor   (Ctrl+C to stop)
```

| Flag | Effect |
| --- | --- |
| (none) | Read-only dashboard. Reads and SSE work; mutating buttons are disabled. |
| `--write` | Enables write actions across the API and unlocks the matching UI controls. |
| `-p`, `--port <n>` | Bind to a port other than the default `7077`. |

## Layout

The shell is a top bar, a left sidebar (a bottom tab bar on mobile), and the
active screen. The top bar holds the project switcher, live counters (Active /
Tasks / Conflicts), a **New session** button, search (`⌘K`), the connection
status dot, and the theme toggle. The sidebar lists the nine screens defined in
[`web/src/App.tsx`](../web/src/App.tsx).

## Screens

| Screen | What it shows |
| --- | --- |
| Command Center | Home. The sessions board — every task with its agent, status, and git state — switchable to a canvas view. Start here. |
| Activity | A live feed of session activity, with quick access to a task's diff, handoff, and live terminal. |
| Conflicts | Tasks currently flagged `conflict` (overlapping edits), plus the live **who's-editing panel**: each busy file grouped with every session holding it — the agent, its live intent note ("what I'm doing right now"), and freshness. The sidebar shows a badge with the count. |
| Knowledge Graph | The force-directed code graph built by graphify — nodes and edges for the indexed repo. |
| Memory | Shared project facts. Evidence-anchored facts with stale detection; add/prune when `--write` is on. |
| History | The local file-touch index — which task, agent, and commits touched a file over time. |
| Agents | The agent roster and running headless agents; connect an agent's MCP from here. |
| Skills | The catalog of reusable agent playbooks; import and install bundled or external skills — per agent, or **⚡ Add to all** agents in one click. |
| Settings | Preferences (theme, etc.) and the connected repo path. |

Each screen reads from the daemon's `/api` endpoints. See the
[HTTP API reference](./architecture.md) for the exact routes behind each screen.

## Read-only vs. write

The dashboard's write capability **follows the daemon**, not a per-browser
toggle. When the daemon was started with `--write`, the UI reads
`meta.writeEnabled` from `/api/meta` and unlocks mutating controls (merge,
remove, agent start/stop, memory edits, kb rebuild, skill install, and so on). A
**Write** badge appears in the top bar.

Without `--write`, those controls are disabled and any mutating request is
refused by the daemon. Every mutating request must also carry a loopback
`Origin` header — a central anti-CSRF guard rejects the rest — so the dashboard's
own actions work while cross-site requests cannot.

Restart the daemon with the flag you want; you cannot flip write mode from inside
the browser in real mode.

## Project switcher and multi-daemon connections

The top-bar switcher (the colored chip next to the Baton mark) changes which
repo you are looking at. In real mode each entry is a **connection** — a daemon
URL — and the dashboard can talk to several daemons at once:

1. Run `baton serve -p <port>` in another repo (each repo needs its own daemon).
2. Open the switcher → **Add connection…** → give it a name and URL
   (e.g. `http://localhost:7078`).

When the menu opens, the dashboard probes each connection's `/api/meta` and shows
its branch, repo, and a **live** / **unreachable** badge. Selecting a connection
re-points every screen at that daemon. The default connection (the origin that
served the page) cannot be removed.

## Multi-repo hubs

A **hub** (`baton setup` on a folder of several repos) is one daemon over many
sub-projects — distinct from the switcher above, which points at separate
daemons. When the daemon is serving a hub, the **Launch** and **New session**
dialogs show a **Project** picker: choose which sub-project a task belongs to,
and its worktree branches off that repo. The picker is hidden for a single repo.
The daemon reports this via `/api/meta` (`hub: true` + the project list), so the
UI never guesses.

## Realtime updates

The dashboard is live over Server-Sent Events, not polling-only and not
socket.io. It subscribes to `/api/events`; when the daemon emits a change
(new task, status change, edit signal, agent output), the affected screens update
in place. A connection dot in the top bar reflects the SSE state, and slower data
(meta, agent roster) is refreshed on a short interval as a fallback.

## Demo mode

The dashboard has a demo mode that runs entirely against an in-memory store with
simulated latency, scenarios, and offline states — useful for exploring the UI
without a daemon.

- **Vite dev origin (`http://localhost:5173`, `npm run dev --prefix web`)** —
  demo mode defaults **ON**. A **Demo data** badge shows in the top bar, the
  daemon is not queried, and the switcher lists demo projects (Busy / Calm /
  Empty / Offline scenarios are selectable in the Tweaks panel).
- **Daemon-served UI (`http://localhost:7077`, from `baton serve`)** — demo mode
  defaults **OFF**. The dashboard talks to the real daemon and shows real data.

An explicit choice in the Tweaks panel persists and overrides the per-origin
default. The default lives in [`web/src/lib/api.ts`](../web/src/lib/api.ts)
(`demo = import.meta.env.DEV`).

## Next steps

- [HTTP API reference](./architecture.md) — the endpoints behind every screen.
- [CLI reference](./cli-reference.md) — `baton serve` and the commands the
  dashboard mirrors.
- [README](../README.md) — project overview and setup.
