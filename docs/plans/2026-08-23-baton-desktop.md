# Baton Desktop — Electron app for macOS and Windows

> **Plan A of two.** The sibling plan is
> [2026-08-23-improvement-backlog.md](./2026-08-23-improvement-backlog.md).
> They are independent: two agents can run them side by side without touching
> the same files, with one exception noted in §0.

**Goal:** a downloadable installer that opens to a list of every Baton project
on this machine, shows which are running, and starts or stops any of them with
one click. No terminal, no `npm i -g`, no remembering which port.

---

## §0 — Read this first

### The problem this solves

You work on three to five projects a day. `baton serve` for project A is still
running in a background terminal you closed. You try to start project B and hit
a port collision, or worse, you do not — and now two daemons are live and you
cannot tell which dashboard belongs to which repo.

**The fix is visibility, not new machinery.**

### 🟢 Most of this is already built — do not rebuild it

The daemon fleet was designed and shipped on 2026-07-31
([plan](../plans-local/2026-07-31-daemon-fleet-plan.md)), which explicitly
deferred the Electron shell and said: *"the fleet registry built here is exactly
what a future tray icon would read."* This plan is that tray icon.

| Already exists | Where |
|---|---|
| Registry — one file per daemon, `{pid, port, root, startedAt, version, writeEnabled, host}` | `src/daemons.ts`, `~/.baton/daemons/` |
| `listVerifiedDaemons()` — liveness by pid **and** `/api/meta` root match | `src/daemons.ts:223` |
| `stopDaemon()` — graceful, then signal; `'graceful' \| 'signal' \| 'refused-stale' \| 'failed'` | `src/daemons.ts:244` |
| `sweepDeadDaemonRecords()` — clears crashed entries | `src/daemons.ts:122` |
| `GET /api/daemons`, `POST /api/shutdown`, `POST /api/daemons/clean` | `src/server.ts:1175,1183,1197` |
| `baton ps` | `src/cli.ts:202` |
| The whole dashboard, already bundled into the npm package | `web/dist` (~20 screens) |

**The app is a shell over these.** Any phase that reimplements liveness,
stopping, or discovery is doing it wrong — verify against `src/daemons.ts`
first.

### The packaging risk is already retired

Orcabaton's P26.5 proved Baton runs correctly under Electron's own Node with a
complete dependency closure — **37 MB payload, 119 packages, verified running**.
The scripts to copy the approach from:

```
../orcabaton/config/scripts/baton-sidecar-payload.mjs
../orcabaton/config/scripts/baton-dependency-closure.mjs
../orcabaton/config/scripts/baton-sidecar-guard.cjs
../orcabaton/config/electron-builder.config.cjs
```

Read them; do not import them. Different repo, different licence.

### Non-negotiables

- **The daemon stays a separate process.** Electron spawns `dist/cli.js serve`;
  it never imports the server into the render or main process. Same discipline
  that keeps the daemon testable and lets the CLI keep working alone.
- **The CLI remains a first-class product.** Everything the app does must stay
  possible from a terminal. The app is a surface, never the only door.
- **Loopback only.** The fleet is owner-scoped by existing authorization
  (`/api/daemons` refuses non-loopback). The app must not widen that.
- **Never ship `--write` on by default.** It grants repo mutation; the toggle
  says what it grants, as Orcabaton's P26 pane does.

### One coordination point with Plan B

Plan B touches `src/server.ts` and `src/daemons.ts` for hardening. This plan
**reads** those and adds `electron/`. If both agents are live, Plan B owns those
files; this plan waits for its changes rather than editing them.

---

## Phase D1 — the shell that lists projects

**Repo:** `baton` · **New:** `electron/` · **Depends on:** nothing

The smallest thing that solves the actual problem.

```
electron/main.ts            app lifecycle, single-instance lock, window
electron/fleet.ts           wraps listVerifiedDaemons / stopDaemon
electron/preload.ts         contextBridge — no nodeIntegration in the renderer
electron/ui/               fleet list (plain React, reuse web/ components)
```

**The window shows one table**, one row per project:

| Column | Source | Notes |
|---|---|---|
| Project | `basename(root)` | full path on hover |
| State | verification | **running** / **stale** / **stopped** |
| Port | `record.port` | click opens the dashboard |
| Started | `startedAt` | relative time |
| Write | `writeEnabled` | badge, because it grants mutation |
| Action | — | Stop · Open · Clean up |

