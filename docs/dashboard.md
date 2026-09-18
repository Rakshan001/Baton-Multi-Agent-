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
status dot, and the theme toggle. The sidebar lists the screens defined in
[`web/src/App.tsx`](../web/src/App.tsx).

## Screens

| Screen | What it shows |
| --- | --- |
| Command Center | Home. The sessions board — every task with its agent, status, and git state. Start here. |
| Worktrees | The flow canvas: one node per worktree, is it actually moving, who holds it, and what it still holds that exists nowhere else. Collapses by plan phase, and takes work over from a node. See [below](#worktrees-the-flow-canvas). |
| Activity | A live feed of session activity, with quick access to a task's diff, handoff, and live terminal. |
| Pipeline | Phase swimlanes for an applied plan — which phase is open, which is locked, and **why** each waiting task cannot start. Read the plan document, and cancel a task, a phase or a whole plan with a blast-radius confirmation. See below. |
| Conflicts | Tasks currently flagged `conflict` (overlapping edits), plus the live **who's-editing panel**: each busy file grouped with every session holding it — the agent, its live intent note ("what I'm doing right now"), and freshness. The sidebar shows a badge with the count. |
| Knowledge Graph | The force-directed code graph built by graphify — nodes and edges for the indexed repo. |
| Memory | Shared project facts. Evidence-anchored facts with stale detection; add/prune when `--write` is on. |
| History | The local file-touch index — which task, agent, and commits touched a file over time. |
| Agents | The agent roster and running headless agents; connect an agent's MCP from here. |
| Skills | The catalog of reusable agent playbooks; import and install bundled or external skills — per agent, or **⚡ Add to all** agents in one click. |
| Settings | Preferences (theme, etc.) and the connected repo path. |

Each screen reads from the daemon's `/api` endpoints. See the
[HTTP API reference](./architecture.md) for the exact routes behind each screen.

## Pipeline: swimlanes, the plan, and cancelling

The Pipeline screen answers the one question the sessions board cannot: **why is
work not starting?**

Each phase is a lane, labelled `open`, `locked`, `complete`, `holding` or
`ungated`. Every waiting task carries the pipeline's own explanation — "phase 3
locked behind phase 2", "depends on 'x', which was cancelled", "blocked — needs
the Stripe test key". Those strings are computed by the daemon and rendered
verbatim, so what you read here is exactly what `baton next` prints. The screen
decides no eligibility of its own; a second implementation of the phase barrier
in the browser would disagree with the agents precisely when it mattered.

Two banners sit above the lanes when they apply:

- **Nothing can start** — work remains, but every remaining task is waiting on a
  human. Distinct from "the plan is finished", which is why it is said out loud.
- **Phase N is finished but has not landed** — its branches exist side by side
  and have never been combined, so the next phase is held. Run `baton integrate`.

Click a plan in the header to read its markdown source (`baton/plans/<id>.md`).
It is rendered as text, never as HTML: a plan is a file anyone can commit, and
turning it into markup would make "who can open a PR" into "who can run script
in the operator's dashboard".

### Cancelling

Cancel a task, a phase, or a plan. The confirmation is a **real dry run against
the live board** — not a preview assembled from the last poll — and it leads with
what nobody predicts: which tasks will be **stranded**. A cancelled task never
reaches `done`, so anything depending on it, directly or through a chain, can
never start.

Nothing is deleted. Branches, worktrees and checkpoints all survive, and an
agent still running learns on its next tool call and stops there — the stop is
cooperative, not instant.

Cancelling is the operator's (§7.6). The daemon refuses it when the dashboard
viewer is not the owner, when the daemon is read-only, and when *this machine* is
a member of someone else's hub — in that last case the plan lives at the hub, and
cancelling locally would fork it silently.

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

## Worktrees: the flow canvas

The Worktrees screen answers the question the sessions board cannot: **is that
worktree actually moving, and what does it still hold?** It reads one
read-model, `GET /api/worktrees` ([`src/worktrees.ts`](../src/worktrees.ts)),
which joins four things that already existed and were never joined — git's own
worktree list, the task record, the poller's status rows, and the liveness
probe. It replaced the Command Center's old board/canvas toggle; there is no
second canvas.

### `state` vs. `health`

Two fields on every row, and they are not peers. **This is the one distinction
to read before adding a third state-ish field, and it is stated only here —
every other document links to this section rather than restating it.**

- **`state` is what the daemon was told.** The lifecycle value it owns and
  writes down: `queued`, `claimed`, `active`, `paused`, `review`, `blocked`,
  `done`, `cancelled`. Somebody claimed a task, so the record says `claimed`.
- **`health` is what the disk says.** Evidence, read back from git and from the
  filesystem at the moment you ask: is anything uncommitted, is a process alive
  in there, has the progress token moved.

`health` is therefore a **modifier on a `state`, never a second state**. A task
can be `active` and `abandoned` at the same time, and that pair is the entire
point of the feature: the record says an agent is working, the disk says nobody
is home and the work here exists nowhere else. The canvas renders them on
different channels for the same reason — `state` owns the card's left rail,
`health` owns its border — and a card never shows two state pills.

Anything new that describes a worktree belongs on one side of that line. If it
is something Baton was told, it is part of `state`'s story; if it is something
Baton measured, it is `health`'s. A third field that mixes the two would have to
be reconciled with both, and the first thing to drift would be which one the
dashboard believes.

### The health vocabulary

Four names for liveness, six git-truth modifiers that outrank them, and
`unknown`:

| `health` | What it means |
| --- | --- |
| `working` | The progress token advanced inside the period (10 minutes). Silent. |
| `quiet` | Silent past the period, still inside grace (45 minutes). Visible, never an alarm. |
| `stalled` | Past period *and* grace with nothing moving. Another agent can take it over. |
| `abandoned` | Nothing running, and work here exists nowhere else. The one that gets lost. |
| `ok` | Nothing uncommitted, and nobody is expected to be moving it. |
| `dirty` | Uncommitted changes, no agent present. |
| `conflict` | A person has to resolve this before "is it moving" means anything. |
| `rebasing` | A rebase, merge, cherry-pick or revert is half-finished. `repoState` names which. |
| `missing` | Recorded as a worktree, but the directory is gone from disk. |
| `orphan-disk` | On disk and known to git, but no task owns it. |
| `unknown` | Git did not answer. Reported as unknown rather than guessed as fine. |

The **progress token** is what makes the liveness half honest. "No signal for N"
is the wrong condition, because a livelocked agent heartbeats happily forever
while making zero progress. The token is commit count, files changed and the
`report_progress` line, and `stalled` means the token has not advanced *and*
liveness says something is nominally still there.

**`health` is derived per request and never stored** — the same doctrine as
`isStalled` and the pipeline's locks, which are computed and never written. No
row is filed anywhere as `stalled`; the answer is recomputed from evidence each
time, so it cannot go stale in a file and it cannot be edited into being wrong.

**It fails closed to `unknown`.** A row whose git calls did not answer reports
`unknown` and can never report `working` or `ok`; so does a row whose local-only
commit count could not be read, and a held worktree with no liveness evidence at
all. This is not defensive padding — guessing "fine" when nothing can be seen is
how the dashboard launders dead work into looking fresh, which was the reported
bug. `unknown` also counts as *needing attention* in the header and sorts above
every reassuring value when a group is collapsed: the absence of evidence is not
evidence of fine.

**`quiet` deliberately never raises an alarm.** It is visible on the card, no
handoff brief is composed for it, no takeover of it will succeed (the daemon
refuses one for any worktree that showed activity inside the stall window), and
the desktop app never notifies on it
([`electron/notify.ts`](../electron/notify.ts) fires only for `stalled`,
`abandoned` and needs-input). That restraint is the feature, not a gap: a
worktree that is merely between commits is not a problem, and a
notification stream people learn to dismiss also teaches them to dismiss the
real one. Over-eager detection is worse than none here, because "restart" in
this product means handing another agent somebody's dirty worktree — a data-loss
operation, not a retry.

Rows are sorted **most-exposed-first**: `unprotected` counts uncommitted lines
plus commits that exist only on this branch on this machine, and the row at the
top of the list is what you lose if the disk dies. An unknown count keeps
`atRisk` true, because not knowing is not the same as being safe.

### The canvas

One node per worktree, laid out left to right along the plan DAG: rows band by
`planId`, phases ascend with `dependsOn` chains ordering nodes inside a phase,
and ties break on slug. The layout is pure and deterministic — the same data
always draws the same picture. A force simulation that re-settled on every poll
would be the fastest way to make this screen unusable.

Three things it is careful about, because a live graph fails at all three by
default:

- **Nodes are merged, never re-seeded.** Node objects are kept in a map keyed by
  slug and updated in place, so a drag and a selection survive a poll; only a
  genuinely new slug gets a position allocated. `fitView` runs exactly once.
- **Every value reads without colour.** `--clean` and `--dirty` sit 0.016 apart
  in WCAG relative luminance, so colour alone cannot carry this screen. Each
  `state` and each `health` value is also carried by a border or rail *pattern*,
  a unique glyph and its own word — a stalled node is identifiable in a
  greyscale screenshot, and a test pins the uniqueness. Quiet time draws as a
  decay ring that empties across the grace window, so an `active` node with an
  empty ring reads as evidence rather than as a verdict the daemon never issued.
  `prefers-reduced-motion` is honoured in JS, and the ring is never animated.
- **Theme tokens resolve per paint**, so a theme switch does not leave the
  canvas on the old palette.

Below 760px the canvas is replaced by a ranked list over the same read-model —
same data, same vocabulary, worst first — feeding the same selection state.

### Collapsing a plan phase

Worktrees group by plan and phase. A group folds into one node carrying its
member count and the **worst** child's health — never an average and never the
first child's, because otherwise collapsing would be a way to hide one stalled
worktree behind nine healthy ones, which inverts the point of the screen. Edges
crossing a collapsed boundary are re-pointed at the group node rather than
dropped, and several that reroute onto the same pair merge into one dashed edge
carrying a count. Worktrees with no plan are never grouped and never hidden.
Collapse state is remembered per project across a reload.

### The detail panel

Selecting a node opens a panel ordered **diagnosis before identity**, because
whoever is reading it has just found work that stopped. The order is exported as
data and a test fails if it drifts:

1. **Verdict** — the state pill and quiet time, in the largest type on the panel.
2. **Why** — the pipeline's own refusal sentence, rendered verbatim. The
   dashboard must not invent a second vocabulary for a refusal the CLI answers
   to.
3. **Who** — the agent, and **whether a process is actually running** in there.
   "An agent claimed this and no agent is here" is the single highest-value fact
   the route serves, and nothing else in the product states it.
4. **Work in flight** — ahead/behind, files changed, conflicts.
5. **What it said it was doing** — the progress ledger from
   `GET /api/worktrees/:slug/progress`, including the `flagged` overclaim
   marker, verbatim. This is what turns "quiet for 34m" into "quiet for 34m, and
   the last thing it said it was doing was X".
6. **Identity** — title, branch and worktree path, as copy fields.
7. **Actions**.

The panel is an inline aside above 900px and a focus-trapped bottom sheet below
it: one selection state, two presentations.

Actions, and what gates each:

| Action | Route | Notes |
| --- | --- | --- |
| Take over | `POST /api/worktrees/:slug/takeover` | `--write`. Refused with **the lifecycle guard's own sentence** for work that is not stalled — two agents in one worktree is the failure that guard prevents, and the refusal is shown rather than softened. |
| Pause | `POST /api/worktrees/:slug/pause` | `--write`. Records the reason. |
| Hand off | the shell's handoff dialog | `--write`. A worktree that entered `stalled` already has a brief composed for it, so this is usually one click on an artifact that exists. |
| Open Live, Diff | reads | **Not** write-gated: somebody hunting for work that went quiet must be able to see it from a read-only daemon. Gated on there being something to read. |
| Copy prompt | — | Copies the daemon's own brief body when an open brief exists, and the pickup command when none does. There is no third branch: the browser never assembles prompt text, because a fabricated handoff read as a real one is worse than no handoff. |
| Merge | `baton merge`'s endpoint | `--write`, and see below. |

**Merge names the branch it will land on.** `baton merge` merges into the
current branch of the daemon's repo with no reference to the task's own base, so
on a canvas showing a dozen worktrees a button labelled just "Merge" is a loaded
gun. The target is read from `/api/meta` — the same call the merge itself makes
— and named in the confirmation, along with the commit count. Every unknown
refuses rather than guesses: meta unread, a null branch, a hub root, a null
`repoState`, unknown health, a null ahead/behind. A conflict, a half-finished
git operation and a phase still held by the integration barrier are refused
*with the reason*, not hidden. Unlike `baton merge` from the CLI this does not
remove the worktree afterwards — on the one screen built for not losing work, a
button that silently deleted a directory its own confirmation never mentioned
would be exactly wrong.

### Snapshots: why stalled work stops being lost

Everything above makes lost work *visible*. One thing makes it *recoverable*:
when a worktree enters `stalled` or `abandoned` still holding uncommitted
changes, the daemon writes them to a dangling commit under
`refs/baton/wip/<slug>` ([`src/wip-snapshot.ts`](../src/wip-snapshot.ts)). A ref
in that namespace is invisible to `git branch`, lives in the common ref store,
is never pushed, and survives `git worktree remove` — and the row reports it as
`wipRef`. Long after the directory is gone:

```bash
git show refs/baton/wip/<slug>            # the diff against its HEAD
git show refs/baton/wip/<slug>:path/file  # one file, verbatim
git checkout -b rescue refs/baton/wip/<slug>
```

Nothing is written for a clean worktree, snapshotting twice with no change
writes one ref rather than two, gitignored paths are excluded twice over, and
the capture is size-capped per file (2 MiB) and in total (32 MiB) — otherwise
the first thing an auto-snapshot captures is somebody's `.env`, which turns a
safety feature into a secret-exfiltration feature.

### Recover: the same audit, read as work to rescue

`GET /api/doctor` already found orphaned worktrees, stale task records and
`baton/*` branches nobody owns. [`src/cleanup.ts`](../src/cleanup.ts) frames all
of it as **junk to delete**, which is right for `baton clean`, whose job is to
reclaim disk. It is the wrong framing for somebody looking for work an agent
left behind, so the Recover screen restates the same data with the verb
inverted — as **strandings**, work with no owner — and the verb decides which
button is primary: *recover into a new task* leads, delete is secondary and
confirmed.

Three categories (orphaned worktrees, stranded branches, snapshots), each sorted
independently by unmerged commits descending, most valuable first. An unknown
count sorts **above** every number including zero, and an orphan-worktree row's
zeros are read as unknown too, because `/api/worktrees` deliberately skips the
per-orphan status walk and synthesizes zeros — believing them would print
"nothing at risk" about a worktree nobody examined.

Recovery is honest about being two steps: no route grafts a stranded branch or a
snapshot into a new worktree, so the primary button creates the task and then
names the graft commands, saying plainly that Baton has no endpoint for that
step. The read is never write-gated; only the two verbs are.


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
