---
name: stack-migration
description: >-
  Migrate a codebase from ONE tech stack to ANOTHER (e.g. Angular → Next.js, Express → NestJS,
  Vue → React, Flask → FastAPI) feature-by-feature WITHOUT losing parity or breaking the app.
  First understands the WHOLE codebase from the knowledge graph / repo map, classifies each part
  as backend or frontend, and enumerates every unit to migrate — every backend endpoint, every
  frontend route/component. Splits the migration into ORDERED PHASES (login → home → …) because
  the codebase is too large for one pass. Migrates one phase at a time following the TARGET
  stack's best practices (reusable components, props, server components, hooks) and proposes the
  standard target libraries but ⛔ ASKS before installing. Enforces DRY via a reuse index so it
  never rebuilds an endpoint/component that already exists. After each phase it verifies PARITY —
  every endpoint, edge case, and UI state reproduced — and must reach ≥95% skeptic-corroborated
  confidence before the next phase; below 95% it fixes the gap or asks the user. Persists the
  phase plan, per-phase status, confidence scores and reuse index to a committed MIGRATION.md
  ledger + shared memory so a session interrupted by a usage limit RESUMES from the exact phase
  days later with no lost context. Commits per phase but NEVER pushes without permission. Use
  whenever the user says "migrate this to <framework>", "port from X to Y", "convert this
  codebase", "rewrite in <stack>", "/stack-migration", or asks to move a project to another
  language/framework/runtime — including running the migration IN PARALLEL across multiple agents
  (Claude / Cursor / Codex / Antigravity) coordinated via baton worktrees + the coordination MCP.
---

# Stack Migration Skill (portable, phase-by-phase, resumable)

Migrate a whole codebase from one stack to another **without losing behavior and without doing it
all at once**. The order is non-negotiable:

```
LEDGER/TRACKER CHECK (is a migration already in progress? which phase? resume it) →
DISCOVER & CLASSIFY (source stack, target stack, backend vs frontend, read the graph/map) →
INVENTORY (enumerate EVERY unit: all endpoints for backend, all routes/components for frontend) →
TARGET STANDARDS + LIBRARY PROPOSAL → ⛔ ASK BEFORE INSTALL ⛔ →
PHASE PLAN (split the inventory into ordered phases) → write MIGRATION.md ledger →
⛔ APPROVE PLAN ⛔ →
┌─ FOR EACH PHASE (one at a time) ──────────────────────────────────────────────┐
│ RE-READ ledger + reuse index (DRY) → MIGRATE this phase unit-by-unit           │
│ (endpoint-by-endpoint / route+component-by-component) →                        │
│ DRY / TARGET-BEST-PRACTICE QUALITY GATE →                                      │
│ PARITY VERIFY (every unit + every edge case + every UI state reproduced) →     │
│ ⛔ CONFIDENCE ≥95% GATE (skeptic-corroborated) ⛔                               │
│   <95% → fix the missing endpoint/component/edge-case, re-verify               │
│   can't reach 95% (ambiguous / missing info) → ⛔ ASK THE USER ⛔               │
│ UPDATE ledger + reuse index + shared memory → COMMIT this phase (auto) →       │
│ ⛔ ASK BEFORE PUSH + PR ⛔ →                                                    │
│ BEFORE starting the next phase: RE-CHECK the previous phase is still ≥95%      │
└───────────────────────────────────────────────────────────────────────────────┘
  ⇅ (optional) PARALLEL FAN-OUT — ONLY after the foundation phase is done + committed:
    independent phases → one baton worktree each → run in parallel across agents
    (Claude / Cursor / Codex / Antigravity), reuse index FROZEN, coordinate live over
    baton (check_files / signals / progress) or a self-contained HANDOFF file, notify the
    user to launch the other agents → serial MERGE + DRY-DEDUP + skeptic ≥95% on the whole
→ FINAL FULL-PARITY SWEEP across all phases → COMPACT IF NEEDED
```

**Golden rules**

0. **RESUMABLE FIRST, RECORD LAST — at UNIT granularity.** Before anything, read the migration
   ledger (`MIGRATION.md` at the repo root) and shared memory (baton) to see whether a migration is
   already underway and **which units are done** — not just which phase. If so → **continue from
   the first un-migrated unit, never restart**. A usage limit, a crash, or "I'll come back in two
   days" must cost you nothing, even if it hits **mid-phase**. So tick each unit in the ledger **as
   it lands** (not batched at phase end) and commit incrementally, so an interruption after unit 10
   of 20 resumes at unit 11. `MIGRATION.md` is the **single source of truth** for status; baton
   memory holds only pointers + gotchas, never authoritative status. *(This repo's tracker is
   **baton** — on a usage limit run `baton pass` to write a handoff brief and `baton resume` to pick
   it up next session; see "Working with baton" below. No tracker → the committed `MIGRATION.md`
   alone is the source of truth.)*
1. **UNDERSTAND THE WHOLE CODEBASE BEFORE MIGRATING ONE LINE.** Use the knowledge graph / repo
   map (graphify / CODEBASE.md) to see the full structure. Classify each area as **backend** or
   **frontend**, identify the **source** and **target** stack, and **enumerate every unit** you
   must migrate. You cannot migrate what you have not inventoried.
2. **NEVER MIGRATE EVERYTHING IN ONE PHASE.** The codebase is large (often 100+ files). Split the
   inventory into **ordered, shippable phases** (e.g. login → home → …). One phase = one coherent
   feature/area.
3. **ONE PHASE AT A TIME; ≥95% BEFORE THE NEXT.** A phase is done only when its parity is
   verified AND an independent skeptic corroborates ≥95% confidence. Below 95% → close the gap
   first. Never start phase N+1 with phase N unfinished.
4. **PARITY MEANS BEHAVIORAL + INFORMATION PARITY — verified against a recorded oracle, not by
   eyeball.** Every endpoint's request/response shape, every edge case, every UI state, data, and
   interaction in scope must be reproduced — measured against **recorded golden-master fixtures**
   (captured from the source before you migrate), not a manual tick. Parity is *behavioral*, **not
   pixel-perfect**: the target uses its own design system, so match the data, states, copy, and
   interactions — visual layout is "equivalent per the target's idioms", not a Material clone. "It
   renders" is not parity.
