# Migration Ledger

> **This file is the resumable source of truth for the stack migration.** Any agent (or you, days
> later) reads this first to know the source→target stacks, the approved libraries, which phase to
> continue from, and which shared units already exist (so nothing is rebuilt). Keep it accurate —
> update it after every phase. Commit it.

## Stacks

- **Source:** <e.g. Angular 14 + RxJS + NgModules, REST API>
- **Target:** <e.g. Next.js 14 app-router + React 18 + TypeScript + server components>
- **Scope:** <frontend only / backend only / both>
- **Migration branch:** <branch name>
- **Source commit SHA (inventory taken at):** <sha>   **Source frozen?** <yes/no — if no, drift-check on resume>
- **Coexistence model:** <new project / same-repo subfolder> + <big-bang cutover / strangler proxy>
- **Started:** <YYYY-MM-DD>   **Last updated:** <YYYY-MM-DD>

> This file is the SINGLE SOURCE OF TRUTH for status. baton memory holds only pointers + gotchas.

## Approved libraries (Phase D — mutable: add a row when a new lib is approved mid-migration)

| Concern | Library | Why |
|---|---|---|
| Data fetching | <e.g. @tanstack/react-query> | <reason> |
| Forms + validation | <e.g. react-hook-form + zod> | <reason> |
| Styling / UI kit | <e.g. tailwind + shadcn/ui> | <reason> |
| State | <e.g. zustand / server state only> | <reason> |
| … | | |

## Inventory totals

- Backend endpoints: **<N>**
- Frontend routes: **<N>**   Components: **<N>**

## Phase plan

Order by dependency: shared foundation first (design system, auth, API client, shared types), then
feature areas. Status: `todo` / `in-progress` / `done`. A phase is `done` only at ≥95% parity.

Foundation phases are done at "unit-tested + typechecks + consumed by a later phase"; feature
phases are done at ≥95% parity. The Units cell tracks per-unit done (`[x]`/`[ ]`) so a mid-phase
interruption resumes at the exact next unit.

`Parallel`: `depends-on` phases + a `group` id. Foundation is serial (group 0, first). After it,
phases sharing no *unbuilt* unit get the same group id and can run in parallel across agents
(see the skill's **Parallel multi-agent mode**). A phase that needs another's not-yet-built unit
`depends-on` it instead of sharing a group.

| # | Phase | Units — tick per unit (`[x]` done / `[ ]` todo) | Status | Confidence | Parallel (depends-on / group) | Notes |
|---|-------|--------------------------------------------------|--------|-----------|-------------------------------|-------|
| 0 | Foundation (API client, auth, cross-cutting, shared types, design system) | `[ ] apiClient` `[ ] useAuth` `[ ] errorPage` `[ ] i18n` | todo | — | serial · group 0 | must finish + commit before any fan-out |
| 1 | Login / auth | `[ ] POST /login` `[ ] POST /refresh` `[ ] LoginPage` `[ ] AuthGuard` | todo | — | dep: 0 · group 1 | |
| 2 | Home / dashboard | … | todo | — | dep: 0 · group 1 | parallel with 1 |
| … | … | … | todo | — | | |

## Reuse index (DRY — check this BEFORE building any shared unit)

Every reusable target unit already built. Reuse these; never rebuild them. Add a row whenever you
create a shared component/hook/endpoint/type/util.

Pin each unit's **current signature** (not just its name) so a parallel worker can detect an in-place
signature change (e.g. `api(path)` → `api(path, opts)`) instead of coding against a stale copy that
only breaks at merge.

| Unit | Kind | Target path | Signature | What it does | Built in phase |
|------|------|-------------|-----------|--------------|----------------|
| `apiClient` | util | `src/lib/api.ts` | `api(path, opts?): Promise<T>` | typed fetch wrapper + auth header | 0 |
| `useAuth` | hook | `src/hooks/useAuth.ts` | `useAuth(): {user, login, logout}` | current user + login/logout | 1 |
| `<Button>` | component | `src/components/ui/Button.tsx` | `{variant, size, loading, disabled}` | shared button variants | 0 |
| … | | | | | |

## Shared-write manifest files (for parallel fan-out — see skill Parallel mode Step 1b)

Central hand-maintained files that MULTIPLE phases append to are a guaranteed merge conflict the reuse
freeze does NOT prevent. List each + its strategy before any fan-out.

| Manifest file | Phases that write it | Strategy |
|---|---|---|
| `src/lib/nav-registry.ts` | 1, 2, 3 | split → per-feature `*.routes.ts`, coordinator stitches imports |
| `src/i18n/en.json` | all feature phases | split → `i18n/en/<feature>.json`, disjoint namespaces |
| `package.json` / lockfile | any | deps go through the coordinator only — never install in parallel |

## Per-phase log

### Phase <#> — <name>  (status: <done/in-progress>, confidence: <N>%)
- Units migrated: <list>
- Reused from index: <list>
- New shared units added to index: <list>
- Edge cases / UI states reproduced: <list>
- Deviations from source (user-approved): <list or none>
- Skeptic gaps found & fixed: <list or none>
- Open questions for the user: <list or none>