**A stale row never gets a Stop button** — it gets *Clean up*, which deletes the
record. This is the existing rule in `daemons.ts` and it exists because a pid we
cannot vouch for might now belong to something else entirely. Do not soften it.

### Edge cases

| # | Case | Handling |
|---|---|---|
| D1-E1 | Registry dir missing (never run `serve`) | Empty state: "No projects yet — add one", not an error |
| D1-E2 | Record exists, pid dead | `stale` + Clean up. Never Stop |
| D1-E3 | Pid alive, `/api/meta` root differs | `stale`. Pid was reused — this is exactly what the root match is for |
| D1-E4 | Daemon predates `/api/shutdown` (404) | Fall back to SIGTERM on the verified pid. Never SIGKILL automatically |
| D1-E5 | Two app windows open | Single-instance lock; second launch focuses the first |
| D1-E6 | User stops the daemon serving the dashboard they are viewing | Expected. Close the embedded view, return to the list |
| D1-E7 | 20+ projects | Virtualise the list; poll once and fan out, never per row |

**Done when:** the app lists every running daemon, Stop actually stops one,
`baton ps` and the app agree, and a killed daemon shows `stale` within one
refresh.

---

## Phase D2 — start a project from the app

**Depends on:** D1

Add is the other half of the problem: today starting project B means a terminal.

- **Add project** → native folder picker → validate it is a git repo → remember
  it in `~/.baton/projects.json` (paths only; no secrets, ever).
- **Start** → spawn `dist/cli.js serve` with the bundled Node, `cwd` = project
  root, port auto-allocated by the existing `nextFreePort` logic.
- Remembered projects that are not running render as **stopped** with a Start
  button. That is the list the user actually wants: *my projects*, not *my
  running processes*.

### Edge cases

| # | Case | Handling |
|---|---|---|
| D2-E1 | Folder is not a git repo | Refuse with the reason. Do not `git init` on someone's folder |
| D2-E2 | Project already running | Start is disabled; offer Open instead |
| D2-E3 | Port range exhausted | Surface the real error from `nextFreePort` |
| D2-E4 | `serve` exits immediately | Show the last 20 lines of its output. **Never `stdio: 'ignore'`** — that defect is documented in Orcabaton's REFS-GUIDE |
| D2-E5 | Remembered path deleted or moved | Render `missing` with a Forget action |
| D2-E6 | Same repo added twice via a symlink | Canonicalise with realpath before comparing, as `signals.ts` already does |

**Done when:** a project can be added, started, opened and stopped without a
terminal, and it survives an app restart.

---

## Phase D3 — the dashboard inside the app

**Depends on:** D2

Clicking **Open** loads the existing dashboard rather than sending people to
Chrome.

- A `BrowserView` pointed at `http://127.0.0.1:<port>`, served by that project's
  own daemon. **`web/dist` is not re-hosted by Electron** — the daemon already
  serves it, and one server means one source of truth.
- Back button returns to the fleet list.
- `contextIsolation: true`, `nodeIntegration: false`, and a navigation guard
  that refuses any URL outside `127.0.0.1:<known ports>`.

### Edge cases

| # | Case | Handling |
|---|---|---|
| D3-E1 | Daemon dies while viewing | Detect, return to the list with "that project stopped" |
| D3-E2 | Page tries to navigate off-host | Blocked by the guard; log it |
| D3-E3 | External links in dashboard content | Open in the system browser, never in-app |

**Done when:** the dashboard is usable in-app and the navigation guard has a
test proving an off-host URL is refused.

---

## Phase D4 — graphify process control

**Depends on:** D1

Graph builds are the heaviest thing Baton starts, and today they are invisible.
Surface them where the daemons are.

- Show a per-project graph row: last built, node/edge count, and **whether a
  build is running now**.
- **Stop** a running build. Rebuild on demand.
- Read the existing shared-graphify-server work
  ([plan](../superpowers/plans/2026-07-03-shared-graphify-server.md)) before
  adding any new process management — a backend may already be shared across
  projects, and killing a shared one from a per-project button would be wrong.

### Edge cases

| # | Case | Handling |
|---|---|---|
| D4-E1 | Backend shared between projects | Stop must say what else it affects, or be disabled |
| D4-E2 | graphify not installed | Row says so, with the install command. Not an error state |
| D4-E3 | Build running at app quit | Leave it. It is a separate process doing useful work |
| D4-E4 | Memory growth during build | Show RSS. See Plan B's item on the graphify RAM regression |

**Done when:** a running build is visible and stoppable, and a shared backend is
never silently killed for one project.

---

## Phase D5 — packaging, signing, updates