5. **DRY / REUSE — check the reuse index every phase.** Before writing a new endpoint, hook,
   component, type, or util in the target, check the **reuse index** for one that already exists
   and **reuse it**. Never rebuild a login form, an auth guard, a data-fetching hook, or a shared
   endpoint twice. If the same logic appears 2+ times → extract it to a shared unit and index it.
6. **FOLLOW THE TARGET STACK'S BEST PRACTICES.** Write idiomatic target code (e.g. Next.js
   app-router + server components + React Query/`fetch`; React props/composition; NestJS
   modules/DI) — not a literal line-by-line transliteration of the source. **Propose** the
   standard target libraries with install commands and **⛔ STOP for approval before installing.**
7. **DON'T BREAK WHAT WORKS.** Keep the source app runnable during the migration; the target must
   **compile / typecheck / pass tests** at the end of every phase. Leave the tree no more broken
   than you found it.
8. **<95% OR AMBIGUOUS → ASK, DON'T GUESS.** If you can't confirm parity, or a business rule /
   design decision is unclear, **STOP and ask the user** rather than inventing behavior.
9. **THE LEDGER IS THE SOURCE OF TRUTH.** Update `MIGRATION.md` (phase plan, status, confidence,
   reuse index) + shared memory after every phase. Keep it accurate — the next session trusts it.
10. **COMMIT PER PHASE (auto), NEVER PUSH WITHOUT PERMISSION.** One phase = one (or a few atomic)
    commits with a clear message. Explicitly ask about push AND PR (and the base branch) together.
11. **PARALLELIZE ONLY AFTER THE FOUNDATION — AND ONLY INDEPENDENT PHASES.** A migration can run
    many agents at once (Claude, Cursor, Codex, Antigravity), but **never before the shared
    foundation phase is done and committed** — otherwise every agent rebuilds the same
    Button/API-client/auth (DRY disaster + merge hell). After foundation, fan out **only phases that
    share no *unbuilt* unit**, each in its own **baton worktree** (isolated branch → no ref
    collisions), coordinating live over baton (`check_files` / `signals` / `progress`) or — for an
    agent without baton wired — via a **self-contained HANDOFF file** with the human as message bus.
    During fan-out the **reuse index is frozen** (agents consume it, never add to it). Re-integrate
    with a **serial merge + DRY-dedup + skeptic gate**. Serial is the safe default; parallelize when
    the plan shows independent phases and you have agents to spare. See **Parallel multi-agent mode**.
    **A deadline, a demo, or a human ordering "fan out now" does NOT waive this gate** — the merge
    cost of four agents rebuilding the same Button/API-client/auth always exceeds the time saved, and
    that cost lands at the worst moment (the night before the demo). **Uncommitted or 70%-done
    foundation = NO foundation for fan-out purposes** — "basically done" does not count; only a
    committed foundation with its units in the reuse index unlocks fan-out. If a human directs an
    unsafe early fan-out, **do not silently comply and do not silently refuse**: state the concrete
    cost in writing (which shared units get rebuilt, where the merge breaks) and hold the commit-the-
    foundation gate — finishing + committing the foundation first is the *faster* path, not the
    cautious one.

> **Adapt to the project.** This skill is stack-agnostic. Wherever it says "the graph", "the test
> command", "endpoint", "component", or "the target library", substitute this project's actual
> source stack, target stack, and tooling. Anything marked *(optional)* is skipped if the project
> lacks it — never invent infrastructure that isn't there.

---

## Phase A — Resume check: is a migration already in progress? ⛔ DO THIS FIRST ⛔

*Why first: this skill is explicitly built to survive interruptions (usage limits, days between
sessions, multiple agents). Restarting a half-done migration wastes the most tokens and risks
double-migrating a feature. Always resume; never restart.*

0. **Were you handed a HANDOFF file? (parallel worker path.)** If your prompt includes — or the
   worktree root contains — a `HANDOFF-*.md` whose frontmatter is `type: stack-migration-handoff`,
   **you are a parallel migration worker, not the coordinator.** Do NOT run the full discovery/plan.
   Read that file: work **only** the units in its §2, **only** inside its `worktree`/`branch`, reuse
   (never rebuild) everything in its frozen reuse index, commit per unit, **never push**, and when
   done or blocked report back to the human coordinator. Skip straight to that phase's F loop. Do not
   edit `MIGRATION.md` — the coordinator owns it. (No handoff → you're the coordinator; continue.)
   **Before writing any code, run TWO checks:** (i) **currency** — `git fetch` then
   `git log <foundation_sha>..origin/<merges_into>` (the `foundation_sha` is in the frontmatter); if
   the migration branch advanced past it, the foundation moved (a shared unit was added, or an indexed
   signature like `apiClient(path)`→`apiClient(path, opts)` changed) → **STOP and re-request an updated
   handoff** rather than coding against a stale base that only breaks at merge; (ii) **signature match**
   — for each reuse-index unit you'll call, confirm your worktree's copy matches the signature pinned in
   §3; a mismatch means your branch is stale → STOP. Then set the handoff's `status: picked-up` (and
   `in-progress` once coding) and commit it, so the coordinator sees your progress via `baton status`.
   If you hit a usage limit mid-phase, don't just stop — use the **handoff** skill (`baton pass`) to
   package the remaining units + `resume_from_unit` so a fresh session continues THIS phase.
1. **Read the ledger.** Open `MIGRATION.md` at the repo root (see `references/MIGRATION.template.md`).
   If it exists, it tells you: the source→target stacks, the full phase plan, each phase's
   **status** (`todo` / `in-progress` / `done`), each done phase's **confidence score**, and the
   **reuse index**. Identify the first phase that is not `done` — that is where you continue.
2. **Ask shared memory** *(if baton is present)* — `baton status` / recall memory for this
   migration: root decisions, gotchas, the library set already approved, and any phase notes.
   `baton signals` / `check_files` → is another session editing the target files right now? If so
   → coordinate before touching them.
