---
type: stack-migration-handoff
phase: <phase name>
worktree: <.baton/wt/migrate-<phase>>
branch: <branch>
merges_into: <migration branch>
foundation_sha: <commit the reuse index was frozen at — worker MUST currency-check against this>
depends_on: [<phase ids, or none>]
parallel_group: <id>
resume_from_unit: <first un-migrated unit>
target_agent: <claude | cursor | codex | antigravity>
status: ready            # worker updates: ready → picked-up → in-progress → done
confidence: <fill at done>
never_push: true
---

> ⚑ **START HERE — receiving agent, read this first.**
> You are a **PARALLEL MIGRATION WORKER**, not the coordinator. This file is your complete brief.
> - **FIRST, before any code — currency check.** `git fetch` then
>   `git log <foundation_sha>..origin/<merges_into>`. If the migration branch has advanced past
>   `foundation_sha`, the foundation moved (a shared unit was added, or an indexed signature changed)
>   → **STOP and re-request an updated handoff.** Also confirm your worktree's copy of each §3 unit
>   matches the signature pinned there — a mismatch means your branch is stale → STOP. Do not code
>   against a stale base; it typechecks locally and breaks only at merge.
> - Set `status: picked-up` in the frontmatter (then `in-progress` once coding) and commit it, so the
>   coordinator sees your progress via `baton status` instead of waiting for a relayed message.
> - Work **only** inside the `worktree` / `branch` in the frontmatter, and **only** the units in §2.
> - **Reuse** everything in §3 (frozen reuse index); build **none** of it. Need a shared unit not
>   listed there? → **STOP and ping the human coordinator** — do not invent it.
> - Touch **only your own fragment** of any shared manifest (§2 says which route-file / i18n namespace
>   you own); never edit the shared root (`nav-registry.ts`, `en.json`, `package.json`) — the
>   coordinator stitches those. `check_files` before any shared-path touch.
> - Follow the target's best practices; reproduce **every edge case + state** in §2.
> - **Commit per unit; NEVER `git push`; do not open a PR; do not edit `MIGRATION.md`.**
> - If you have the `stack-migration` skill, follow it for THIS phase only (it will detect this
>   handoff in Phase A). When done or blocked, set `status` accordingly and report back to the
>   coordinator with the next un-migrated unit. Hit a usage limit? → use the `handoff` skill
>   (`baton pass`) so a fresh session resumes THIS phase, don't just stop.

# HANDOFF — migrate phase: `<phase name>`

## 0. Where you are
- **Worktree / branch:** `<.baton/wt/migrate-<phase>>` / `<branch>` → merges into `<migration branch>`.
- **Ledger (read-only):** `MIGRATION.md` at repo root — the coordinator owns status; don't edit it.
- **Coordination:** if the baton MCP is wired (`baton connect`), call `check_files` before editing a
  shared file and `report_progress "<intent>"` when you start. If not, the human relays messages.

## 1. Stacks + approved libraries (do NOT add deps outside this set)
- **Source:** `<e.g. Angular 14 + RxJS>`   **Target:** `<e.g. Next.js 14 app-router + React 18 + TS>`
- **Approved libraries** (already agreed — reuse, don't re-litigate, don't add rogue deps):

  | Concern | Library |
  |---|---|
  | Data fetching | `<...>` |
  | Forms + validation | `<...>` |
  | Styling / UI kit | `<...>` |
  | State | `<...>` |

  Need a **new** shared lib or a **new shared unit**? → **STOP and ask the coordinator** (the reuse
  index is frozen — see §3).

## 2. Your units for THIS phase — migrate every one, with EVERY edge case
> Backend: endpoint-by-endpoint. Frontend: route + its components. Idiomatic target code
> (server components / hooks / props / composition), typed, no `any`, no dead code, no secrets/logs.
> **List the actual edge cases per unit — not just the name.** A missing edge case = a silent bug.

**Backend unit — repeat this block per endpoint:**
- [ ] `<METHOD /path>` — auth: `<roles>` — oracle: `<references/fixtures/<name>.json>`
  - Request: `<params / query / body shape + types>`
  - Response: `<shape / field names / types / status codes>`
  - Validation + error responses: `<rules → 400/422 shapes>`
  - Side effects: `<DB writes / jobs / external calls / emails>`
  - Error branches: `<not-found / forbidden / conflict / rate-limit>`
  - Pagination / filtering / sorting: `<behavior>`

**Frontend unit — repeat this block per route/component:**
- [ ] `<RouteOrComponent>` — path `<...>` — oracle: `<Playwright flow / screenshots>`
  - Calls endpoints: `<same endpoints + shapes>`
  - UI states: loading `<...>` / empty `<...>` / error `<...>` / success `<...>`
  - Forms: fields `<...>`, validation rules `<...>`, error messages `<...>`, submit/disabled logic
  - Interactions: `<clicks / navigation / modals / keyboard / edge cases>`
  - Guards / redirects: `<auth, role, not-found>`

## 3. Reuse index — FROZEN (consume these, build NONE of them)
> Shared units already built in the foundation phase. **Reuse; never rebuild.** A unit you need that
> is NOT here means your phase wasn't fully independent → **STOP, ping the coordinator.**

> Each row pins the unit's **current signature** (frozen at `foundation_sha`) — not just its name — so
> you can diff against a spec. If your worktree's copy differs from the signature here, your branch is
> stale → STOP (see ⚑ currency check).

| Unit | Kind | Target path | Signature (frozen) | What it does |
|------|------|-------------|--------------------|--------------|
| `apiClient` | util | `src/lib/api.ts` | `api(path, opts?): Promise<T>` | typed fetch + auth header |
| `useAuth` | hook | `src/hooks/useAuth.ts` | `useAuth(): { user, login, logout }` | current user + login/logout |
| `<Button>` | component | `src/components/ui/Button.tsx` | `{variant, size, loading, disabled}` | shared button |
| `<...>` | | | | |

## 4. Done bar for THIS phase (≥95%)
1. Every unit in §2 migrated + verified against its oracle; **every edge case + UI state reproduced.**
2. Typecheck / lint / tests pass; the app **runs** and you exercised this phase's flow.
3. No duplication (you reused §3, built no new shared unit); no avoidable/duplicate calls / N+1s.
4. Self-score confidence that 100% of units + edge cases are reproduced. Ambiguous behavior →
   do NOT guess → ask the coordinator.

## 5. Ground rules
- **Commit per unit** (`feat(migrate): <phase> — <unit>`), project's git author, only this phase's files.
- **NEVER `git push`**, never open a PR — the coordinator integrates (serial merge + dedup).
- Stay in your lane: only this phase's files. Shared files → `check_files` / ask first.
- When finished or at a usage limit: leave the worktree committed and **notify the coordinator** with
  what's done and the next un-migrated unit.
