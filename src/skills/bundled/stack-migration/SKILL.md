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
  language/framework/runtime.
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
→ FINAL FULL-PARITY SWEEP across all phases → COMPACT IF NEEDED
```

**Golden rules**

0. **RESUMABLE FIRST, RECORD LAST.** Before anything, read the migration ledger
   (`MIGRATION.md` at the repo root) and shared memory (baton) to see whether a migration is
   already underway and **which phase it stopped on**. If so → **continue from there, never
   restart**. A usage limit, a crash, or "I'll come back in two days" must cost you nothing.
   After every phase, write the phase status + confidence + reuse index back so the next session
   inherits it. *(This repo's tracker is **baton** — `baton status`/`signals`/memory recall +
   `save_memory`. No tracker → the committed `MIGRATION.md` alone is the source of truth.)*
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
4. **PARITY, NOT APPROXIMATION.** Every endpoint, every request/response shape, every edge case,
   every UI state and interaction in scope for the phase must be reproduced in the target. "It
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

> **Adapt to the project.** This skill is stack-agnostic. Wherever it says "the graph", "the test
> command", "endpoint", "component", or "the target library", substitute this project's actual
> source stack, target stack, and tooling. Anything marked *(optional)* is skipped if the project
> lacks it — never invent infrastructure that isn't there.

---

## Phase A — Resume check: is a migration already in progress? ⛔ DO THIS FIRST ⛔

*Why first: this skill is explicitly built to survive interruptions (usage limits, days between
sessions, multiple agents). Restarting a half-done migration wastes the most tokens and risks
double-migrating a feature. Always resume; never restart.*

1. **Read the ledger.** Open `MIGRATION.md` at the repo root (see `references/MIGRATION.template.md`).
   If it exists, it tells you: the source→target stacks, the full phase plan, each phase's
   **status** (`todo` / `in-progress` / `done`), each done phase's **confidence score**, and the
   **reuse index**. Identify the first phase that is not `done` — that is where you continue.
2. **Ask shared memory** *(if baton is present)* — `baton status` / recall memory for this
   migration: root decisions, gotchas, the library set already approved, and any phase notes.
   `baton signals` / `check_files` → is another session editing the target files right now? If so
   → coordinate before touching them.
3. **Confirm the code matches the ledger.** Quickly verify the phases marked `done` actually exist
   in the target (the files/routes are there and compile). If the ledger and the code disagree,
   trust the code, fix the ledger, and note the discrepancy — never migrate a feature twice.
4. **Decision:**
   - Ledger exists with unfinished phases → **resume at the first non-`done` phase** (skip to the
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
3. **Classify every area as BACKEND or FRONTEND** (a repo may have both):
   - **Backend** = HTTP/RPC handlers, controllers, services, models, DB access, auth, jobs.
   - **Frontend** = routes/pages, components, view state, client data-fetching, styling.
   Record the split. The two are inventoried and phased differently (Phase C).
4. **Trace the boundaries that must stay stable.** If you're migrating only the frontend, the
   backend API contract is fixed — the migrated frontend must call the same endpoints with the
   same shapes. If migrating only the backend, existing clients must keep working. Note every
   cross-boundary contract; these are your parity anchors.

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

**Completeness gate:** the inventory is not done until every route registration / component file
is accounted for. A missed unit is a feature that silently disappears in the migration.

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

---

## Phase E — Phase plan + ⛔ APPROVAL GATE ⛔ (write the ledger, then stop)

*Why: the phase plan is the backbone of the whole migration and the thing that makes it resumable.
It must be approved before any code is written.*

1. **Split the inventory into ordered phases.** Each phase is a coherent, independently verifiable
   slice — usually a feature/area (auth/login → home/dashboard → …) plus the shared foundation it
   needs. Order by dependency: foundational/shared units (design system, auth, API client, shared
   types) come first so later phases reuse them (DRY). Keep phases small enough to finish and
   verify in one working session where possible.
2. **For each phase, list its exact units** from the inventory (which endpoints / which
   routes+components) and its parity criteria.
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

### F3 — DRY / best-practice quality gate
- **No duplication:** grep the target for the behavior before adding it; reuse the existing
  helper/component/endpoint. Same logic in 2+ places → extract + index it.
- **No avoidable calls:** don't call an endpoint in a loop (batch it), don't re-fetch data already
  in state/cache, debounce rapid handlers, clean up subscriptions/effects, no N+1 queries.
- **Idiomatic target code:** follows the target framework's conventions (layering, data flow,
  error handling, typing). If the cleanest result needs a small shared refactor beyond this
  phase's units → note it in the ledger and fold it in, don't silently sprawl scope.

### F4 — Parity verify (the core check)
1. **Tick every unit** in this phase's checklist as reproduced — no endpoint / route / component
   left unmigrated.
2. **Reproduce each edge case & UI state** and confirm it behaves as the source did (validation,
   errors, empty states, auth redirects, pagination…).
3. **Contract parity across the boundary:** migrated frontend calls the same endpoints with the
   same request/response shapes; migrated backend returns the same shapes existing clients expect.
4. **Compile / typecheck / lint / run tests** with the target's commands. Launch the target app
   and exercise this phase's flow — observe the behavior, don't just trust that it built.
5. **Re-run the source** for the same flow if anything is ambiguous, and diff the behavior.

### F5 — ⛔ Confidence ≥95% gate (skeptic-corroborated) ⛔
*Why an independent check: self-graded "looks done" is unreliable — a second agent with fresh
context catches the endpoint you forgot and the edge case you rationalized away.*
1. **Score your own confidence** that this phase reproduces **100% of its inventoried units + edge
   cases** with clean, DRY, idiomatic target code.
2. **Spawn an independent read-only skeptic agent** (`Read`/`Grep`/read-only `Bash`, **no
   Edit/Write**, fresh context). Give it this phase's inventory checklist + the diff. Instruct it
   to **hunt for**: a missing endpoint/route/component, an unhandled edge case or UI state, a
   dropped validation/auth rule, a broken contract, **duplicated code that should reuse an indexed
   unit, and avoidable/duplicate API calls or N+1s.** It returns a **0–100 score + the specific
   gaps** it found.
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
   new shared unit to the **reuse index** (name → target path → what it does) so later phases reuse
   it. Update inline docs / the target's architecture docs if new surface was added.
2. **Write shared memory** *(if baton present)* — `save_memory`: the phase, what was migrated, the
   approved libraries, and any non-obvious gotcha (a tricky contract, a reused component, a
   deviation the user approved). Refresh the graph/`CODEBASE.md` if new surface was added.
3. **Commit automatically** (project's git author, only this phase's files). Conventional Commits:
   `feat(migrate): port <phase> to <target>` with a body naming the units migrated + reuse notes.
   Never `-m "wip"`. One phase = one atomic commit (or a few genuinely separable ones).
4. **⛔ Do NOT push. Ask about push AND PR together** (and which base branch) — push/PR only on the
   user's explicit yes.

### F7 — Re-check the previous phase before starting the next
Before opening phase N+1, **re-confirm phase N is still ≥95%** — quickly re-run its build + a spot
check that nothing in the new work regressed it. Then loop back to F1 for the next phase.

---

## Phase G — Final full-parity sweep

When every phase is `done`: run one end-to-end pass across the whole migrated app. Confirm the
**total** inventory (all endpoints + all routes/components) is reproduced, the app builds/tests
clean, and a final independent skeptic re-checks the complete diff against the full inventory for
missing units, broken contracts, and duplicated code. Fix anything found (re-enter the loop for
that unit), update the ledger to reflect 100%, and record the completion to shared memory.

---

## Guardrails (always enforced)

- ⛔ **No phase is started before its predecessor hits ≥95% skeptic-corroborated parity**, and no
  phase plan is executed before the user approves it.
- ⛔ **Never migrate the whole codebase in one pass** — always ordered phases with a committed ledger.
- ⛔ **Never install a dependency without approval;** never add a rogue lib outside the approved set.
- ⛔ **Never rebuild a unit that already exists** — check the reuse index first (DRY).
- ⛔ **Never guess an ambiguous behavior** — ask the user.
- ⛔ **Commit per phase automatically; never `git push`** without explicit permission (ask push +
  PR + base branch together).
- **Always resume from the ledger; never restart a migration.**

## Definition of done

- [ ] Resume checked FIRST: read `MIGRATION.md` + shared memory; continued from the unfinished phase (never restarted).
- [ ] Whole codebase understood from the map; source & target stacks named; every area classified backend/frontend.
- [ ] Full inventory enumerated (every endpoint / every route+component) with edge cases — the checklist parity is measured against.
- [ ] Target best-practice library set proposed and **approved before install**; recorded in the ledger.
- [ ] Phase plan (ordered, per-phase units) written to `MIGRATION.md` and **approved by the user** before any code.
- [ ] Each phase migrated one at a time, unit-by-unit, in idiomatic target code, reusing indexed units (DRY, no duplicate endpoints/components/calls).
- [ ] Each phase parity-verified (every unit + edge case + UI state + contract) and **≥95% skeptic-corroborated** before the next phase; gaps fixed or user asked.
- [ ] Target compiles / typechecks / passes tests / runs at the end of every phase; previous phase re-checked before the next.
- [ ] Ledger + reuse index + shared memory updated after every phase (resumable, accurate).
- [ ] Committed per phase (proper message, project author, only that phase's files); push NOT done automatically — asked (push + PR + base branch).
- [ ] Final full-parity sweep done; whole inventory reproduced; completion recorded.