3. **Confirm the code matches the ledger, at unit level.** Verify the units marked done actually
   exist in the target (files/routes there and compiling). If ledger and code disagree, trust the
   code, fix the ledger, and note it — never migrate a unit twice. For a phase left `in-progress`,
   the ledger's per-unit ticks tell you the exact unit to resume at (rule 0); if ticks are missing,
   reconstruct from the target files + last commit before continuing.
4. **Check for source drift** (the "days later" trap). The ledger records the **source commit SHA**
   the inventory was taken at. Run `git log <sha>..HEAD` over the source paths: if anyone changed
   the source app during the migration, **re-open the inventory** for the new/changed units and add
   them to the right phase — otherwise a feature added to the source silently never migrates, and
   the 95% gate (which checks the *stale* inventory) can't catch it. **The same drift trap applies to
   the FOUNDATION during a parallel fan-out:** if the coordinator advanced the migration branch's
   foundation after a handoff was cut (added a shared unit, changed an indexed signature), any worker
   branched from the old foundation is stale. So drift-check runs on **two** anchors — the source SHA
   (features added to the source) and the `foundation_sha` (shared layer moved under a parallel
   worker); a frozen reuse index is exactly a "days later" trap for the shared layer.
5. **Decision:**
   - Ledger exists with unfinished work → **resume at the first un-migrated unit** (skip to the
     per-phase loop, Phase F). Re-read that phase's scope from the ledger.
   - Ledger exists, all phases `done` → run the **final full-parity sweep** (Phase G) and stop.
   - No ledger → this is a fresh migration → continue to Phase B.

---

## Phase B — Discover & classify (understand the WHOLE codebase)

*Why: you migrate the structure, not individual files in isolation. You must know what the app is,
what it talks to, and which parts are backend vs frontend before you can phase it.*

1. **Read the map, not the whole repo.** Use the knowledge graph / repo map *(graphify /
   `CODEBASE.md` / `baton kb` if present)* to get the top-level structure, entry points, and the
   dependency edges cheaply. No map? Build a quick one with `find` + `grep` + reading entry points
   (`package.json`, router config, main/server file) — but prefer the graph.
2. **Name the source and target stack precisely.** Source e.g. "Angular 14 + RxJS + NgModules +
   Angular services calling a REST API". Target e.g. "Next.js 14 app-router + React 18 + server
   components + TypeScript". If the target is only loosely specified ("move to Next"), **ask the
   user** to pin the version and the key conventions (app-router vs pages, state lib, styling).
   **Note any shared substrate** between source and target (React under Next.js; Node under both
   Express→NestJS; Vue 2→3): where they share a runtime/library, many units **port in place** — lift
   the existing component/module, strip the source-framework glue, rewire data-fetching — instead of
   a rebuild. Port-in-place units are cheap and the most parallelizable; flag them in the inventory
   (Phase C) and they enlarge the reuse surface a fan-out can consume.
3. **Classify every area as BACKEND or FRONTEND** (a repo may have both):
   - **Backend** = HTTP/RPC handlers, controllers, services, models, DB access, auth, jobs.
   - **Frontend** = routes/pages, components, view state, client data-fetching, styling.
   Record the split. The two are inventoried and phased differently (Phase C).
4. **Trace the boundaries that must stay stable.** If you're migrating only the frontend, the
   backend API contract is fixed — the migrated frontend must call the same endpoints with the
   same shapes. If migrating only the backend, existing clients must keep working. Note every
   cross-boundary contract; these are your parity anchors.
5. **Record the source commit SHA** (`git rev-parse HEAD` on the source) in the ledger — the
   inventory in Phase C is taken against this snapshot, and Phase A step 4 uses it to detect source
   drift on resume. Note whether the source is frozen for the migration; if not, drift checks matter.
6. **Decide the coexistence model** (where the target lives + how a partly-migrated app is served),
   and record it: new project vs same-repo subfolder, and cutover strategy — big-bang at 100%, or a
   **strangler** reverse-proxy routing migrated paths to the target and the rest to the source so
   each phase is genuinely shippable. This decides what "shippable phase" means in the ledger.

---

## Phase C — Inventory: enumerate EVERY unit to migrate

*Why: "migrate the app" is unmeasurable. "Migrate these 150 endpoints and these 40 routes" is a
checklist you can drive to 100%. The inventory is what parity is measured against.*

### If BACKEND — enumerate every endpoint (and its contract)
- List **every route/endpoint** (method + path) across every controller/router. Grep the route
  registrations; cross-check against the graph so dynamic/programmatic routes aren't missed.
- For each endpoint capture: method, path, **auth/permissions**, request shape (params, query,
  body), **response shape**, status codes, side effects (DB writes, jobs, external calls), and
  known **edge cases** (validation, pagination, error branches).
- Record the count ("150 endpoints"). This becomes the backend checklist — each endpoint is a
  unit that must be reproduced and ticked off, one by one.

### If FRONTEND — enumerate every route, component, and its behavior
- List **every route/page** and, under each, the **components** it renders. Note shared/reusable
  components (used by many routes) separately — these become reuse-index entries.
- For each route/component capture: the **endpoints it calls**, its **props/inputs**, local vs
  global **state**, **UI states** (loading / empty / error / success), forms + **validation
  rules**, guards/redirects, and every **interaction** (clicks, navigation, edge cases).
- Understand the target's component model (React: function components + props + hooks + composition
  of reusable components) so the inventory maps onto idiomatic target units, not a 1:1 copy.
- Record the count ("40 routes / ~120 components"). This is the frontend checklist.

### ALSO enumerate CROSS-CUTTING concerns (they map to no route/endpoint — and get dropped)
Most silent migration breakage is here, because these don't show up as an endpoint or a component:
- App shell / layout, root providers, routing config, 404 / 500 / error pages, error boundaries.
- HTTP interceptors → target middleware/fetch-wrapper; **auth guards** → target middleware/route
  protection; request/response transformers.
- Env vars + config, feature flags, i18n/localization, analytics/telemetry, SEO/meta tags,
  service workers/PWA, global styles/theme tokens.
