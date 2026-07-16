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

| # | Phase | Units — tick per unit (`[x]` done / `[ ]` todo) | Status | Confidence | Notes |
|---|-------|--------------------------------------------------|--------|-----------|-------|
| 0 | Foundation (API client, auth, cross-cutting, shared types, design system) | `[ ] apiClient` `[ ] useAuth` `[ ] errorPage` `[ ] i18n` | todo | — | |
| 1 | Login / auth | `[ ] POST /login` `[ ] POST /refresh` `[ ] LoginPage` `[ ] AuthGuard` | todo | — | |
| 2 | Home / dashboard | … | todo | — | |
| … | … | … | todo | — | |

## Reuse index (DRY — check this BEFORE building any shared unit)

Every reusable target unit already built. Reuse these; never rebuild them. Add a row whenever you
create a shared component/hook/endpoint/type/util.

| Unit | Kind | Target path | What it does | Built in phase |
|------|------|-------------|--------------|----------------|
| `apiClient` | util | `src/lib/api.ts` | typed fetch wrapper + auth header | 0 |
| `useAuth` | hook | `src/hooks/useAuth.ts` | current user + login/logout | 1 |
| `<Button>` | component | `src/components/ui/Button.tsx` | shared button variants | 0 |
| … | | | | |

## Per-phase log

### Phase <#> — <name>  (status: <done/in-progress>, confidence: <N>%)
- Units migrated: <list>
- Reused from index: <list>
- New shared units added to index: <list>
- Edge cases / UI states reproduced: <list>
- Deviations from source (user-approved): <list or none>
- Skeptic gaps found & fixed: <list or none>
- Open questions for the user: <list or none>
