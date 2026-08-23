# Contract: what the Orcabaton desktop app relies on

**Audience:** anyone changing `src/server.ts`, `src/daemons.ts`, or the published
`batonhq` package shape.

Orcabaton (the Orca fork at `../orcabaton`) ships a desktop client for this
daemon. It is a **separate MIT repo that never imports Baton source** — it
speaks HTTP to `127.0.0.1:<port>` and nothing else. A test
(`src/main/baton/no-baton-import.test.ts`) fails the build if anything in that
repo ever resolves a module from here.

That means every coupling between us is on this page. If you change something
below, the desktop app breaks **silently** — it reads a shape mismatch as
"Baton is not running", never as an error — so please change the version too.

## 1. Endpoints the desktop app calls

| Endpoint | Used for | Breaks if removed |
|---|---|---|
| `GET /api/meta` | discovery, identity, write-mode | app shows "Baton not running" forever |
| `GET /api/status` | the task board in the sidebar | board renders empty |
| `GET /api/events` (SSE) | live board updates | board goes static, no error shown |
| `GET /api/signals` | who is editing which file (P28) | panel says "could not ask" |
| `GET /api/presence` | teammates holding a path (P28) | rows lose remote holders; local signals still shown |
| `GET /api/kb` | graph projects, node/edge counts (P29) | knowledge section says "could not ask" |
| `GET /api/memory` | facts + Baton's freshness verdict (P29) | **whole** knowledge section says "could not ask" |
| `GET /api/blame?file=` | what touched the open file (P29) | the per-file section self-hides |
| `GET /api/kb/export` | hand a built graph to a teammate (P29) | Export reports the HTTP status |
| `POST /api/kb/import` | take a teammate's graph (P29) | Import reports the HTTP status |
| `GET /api/skills` | the catalogue + install state per agent (P30) | panel says "could not ask" |
| `POST\|DELETE /api/skills/:id/install` | install/remove a skill for one agent (P30) | the button reports the HTTP status |

### What P29 depends on inside those payloads

- **`/api/memory` must keep computing `freshness`, `staleReason` and
  `commitsBehind` per fact.** The desktop never re-derives them. A fact with
  `freshness: 'stale'` renders **withheld** — visible, marked, carrying
  `staleReason` verbatim as the "how to re-ground this" pointer. If
  `staleReason` ever became `null` for stale facts, the UI would say "do not
  trust this" and nothing about what to do instead.
- **A `freshness` value outside `fresh | aging | stale` makes the desktop refuse
  the whole payload** rather than render an unknown state as trustworthy. Adding
  a fourth level is a breaking change for this client; bump the version.
- **`/api/kb/import` may keep returning a partial success.** The desktop names
  every `path-missing` / `invalid-graph` project and prints `warnings` verbatim,
  because those strings carry the path that did not exist here. Please keep
  naming the path in the warning.
### What P31 will read (not built yet — telling you early)

`/api/handoffs`, `/api/tasks/:slug/suggest-handoff`, `/api/history`,
`/api/reviews`, `/api/reports`, `/api/doctor`. The desktop will render your
routing decision **and its reason** — `pickHandoffTarget` already returns one,
please keep it. Nothing about routing, tiers or load balancing is being
reimplemented on the desktop side; it is your logic, shown.

### Four things the P31 handoff audit found that only THIS repo can fix

Full write-up: `../orcabaton/docs/orcabaton/HANDOFF-AUDIT.md`. A sequenced fix
plan with edge cases per defect — **A1–A4 are this repo's work** — is at
`../orcabaton/docs/orcabaton/PLAN-handoff-and-graphify.md`. Two notes for
whoever picks these up:

- **A1 is the only one that unblocks anything.** Until a session brief can reach
  `done`, the desktop panel cannot honestly render the inbox, and no
  take-from-phone verb can ship.
- **A4 must be additive.** `?fields=summary` is a new parameter; the `markdown`
  and `body` fields stay, because your own dashboard reads them and mixed
  versions are the normal state.

Ranked.

- **H1 ✅ FIXED 2026-08-21 — implemented in this repo.** `closeBriefBySlug` in
  `src/handoff/resume.ts`; `baton done <slug>` falls through to it in
  `src/commands/take.ts` when the slug names a brief rather than a task.
  `setBriefStatusAt` also became crash-atomic (tmp + rename). 6 new tests in
  `test/session-handoff.test.ts`; full suite 1763 passing, lint and tsc clean.
  Deferred: auto-closing a merged derived brief (needs its own design — a false
  "done" hides live work). Original finding kept below for context.