- Build/CI config, proxy/rewrite rules, deployment.
Add these as their own inventory category and phase them (usually into the foundation phase).

### Record the parity oracle (golden master) — BEFORE migrating
*Why: parity checked by hand across 150 units doesn't scale and misses things. Capture the source's
real behavior now, while it still runs, so each migrated unit is verified against a fixture, not a
memory.*
- **Backend:** capture real request→response fixtures per endpoint (curl / a recording proxy) into
  `references/fixtures/` — method, path, sample inputs, exact response body + status. The migrated
  endpoint must return the same shapes for the same inputs.
  *Recipe:* a small loop over the endpoint list saving each response —
  `while read m p; do curl -s -X $m "$BASE$p" -H "$AUTH" -o "references/fixtures/${p//\//_}.json"; done < endpoints.txt`
  — then commit the folder. **Capture one fixture per enumerated edge case, not just the happy path**
  (a restricted/age-gated record, a closed/inactive one, an empty list, an error, an auth-redirect); a
  fixture set that only hits the benign record is *vacuously green* at F5 (see F5 step 0).
- **Frontend:** script a Playwright flow per route and capture reference screenshots + the network
  calls each route makes. The migrated route must drive the same flow and make the same calls
  (behavioral parity — screenshots are a reference for data/states/copy, not a pixel gate).
  *Recipe:* `npx playwright codegen <source-url>` to record the flow into a spec, and capture the
  network log (`page.on('request', …)` or the trace viewer) as the reference call list.
- No time/tooling for full capture → at minimum record the response shape + the key states per unit
  in the ledger, and say so — a documented gap, never a silent one.

**Completeness gate:** the inventory is not done until every route registration / component file /
cross-cutting concern is accounted for, and a parity oracle (fixture or documented shape) exists
for each unit. A missed unit is a feature that silently disappears in the migration.

---

## Phase D — Target standards + library proposal (⛔ ask before install ⛔)

*Why: a migration that ignores the target's idioms produces "Angular written in React syntax" —
technically running, but unmaintainable. Pick the standard toolset up front, once.*

1. **Research the target stack's best practices and standard libraries** for the concerns this app
   needs — routing, data fetching/caching, forms + validation, state, styling, auth, testing.
   (E.g. Next.js app-router → server components + `fetch`/React Query, Zod for validation,
   React Hook Form, a UI kit like shadcn/ui, etc. NestJS → modules + DI + class-validator.)
2. **Propose them to the user with exact install commands** and a one-line reason each. If the
   project already pins a toolset (check `package.json` / lockfile / existing target scaffold),
   prefer that and only propose gaps.
3. **⛔ STOP — do not run any install until the user approves the dependency list.** On approval,
   install; otherwise adjust to what they want. Record the **approved library set** in the ledger
   so later phases reuse it and don't re-litigate or add rogue deps.
4. **Mid-migration additions are expected, not forbidden.** You'll discover a needed lib (charts,
   drag-and-drop, date picker) at a later phase. When you do → **STOP, propose it, get approval,
   then add it to the ledger's approved set** and continue. The rule forbids *unapproved* deps, not
   *new* ones — never silently `npm install` something outside the recorded set.

---

## Phase E — Phase plan + ⛔ APPROVAL GATE ⛔ (write the ledger, then stop)

*Why: the phase plan is the backbone of the whole migration and the thing that makes it resumable.
It must be approved before any code is written.*

1. **Split the inventory into ordered phases.** Each phase is a coherent, independently verifiable
   slice — usually a feature/area (auth/login → home/dashboard → …) plus the shared foundation it
   needs. Order by dependency: foundational/shared units (design system, auth, API client, shared
   types) come first so later phases reuse them (DRY). Keep phases small enough to finish and
   verify in one working session where possible. **Mark each phase's `depends-on` and its
   `parallel-group`:** the foundation phase is serial and first; after it, any two phases that share
   no *unbuilt* unit can run in the same parallel group (see **Parallel multi-agent mode**). If two
   otherwise-independent phases both need the same *not-yet-built* shared unit, either pull that unit
   into the foundation phase or assign it to one phase and make the other `depends-on` it — so the
   plan shows exactly what can fan out. **Also list the shared-write manifest files** each phase must
   append to (route/nav registry, i18n bundle, DI/module list, barrel `index.ts`, `package.json`) — two
   parallel phases writing the same manifest is a guaranteed merge conflict the reuse-index freeze does
   NOT prevent, so flag them now and plan to split them into per-feature fragments in the foundation
   (see Parallel mode Step 1b).
2. **For each phase, list its exact units** from the inventory (which endpoints / which
   routes+components) and its parity criteria. **Foundation phases** (API client, auth, design
   system, shared types, cross-cutting concerns) have no user-facing behavior, so the ≥95%
   *parity* gate doesn't apply the same way — their done-criterion is: **unit-tested, typechecks,
   and consumed by ≥1 later phase.** The ≥95% parity gate applies to **feature** phases.
3. **Write `MIGRATION.md`** (from `references/MIGRATION.template.md`) at the repo root: source→target
   stacks, approved libraries, the ordered phase table (with `status` + `confidence` columns), and
   an empty **reuse index** to be filled as shared units are built. This file is committed and is
   the resumable source of truth.
4. **⛔ Present the plan (phases, order, per-phase units, library set) and STOP. Do not migrate any
   code until the user explicitly approves.** If they want reordering or rescoping, revise and
   re-ask. (In Claude Code plan mode, use ExitPlanMode to request approval.)

---

## Phase F — The per-phase migration loop (repeat for each phase, one at a time)

> Run this whole loop for **one** phase, take it to ≥95%, commit, then move to the next. Do **not**
> batch phases.

### F1 — Re-sync + re-read (DRY starts here)
- **Re-read the ledger** for this phase's exact scope, and **read the reuse index** — every shared
  component/hook/endpoint/type already built. You will reuse these, not rebuild them.
- If the tracker is present, re-check `signals`/staleness so you're not colliding with another
  session, and confirm you're on the migration branch.