**Depends on:** D1–D3

```
config/electron-builder.config.cjs     adapted from orcabaton's
config/scripts/baton-icons.mjs         icon pipeline
.github/workflows/desktop-release.yml  the CI lane
```

**Targets:** macOS `.dmg` (arm64 + x64), Windows `.exe` (NSIS). Linux
AppImage/deb are free once the config exists — include them.

**Artifact names:** `baton-macos-${arch}.dmg`, `baton-windows-setup.exe`.

### CI lane, mirroring Orcabaton's

1. Build both workspaces (`npm run build`, `npm run build --prefix web`)
2. Run the suite — a red suite never produces an artifact
3. Stage the dependency closure (copy the `baton-dependency-closure.mjs`
   approach — a sidecar with no closure was a real bug found in Orcabaton)
4. `electron-builder` per platform on its own runner
5. Upload artifacts; on a tag, publish a release

**Signing** needs the same Apple Developer ID and Windows certificate that
Orcabaton's P7 waits on. **Ship unsigned nightlies from day one** rather than
blocking the whole lane — an unsigned build a developer can run behind a
Gatekeeper warning is worth more than no build.

### 🔴 The updater trap

Orcabaton nearly shipped an installer whose updater still pointed at upstream's
repo, which would have replaced every user's app with a different product. Do
not repeat it: the publish block must name **this** repo, and a test must assert
it. See Orcabaton's P6.

### Edge cases

| # | Case | Handling |
|---|---|---|
| D5-E1 | Native module ABI mismatch under Electron | The dependency-closure step catches it; keep its test |
| D5-E2 | Unsigned build blocked by Gatekeeper | Document the right-click-Open path in the release notes |
| D5-E3 | Updater points anywhere but this repo | Test fails the build |
| D5-E4 | Two Baton versions installed (npm + app) | The app's bundled CLI is authoritative for the app; `baton ps` from either sees the same registry, because the registry is machine-level |

**Done when:** a tagged commit produces installers for macOS and Windows, and a
fresh machine can install and start a project with no Node installed.

---

## Phase D6 — tray and lifecycle

**Depends on:** D5

- Tray icon showing a count of running projects; menu lists them with Stop.
- **Close ≠ quit** — closing the window leaves the tray running, because the
  daemons are still up. Quit asks whether to stop them.
- Optional launch-at-login, default **off**.

### Edge cases

| # | Case | Handling |
|---|---|---|
| D6-E1 | Quit with daemons running | Ask: leave running / stop all. Never silently kill work |
| D6-E2 | Machine sleeps | Re-verify on wake; do not trust pre-sleep state |
| D6-E3 | Linux tray unavailable | Degrade to a window; do not crash |

---

## Deferred, deliberately

- **White-label branding.** Wanted, but it depends on the licence decision
  (below), not on engineering. Build the app under one identity first.
- **Remote fleets.** The fleet is loopback-owner-only by design. Showing a
  colleague's daemons is a different feature with a different threat model.
- **Bundling graphify.** Blocked on the TypeScript/WASM extractor.

## 🔴 Blocked on a decision, not on code

**Baton is AGPL-3.0-or-later.** Shipping a branded installer to companies means
they can demand the source, and white-labeling does not remove that.

You own the copyright, so dual-licensing is available and standard. But
**settle it before D5 ships anything to a customer** — it decides whether this
is a product or a distribution.

## Naming — settled

Published as **`batonhq`** on npm (owner: `rakshan_shetty`). `baton-cli` on npm
is an **unrelated project by another author** — never publish to it, and do not
reference it in install instructions.

The installed command stays **`baton`**; only the package name differs. Orcabaton's
sidecar stager asserts `package.json.name === 'batonhq'` via the `not-baton`
guard, so the two repos must change this together — see
[`CONTRACT-orcabaton-desktop.md`](../CONTRACT-orcabaton-desktop.md) §4.

**Before publishing:** the repo version must exceed the published `0.1.3`, or
npm rejects it.

---

## Verification

| Layer | Command | Pass |
|---|---|---|
| Unit | `npx vitest run test/daemons.test.ts` | Fleet logic unchanged by the app |
| Fleet parity | `baton ps` vs the app | Identical rows |
| Navigation guard | `test/electron-nav-guard.test.ts` | Off-host URL refused |
| Closure | the sidecar closure test | No missing dependency under Electron's Node |
| Updater | `test/updater-target.test.ts` | Publish block names this repo |
| End to end | fresh VM, no Node installed | Install → add project → start → dashboard |