- **H1 🔴 (original) A session brief can never be marked `done`.** `setBriefStatusAt(path,
  'done')` is exported from `src/handoff/resume.ts:88` and **no caller passes
  `'done'`** — verify with `grep -rn "setBriefStatus" src/`. The only `done`
  writer is `setBriefStatus(task.worktreePath, 'done')` at
  `src/commands/take.ts:182`, which is worktree-scoped, and `doneCmd` resolves a
  **task**, so `baton done sess-xxxx` exits `No task 'sess-xxxx'`.
  `GET /api/handoffs` is GET-only, so there is no HTTP path either.
  **Effect:** a session handoff never leaves the inbox. `/api/handoffs` filters
  `status !== 'done'` (`server.ts:2354`), and a session brief can only ever be
  `ready` or `in-progress`. Live proof in the orcabaton checkout: two briefs,
  both `status: ready`, for work that is committed **and pushed**.
  **Ask:** let `baton done <slug>` fall through to `setBriefStatusAt` when the
  slug names a brief rather than a task — or auto-close a `derived` brief whose
  recorded `head` is an ancestor of the current branch head.
- **H2 🔴 The `handoffs` ledger is write-only.** `commands/pass.ts:53` INSERTs
  with a hardcoded `status: 'ready'`; `grep -rn "UPDATE handoffs\|FROM handoffs"
  src/` returns **nothing**. Nothing updates the row, nothing reads it. This is
  the natural home for "handoffs completed", and right now every row claims
  `ready` forever. **Ask:** update on take/done, and add a read path.
- **H3 🟡 `handoff.created` is the only handoff event** (`src/events.ts:26`).
  Without `handoff.taken` / `handoff.done`, every live view has to poll to
  notice a pickup — `web/src/features/Handoff.tsx:47` polls at 30s, so two
  agents can both be looking at a brief one of them already took. **Ask:**
  publish the two missing events beside the status write. The desktop panel
  rides SSE and would pick them up for free.
- **H4 🟡 Only `derived` briefs are pruned.** `pruneOldBriefs`
  (`src/handoff/auto-session.ts:211`) caps at `MAX_AUTO_BRIEFS = 20` but counts
  only files carrying `derived: true`. A `create_handoff` brief has no such
  flag, so it is neither pruned (H4) nor closable (H1). Fixing H1 mostly
  dissolves this one.
- **H7 🟠 `/api/handoffs` returns every brief's full text.** `BriefEntry`
  carries `markdown` **and** `body` (`src/handoff/resume.ts:26`) and the handler
  sends the list unmodified. Task briefs are budgeted with progressive
  disclosure precisely because they get large. Every consumer — your dashboard,
  a phone on cellular, the P31 panel — downloads all of it to render a list of
  titles. **Ask:** a summary projection, or drop `markdown`/`body` from the list
  and let callers fetch one brief on demand.

### Two things P30 found that are worth fixing HERE

- **`skills/install.ts` never calls `gitExcludeLocal`.** `commands/snapshot.ts`
  and `handoff/brief.ts` both do; the skill installer does not. So installing a
  skill leaves `.claude/skills/<id>/SKILL.md`, `.cursor/rules/<id>.mdc` or
  `.agents/skills/<id>/SKILL.md` as **untracked, unexcluded** files in the
  user's working tree. The desktop currently warns about this in the panel,
  which is honest but is not the fix — one `gitExcludeLocal(root, target.rel)`
  after the write would be.