### F2 — Migrate this phase's units, one by one
- **Backend phase:** migrate **endpoint by endpoint**. For each: reproduce the route, auth,
  request/response shape, validation, side effects, and every status/error branch in the target's
  idiom. Tick it off the checklist. Reuse shared services/middleware/DTOs already built — don't
  duplicate them.
- **Frontend phase:** migrate **route + components**. Build reusable target components (props +
  composition), wire the **same endpoints** with the same shapes, reproduce every UI state
  (loading/empty/error/success), form validation, guards, and interactions. Match the UI (layout,
  copy, behavior) unless the user asked for a redesign. Reuse indexed components; extract new
  shared ones and add them to the index.
- **Follow the target best practices from Phase D** — idiomatic, typed, no `any` where a real type
  exists, no dead/commented code, no secrets or debug logging left behind.
- **Checkpoint every unit as it lands** (rule 0): tick it in the ledger's per-unit list and commit
  incrementally (`feat(migrate): <phase> — <unit>`). This is what makes a mid-phase interruption
  resume at the next unit instead of losing the whole phase. Never batch all ticks to phase end.

### F3 — DRY / best-practice quality gate
- **No duplication:** grep the target for the behavior before adding it; reuse the existing
  helper/component/endpoint. Same logic in 2+ places → extract + index it.
- **No avoidable calls:** don't call an endpoint in a loop (batch it), don't re-fetch data already
  in state/cache, debounce rapid handlers, clean up subscriptions/effects, no N+1 queries.
- **Idiomatic target code:** follows the target framework's conventions (layering, data flow,
  error handling, typing). If the cleanest result needs a small shared refactor beyond this
  phase's units → note it in the ledger and fold it in, don't silently sprawl scope.

### F4 — Parity verify (the core check)
1. **Verify every unit against its recorded oracle** (Phase C fixtures) — replay the endpoint
   fixtures and assert the same response shapes/status; replay the Playwright route flow and assert
   the same network calls + states. No endpoint / route / component / cross-cutting concern left
   unmigrated. Where only a documented shape exists (no fixture), check against that.
2. **Reproduce each edge case & UI state** and confirm it behaves as the source did (validation,
   errors, empty states, auth redirects, pagination…).
3. **Contract parity across the boundary:** migrated frontend calls the same endpoints with the
   same request/response shapes; migrated backend returns the same shapes existing clients expect.
4. **Compile / typecheck / lint / run tests** with the target's commands. Author (or port) a
   test/fixture-assertion per migrated unit so "tests pass" actually means parity, not vacuously
   true. Launch the target app and exercise this phase's flow — observe behavior, don't just trust
   the build.
5. **Re-run the source** for the same flow if anything is ambiguous, and diff the behavior against
   the oracle.

### F5 — ⛔ Confidence ≥95% gate (skeptic-corroborated) ⛔
*Why an independent check: self-graded "looks done" is unreliable — a second agent with fresh
context catches the endpoint you forgot and the edge case you rationalized away.*

⛔ **The skeptic run is MANDATORY and NON-WAIVABLE for every feature phase — regardless of
build/test/lint status.** A green build, a high self-score, and a manual click-through are NEVER
substitutes for the skeptic and never lower its necessity. You may not record a phase `done` without
a score from an agent you did **not** instruct to agree with you. "Everything is green, the skeptic
feels like ceremony" is the **exact condition the gate is designed for** — a green build most often
means your *fixtures* miss the failing edge case, so skipping is highest-risk precisely when it feels
lowest-risk. "It renders / tests pass" is not parity; `skeptic-corroborated` means an adversary
independently re-derives and may **overrule** you, not a rubber-stamp of your number.

0. **Fixture-adequacy pre-check (before you score).** Confirm the oracle fixtures actually exercise
   **each enumerated edge case** for this phase — restricted/age-gated, closed/inactive, empty, error,
   auth-redirect, pagination boundaries — not just the happy-path tenant/record. Fixtures recorded from
   a single benign tenant are **vacuously green**: they pass while the edge case silently breaks. If a
   fixture for an enumerated edge case is missing, capture it (or record the gap) **before** scoring —
   a phase whose fixtures only hit the happy path cannot exceed the skeptic's score. The skeptic
   re-derives edge cases from the **SOURCE**, not from your fixtures.
1. **Score your own confidence** that this phase reproduces **100% of its inventoried units + edge
   cases** with clean, DRY, idiomatic target code.
2. **Spawn an independent read-only skeptic agent** (`Read`/`Grep`/read-only `Bash`, **no
   Edit/Write**, fresh context). Give it read access to **both the source app and the migrated
   diff**, plus this phase's inventory checklist and oracle fixtures. Have it **re-derive the
   inventory from the source independently** (so it catches units your checklist missed, not just
   ones on it), then **hunt for**: a missing endpoint/route/component/cross-cutting concern, an
   unhandled edge case or UI state, a dropped validation/auth rule, a broken contract, **duplicated
   code that should reuse an indexed unit, and avoidable/duplicate API calls or N+1s.** It returns a
   **0–100 score — defined as P(no missing unit / dropped edge case / broken contract) — plus the
   specific gaps** it found.
3. **Final confidence = the LOWER of your score and the skeptic's.**
4. **Decision:**
   - **≥95%** → phase passes → go to F6.
   - **<95%** → **fix the specific gaps the skeptic named** (migrate the missing unit, add the
     edge case, dedupe against the reuse index), then **re-run F4–F5**. Repeat until ≥95%.
   - **Can't reach 95%** because a business rule / design decision / source behavior is genuinely
     **ambiguous or undocumented** → **⛔ STOP and ask the user** the specific question. Never
     invent behavior to inflate the score.

### F6 — Record + commit this phase
1. **Update `MIGRATION.md`:** set this phase `status: done` + its final confidence score; add every
   new shared unit to the **reuse index** (name → target path → **current signature** → what it does)
   so later phases reuse it. Update inline docs / the target's architecture docs if new surface was
   added. **A `done` row REQUIRES a recorded skeptic score** (and the skeptic run's note). Any unit
   marked `deferred` / `out-of-scope` **requires explicit user sign-off recorded in the ledger** —
   a self-granted "deferred to a later wave" does **not** count and is treated by the gate as a
   **missing unit** (it must clear F5, or the user must sign off in writing).
2. **Write shared memory** *(if baton present)* — `save_memory`: the phase, what was migrated, the
   approved libraries, and any non-obvious gotcha (a tricky contract, a reused component, a
   deviation the user approved). Refresh the graph/`CODEBASE.md` if new surface was added.
3. **Commit automatically** (project's git author, only this phase's files). Conventional Commits:
   `feat(migrate): port <phase> to <target>` with a body naming the units migrated + reuse notes.
   Never `-m "wip"`. One phase = one atomic commit (or a few genuinely separable ones).
4. **⛔ Do NOT push. Ask about push AND PR together** (and which base branch) — push/PR only on the
   user's explicit yes.

### F7 — Regression-check prior phases before starting the next
Before opening phase N+1, **run the full build/typecheck + the accumulated automated oracle suite**
(all recorded fixtures + Playwright flows from every prior phase). This is cheap and catches any
regression the new work introduced — far more reliable than manually re-eyeballing each old phase,
and it stays O(1) effort as phases grow. Any failure → fix before proceeding. Then loop to F1.

---

## Parallel multi-agent mode (optional — foundation-gated fan-out)

*Why: a migration is embarrassingly parallel **once the shared foundation exists** — independent
feature phases (Orders, Menu, Reports…) touch different files and can be migrated at the same time
by different agents (Claude, Cursor, Codex, Antigravity), each in its own baton worktree. This is
where baton earns its keep: isolated worktrees mean no git ref collisions, and the coordination MCP
lets the agents see each other live. Done right it multiplies throughput; done wrong (fanning out
too early) it triplicates the design system and creates merge hell. Serial is always safe — reach
for this only when the plan shows genuinely independent phases and you have agents to spare.*

**⛔ Preconditions — all must hold before you fan out:**
- The **foundation phase is `done` and committed** (API client, auth, design system, shared types,
  cross-cutting concerns) and its shared units are in the reuse index. No foundation → no fan-out.
- **≥2 phases in the same `parallel-group`** (Phase E) — i.e. sharing no *unbuilt* unit.
- You have **agents to run them** (extra Claude Code sessions, Cursor, Codex, Antigravity) and a way
  to coordinate (baton MCP wired into each, or the human relaying handoffs).

### Step 1 — Freeze the reuse index
During fan-out the reuse index is **read-only**: parallel agents **consume** shared units, they do
**not** add new ones. If an agent discovers it needs a *new* shared unit mid-phase, that phase
wasn't truly independent → **STOP, flag it** (`baton progress` + notify the user), and either pull
the unit into the foundation (build it once, serially, then resume the fan-out) or assign it to
exactly one agent that the others `depends-on`. This is the single rule that keeps two agents from
both inventing `<Modal>` and colliding at merge.

### Step 1b — Conflict pre-check: the shared-write files (do this BEFORE generating handoffs)
The frozen reuse index stops two agents *rebuilding* the same component — it does **nothing** about
two agents **both appending to the same hand-maintained central file**. Those are a guaranteed merge
conflict, and the freeze rule doesn't see them. So before fan-out, **compute each parallel phase's
projected target file-set** (from the inventory → target-path mapping) and **diff the sets**. Any file
two phases both write is a **shared-write file** — most often a central *manifest*:
- a route/nav registry (`nav-registry.ts`, `routes.ts`), an i18n bundle (`en.json`), a DI/module list,
  a barrel `index.ts`, a theme/tokens file, and especially **`package.json` / lockfile**.

For **each** shared-write file, pick one strategy and record it in the plan + every affected handoff:
1. **Split into per-feature fragments** (preferred) — refactor the manifest to import/spread per-feature
   files (`orders.routes.ts`, `i18n/en/orders.json`); each agent writes only its own fragment. Do this
   **in the foundation, serially, before fan-out.** The one shared stitch line (the imports) is the
   coordinator's.
2. **Coordinator-owned** — the coordinator is the sole editor; agents never touch it and the coordinator
   stitches their entries at the serial merge.
3. **Deps go through the coordinator** — `package.json`/lockfile edits are never done in parallel (two
   installs = lockfile conflict). Any new dep is proposed to the coordinator, added once, and the change
   propagates to worktrees before they install.

Guard every shared-write path with baton (`touch_files` / `check_files` / `who_touched`) and state in
each handoff which fragment/namespace that agent owns and that the shared roots are off-limits. A
phase whose *only* overlap was a manifest is still parallelizable **once you've split or assigned it**;
a phase that overlaps another on real feature files is not independent — re-scope it.

### Step 2 — One worktree + one agent per phase
- For each parallel phase: `baton new "migrate: <phase>"` → an isolated branch **+ worktree**. Each
  agent works only in its own worktree; branches never touch until the serial merge (Step 6).
- **Wire the coordination MCP into every agent** with `baton connect` (Claude Code, Cursor, Codex,
  and other MCP-capable tools). Now every agent can call `check_files` before editing a shared file,
  `list_signals` / `who_touched` to see who's on what, and `report_progress` to announce intent —
  **that is the live "agents interact with each other" layer.**

### Step 3 — ⛔ ASK the user which agent takes each parallel phase ⛔
You can't launch other agents yourself — the **user** does. So don't silently pick; **present the
parallel-eligible phases and ask, per phase, who runs it.** Offer concrete choices:
- **This Claude session** (you keep it) · **Another Claude Code session** · **Cursor** · **Codex** ·
  **Antigravity** · **Not now — keep it serial**

In Claude Code use **AskUserQuestion** — one question per parallel phase, options = the agents (with
a recommended default, e.g. "I take Orders; assign Menu + Reports to two others"). Record each
phase→agent assignment; it drives which files you generate in Step 4 and the launch lines in Step 5.

### Step 4 — Generate ONE handoff file per parallel phase (flagged + self-contained)
For **each phase assigned to another agent**, write a **separate** `HANDOFF-<phase>.md` at the repo
root from `references/HANDOFF.template.md`. **2 parallel phases → 2 files** (`HANDOFF-menu.md`,
`HANDOFF-reports.md`); the user copies each into its own agent. Every file MUST be:
- **Flagged for identification** — it opens with a **YAML frontmatter block**
  (`type: stack-migration-handoff`, `phase`, `worktree`, `branch`, `merges_into`, `depends_on`,
  `parallel_group`, `resume_from_unit`, `target_agent`, `never_push: true`, plus two coordination
  fields below) + a **⚑ START HERE** line. Any agent that opens the file instantly knows it's a
  migration handoff, which worktree/branch to work in, and to work **only** its phase's units. (An
  agent that has this skill detects the frontmatter in Phase A and jumps straight to that phase's
  F loop — see Phase A.)