- **HTTP install is root-scoped.** `POST /api/skills/:id/install` calls
  `installSkill(root, …)` with the daemon's root, and `skillTargetFor` joins
  against it, so every worktree one daemon serves shares a skill set. If the
  intent was per-worktree (the desktop's spec says it was), the endpoint needs a
  worktree parameter.

- **`/api/skills` must keep returning `agents`.** The desktop derives which
  agents it may offer by intersecting with that list, and names the rest as
  unsupported. Removing it would make the panel refuse the whole payload rather
  than guess.

- **`/api/blame` is the only file-scoped endpoint**, so the desktop's "what does
  Baton know about this open file" section is built on it. `/api/kb/context` is
  project-scoped and up to 200k tokens, so it cannot be called per file
  selection.

## 2. `/api/meta` fields — three are load-bearing

The client validates the response and returns `null` on any mismatch. `null`
means *"a stranger is on this port"*, which renders as **not running**.

```ts
repo:         string   // REQUIRED, non-empty. Absolute root. Identity anchor.
version:      string   // REQUIRED.
writeEnabled: boolean  // REQUIRED. Must be a real boolean, not truthy.
branch:       string | null   // optional
pid:          number | null   // optional but IMPORTANT — see below
hub:          boolean         // optional
```

**Do not make `repo`, `version` or `writeEnabled` optional, and do not rename
them.** `writeEnabled` in particular is never guessed: the UI uses it to decide
whether to offer actions a read-only daemon would refuse.

`meta.pid` is what defeats **pid reuse**. Discovery treats a registry record as
live only when the pid is alive *and* the answering daemon reports the same pid
*and* the same root. Dropping `pid` silently downgrades that to root-only
matching (`src/daemons.ts:212-218` already documents this).

When you change any of the above, bump `package.json` version — the client
carries `EXPECTED_BATON_VERSION` and shows a one-line notice on mismatch. It is
a **notice, never a refusal**: an unexpected version still connects.

## 3. Daemon registry

`~/.baton/daemons/<pid>-<port>.json`, honouring `BATON_DAEMONS_DIR`, with at
least `{ pid, port, root }`. The desktop app scans this directory to find which
daemon serves the repo the user has open. Keep the filename shape — the port is
parsed from it.

**The desktop app never kills a daemon it did not start.** If port 7077 is
serving another repo it says so by name and offers a free port. Please keep
`nextFreePort` behaviour; a machine-wide hardcoded port would make two open
repos fight.

## 4. Published package shape (the installer bundles this)

Orcabaton bundles the daemon as a **sidecar** inside the `.dmg`/`.exe`, so users
need no Node and no `npm i -g`. The stager refuses to build rather than ship
something broken, with these codes:

| Code | Trigger — keep these true |
|---|---|
| `not-baton` | `package.json.name` must stay **`batonhq`** — the published name (`baton-cli` on npm belongs to an unrelated project) |
| `not-built` | **`dist/cli.js`** must exist (run `npm run build` before packing) |
| `missing-licence` | a `LICENSE` file must be present |
| `no-source-url` | `repository.url` must be set — it becomes the AGPL source offer |

The sidecar runs as `spawn(process.execPath, [cli, 'serve'], { env: {
ELECTRON_RUN_AS_NODE: '1' } })` — Electron's own Node v24. **Keep `dist/cli.js`
runnable on plain Node 24 with no loader flags.** It is also copied with its
full dependency closure, so a new runtime dependency is fine, but a new
*native* dependency would need a per-platform rebuild and should be raised
first.

Because the installer then contains AGPL software alongside MIT software (mere
aggregation — nothing is linked, it is HTTP), it ships `BATON-SOURCE-OFFER.md`
built from `repository.url`.

## 5. Status of the desktop side

Done and merged on the Orcabaton branch: HTTP client, hub-aware root
resolution, daemon discovery, SSE board, sidebar panel, start/stop from
Settings, sidecar bundling, fork identity, a working macOS installer, the
mobile RPC namespace (P8), telemetry excision (P20), the signals/presence panel
(P28), the knowledge + memory panel with KB export/import (P29), and the skills
catalogue with install/remove (P30).

**Two writes reach this daemon from the desktop:** `POST /api/kb/import` (P29)
and `POST|DELETE /api/skills/:id/install` (P30). Both are gated by `--write` on
your side, and both buttons are hidden or disabled when `writeEnabled` is false.
Everything else the desktop calls is a read.

Not started, and **blocked on this repo**: the fleet/settings pane needs
P15–P17, and the mobile approve-from-phone flow needs the dispatcher (P3) to
exist first. Three verbs in the mobile RPC namespace (P8) point at endpoints
this repo does **not** serve yet — `/api/plans/pending`, `/api/plans/:id/approve`
and `/api/dispatch` — and until they exist a phone reads them as
`baton_unavailable`, i.e. "no daemon running". They are P3's work.

One asymmetry worth knowing about, since it is a one-line change on our side
once you confirm the intent: `/api/tasks/:slug/agent/start` **is** served here,
but only `stop` is in the mobile allow-list — so a paired phone can stop an
agent and cannot start one. The desktop will add `start` when P31 lands, unless
starting an agent from a phone is something you would rather gate differently.
No handoff verb is exposed to mobile at all yet (H5); adding
`baton.handoffs` and `baton.handoff.suggest` needs nothing from this repo, but
a *take-from-phone* verb waits on H1, because taking a brief that can never be
closed makes the inbox worse, not better.

_Written by the Orcabaton session. Nothing here changes Baton's behaviour; it
records what would break if Baton's changed._