- **Stamped with `foundation_sha`** — record the exact **foundation commit** the reuse index was
  frozen at. The receiving worker's **first action** is a currency check: `git fetch` then
  `git log <foundation_sha>..origin/<merges_into>` — if the migration branch has advanced past that
  SHA, the foundation moved (a shared unit was added or an indexed signature changed) and this
  handoff is **stale** → STOP and re-request an updated handoff, do not code against a stale base.
  This is what catches the silent "coordinator changed `apiClient(path)` → `apiClient(path, opts)`
  two days ago" break that a green local typecheck would otherwise hide until merge. (For the same
  reason the frozen reuse index pins each unit's **current signature**, not just its name — §3 —
  so a worker diffs against a spec, not a guess.)
- **Carries a `status` field the worker updates** — `status: ready → picked-up → in-progress → done`
  (plus `confidence` + `resume_from_unit` as it progresses). The worker flips it and commits it inside
  its worktree; the coordinator reads it via `baton status` instead of the human relaying "I started"
  / "I'm done." This closes the manual message-bus loop (Step 5).
- **Self-contained** — the receiver may lack baton memory/graph and cannot `recall_memory`, so embed
  everything inline: target stack + approved libs, THIS phase's exact units, and **every edge case +
  UI state PER unit** — the actual validation rules, error branches, empty/loading/success states,
  auth redirects, pagination — not just unit names. Plus the parity oracle, the **frozen reuse
  index** ("build none of these"), the parity checklist, and the ≥95% gate.
- **Tailored to the assigned agent** (Step 3) — include that tool's launch line (Step 5 table).

### Step 5 — Guide the user: copy-paste launch + collaboration
Print an explicit, per-file call to action the user can follow mechanically. Example:
> **Foundation is committed.** 3 independent phases (`group 1`):
> • **Orders** → *I'll take this* in `.baton/wt/migrate-orders`.
> • **Menu → another Claude session:** `cd .baton/wt/migrate-menu && baton connect && claude`, then
>   paste **`HANDOFF-menu.md`**.
> • **Reports → Cursor:** open `.baton/wt/migrate-reports` in Cursor, run `baton connect` in its
>   terminal, paste **`HANDOFF-reports.md`** into the chat.
> Ping me when one finishes — I merge + dedup one at a time.

**Agent launch cheatsheet** (how the user feeds a handoff to each tool — all first `cd` into the
phase's worktree so the work lands on the isolated branch):

| Assigned agent | How the user launches it |
|---|---|
| Another Claude session | `cd <worktree> && baton connect && claude`, then paste the `HANDOFF-<phase>.md` contents (or `claude "$(cat HANDOFF-<phase>.md)"`). |
| Cursor | Open `<worktree>` in Cursor → run `baton connect` in its terminal → paste `HANDOFF-<phase>.md` into the chat. |
| Codex | `cd <worktree> && baton connect && codex`, then paste `HANDOFF-<phase>.md`. |
| Antigravity | Open `<worktree>` → wire the baton MCP (`baton connect`) → paste `HANDOFF-<phase>.md`. |

Then each agent (you included) runs the **Phase F loop** for its own phase inside its worktree,
using `check_files`/`signals`/`progress` to stay off each other's shared files. Delete each
`HANDOFF-<phase>.md` once that phase is merged (or keep it under `.baton/` — never commit it into the
migrated app).

### Step 6 — Serial re-integration (never merge in parallel)
When a parallel phase reports done, integrate **one branch at a time**:
1. `baton merge <slug>` into the migration branch.
2. **DRY-dedup:** grep the merged tree for near-duplicate shared units two agents may have built
   independently despite the freeze (e.g. two date formatters). Collapse to one, rewire callers,
   update the reuse index. This is the price of parallelism — budget for it.
3. **Regression:** run the accumulated oracle suite (all prior fixtures + Playwright flows) — the
   merge must not break an already-migrated phase.
4. Only after all parallel branches are merged + deduped, run the **≥95% skeptic gate (F5) on the
   merged whole**, not just per-branch — the skeptic checks cross-phase contracts and duplication.
5. Update `MIGRATION.md` (phases `done` + confidence), `baton doctor` / `clean --fix` to reclaim the
   spent worktrees.

**Cross-tool reality:** `baton connect` gives live coordination to any MCP-capable agent
(Claude/Cursor/Codex/Antigravity). For an agent that can't take the MCP, the **HANDOFF file is the
contract and the human is the message bus** — it still works, just without live `signals`. Either
way the worktree isolation + frozen reuse index + serial merge are what keep it correct.

---

## Phase G — Final full-parity sweep

When every phase is `done`: run one end-to-end pass across the whole migrated app. Confirm the
**total** inventory (all endpoints + all routes/components) is reproduced, the app builds/tests
clean, and a final independent skeptic re-checks the complete diff against the full inventory for
missing units, broken contracts, and duplicated code. Fix anything found (re-enter the loop for
that unit), update the ledger to reflect 100%, and record the completion to shared memory.

---

## Working with baton (when present — the full-power path)

*The skill is portable and runs without any tracker. But when this repo has **baton**, its
primitives ARE this skill's resume + coordination machinery — use them instead of the generic
fallbacks. A migration is a long, multi-session, often multi-agent job, which is exactly what baton
is built for.*

| Skill step | baton command | Why |
|---|---|---|
| Fresh session onboarding (Phase A) | `baton orient` | Budgeted project brief — memory, recent work, structure — so a resumed session reloads cheaply. |
| Understand the whole codebase (Phase B) | `baton kb rebuild` → then query the graph over MCP | The map you inventory from; don't read the whole repo. |
| Isolate the work | `baton new "migrate: <phase>"` | Scaffolds a branch **+ worktree** per phase so parallel sessions don't collide. |
| **Fan out to other agents** (Parallel mode) | `baton connect` | Wires the coordination MCP into Cursor / Codex / Antigravity / extra Claude sessions so they see each other's signals live. |
| Multi-session coordination (Phase F1) | `baton status` / `signals` / `progress "<intent>"` | See who's editing what right now; announce your target files. |
| **Re-integrate a finished parallel phase** (Step 5) | `baton merge <slug>` | Squash-merges a phase's worktree branch back into the migration branch; then DRY-dedup + regression. |
| **Hit a usage limit mid-migration** | `baton pass` | Packages the session into a `HANDOFF.md` brief (done / pending / next unit) — **this is the resume feature.** |
| **Next session / next day** | `baton resume` (or `baton take <slug>`) | Prints the pickup prompt from the handoff brief; continue at the exact next unit. |
| Record root facts + gotchas (Phase F6) | `baton memory` (`save_memory`) | Pointers + non-obvious decisions; `MIGRATION.md` stays the source of truth for status. |
| Refresh the map after new surface | `baton kb rebuild` | So the next phase's audit sees the migrated units. |
| End-of-migration cleanup | `baton doctor` / `clean --fix` | Reclaim orphaned worktrees/branches from the phased work. |

**The pairing that matters most:** at a usage limit or end of session, `baton pass` writes the
handoff brief and `MIGRATION.md` holds per-unit status — together they make the migration resume
*mid-phase* with nothing lost. That is this skill's whole promise, delivered by baton's whole point.

## Guardrails (always enforced)

- ⛔ **No phase is started before its predecessor hits ≥95% skeptic-corroborated parity** (verified
  against the recorded oracle, not eyeballed), and no phase plan is executed before the user approves it.
- ⛔ **Never migrate a unit without a parity oracle** for it (fixture / Playwright / documented shape).
- ⛔ **Never migrate the whole codebase in one pass** — always ordered phases with a committed,
  per-unit ledger; checkpoint each unit as it lands so a mid-phase interruption never loses progress.
- ⛔ **Never install an unapproved dependency;** a new lib mid-migration is fine — propose, get
  approval, add it to the ledger's approved set — but never silently.
- ⛔ **Never rebuild a unit that already exists** — check the reuse index first (DRY).
- ⛔ **Never fan out parallel agents before the foundation phase is committed** (uncommitted/partial
  foundation = no foundation; a deadline or a human order does not waive this), and during fan-out
  the reuse index is frozen — a new shared unit means STOP + coordinate, never two agents building
  it. Merge parallel branches **serially** (merge → dedup → regression → skeptic on the whole).
- ⛔ **Never fan out two phases that write the same central manifest** (route registry, i18n bundle,
  DI list, barrel `index.ts`, `package.json`) without first splitting it into per-feature fragments or
  making it coordinator-owned — the reuse-index freeze does not prevent this merge conflict (Step 1b).
- ⛔ **Never let a parallel worker code against a stale foundation** — the handoff carries
  `foundation_sha`; the worker's first action is the currency + signature-match check, and a mismatch
  means STOP + re-request, not "it typechecks locally, ship it."
- ⛔ **Never record a feature phase `done` without an independent skeptic score** — the skeptic run is
  mandatory and non-waivable regardless of green build/tests; self-granted deferrals count as missing
  units and need user sign-off.
- ⛔ **Never guess an ambiguous behavior** — ask the user.
- ⛔ **Commit per phase automatically; never `git push`** without explicit permission (ask push +
  PR + base branch together).
- **Always resume from the ledger; never restart a migration.**

## Definition of done

- [ ] Resume checked FIRST at UNIT level: read `MIGRATION.md` + shared memory; continued from the first un-migrated unit (never restarted); source-drift checked via the recorded source SHA.
- [ ] Whole codebase understood from the map; source & target stacks named; every area classified backend/frontend; coexistence model + source SHA recorded.
- [ ] Full inventory enumerated (every endpoint / every route+component / every cross-cutting concern) with edge cases, and a parity oracle (fixtures / Playwright / documented shape) recorded per unit.
- [ ] Target best-practice library set proposed and **approved before install**; recorded in the ledger.
- [ ] Phase plan (ordered, per-phase units) written to `MIGRATION.md` and **approved by the user** before any code.
- [ ] Each phase migrated one at a time, unit-by-unit, in idiomatic target code, reusing indexed units (DRY, no duplicate endpoints/components/calls).
- [ ] Each phase parity-verified against its oracle (every unit + edge case + UI state + contract) and **≥95% skeptic-corroborated** (skeptic re-derived inventory from the source) before the next phase; gaps fixed or user asked. Foundation phases done at unit-tested + consumed.
- [ ] Target compiles / typechecks / passes tests / runs at the end of every phase; prior phases regression-checked via the accumulated automated oracle suite before the next.
- [ ] Ledger (per-unit ticks) + reuse index + shared memory updated as each unit lands (resumable mid-phase, accurate); `MIGRATION.md` is the single source of truth.
- [ ] Committed per phase (proper message, project author, only that phase's files); push NOT done automatically — asked (push + PR + base branch).
- [ ] If parallelized: foundation committed before any fan-out; shared-write manifests (route registry / i18n / DI list / `package.json`) split into per-feature fragments or coordinator-owned (Step 1b); each parallel phase in its own baton worktree; reuse index frozen + **signature-pinned**; every handoff stamps `foundation_sha` and the worker currency-checks against it before coding; workers report via the `status` field; branches merged **serially** with manifest-stitch + DRY-dedup + regression + a final skeptic on the merged whole.
- [ ] Final full-parity sweep done; whole inventory reproduced; completion recorded.
