# Per-phase parity checklist

Run this for the phase you're verifying (Phase F4–F5). Parity means the target reproduces the
source's **behavior + information** for every unit in the phase — verified against the recorded
golden-master oracle (Phase C fixtures), **not** by eyeball and **not** pixel-perfect (the target
uses its own design system). "It compiles / it renders" is not parity.

## Backend phase — per endpoint

For **each** endpoint in the phase's scope, confirm the target reproduces:

- [ ] Method + path (and any dynamic/programmatic route registration).
- [ ] Auth / permissions / roles required.
- [ ] Request contract: path params, query params, body shape + types.
- [ ] Response contract: shape, field names, types, status codes.
- [ ] Validation rules and their error responses (400/422 shapes).
- [ ] Side effects: DB writes, jobs enqueued, external calls, emails.
- [ ] Error branches: not-found, forbidden, conflict, rate-limit, etc.
- [ ] Pagination / filtering / sorting behavior.
- [ ] No N+1 queries; reuses shared services/DTOs from the reuse index.

Existing clients that call these endpoints still get the same shapes (contract parity).

## Frontend phase — per route / component

For **each** route (and its components) in the phase's scope, confirm:

- [ ] Route exists at the same path; guards/redirects reproduced.
- [ ] Calls the **same** endpoints with the same request/response shapes.
- [ ] UI states: loading, empty, error, success all reproduced.
- [ ] Forms: fields, validation rules, error messages, submit/disabled logic.
- [ ] Interactions: clicks, navigation, modals, keyboard, edge cases.
- [ ] Layout / copy / visual match (unless a redesign was explicitly requested).
- [ ] Reusable components come from the reuse index; new shared ones added to it.
- [ ] No duplicate data fetching; data in cache/state reused; effects cleaned up.
- [ ] Matches the recorded Playwright flow + reference network calls for the route.

## Cross-cutting concerns (verify once, in the foundation phase — these have no route/endpoint)

- [ ] Auth guards / route protection, HTTP interceptors → middleware/fetch-wrapper.
- [ ] 404 / 500 / error pages + error boundaries.
- [ ] Env vars + config, feature flags, i18n, analytics, SEO/meta, service worker/PWA.
- [ ] Global styles/theme tokens, app shell/layout, root providers, proxy/rewrite rules.

## Build / run gate (every phase)

- [ ] Typecheck passes (no `any` where a real type exists).
- [ ] Lint passes; no dead/commented code, no leftover debug logging or secrets.
- [ ] Tests pass.
- [ ] The target app **runs** and the phase's flow was exercised and observed — not just built.

## Merge gate (only when re-integrating a parallel phase — Parallel mode, Step 6)

Run per branch, merging **one at a time**, before the whole-migration skeptic:

- [ ] `baton merge <slug>` into the migration branch cleanly (conflicts resolved, not auto-flattened).
- [ ] **Stitch the shared manifests:** the coordinator adds this phase's fragment entries to the shared
      roots (`nav-registry.ts` imports, `i18n` namespace, DI list) — the entries the workers were forbidden
      to touch. Verify the manifest resolves (routes register, translations load).
- [ ] **DRY-dedup:** grep for near-duplicate shared units two agents built independently despite the
      freeze (two date formatters, two toast helpers). Collapse to one, rewire callers, update the reuse index.
- [ ] **Regression:** the accumulated oracle suite (all prior phases' fixtures + Playwright flows) still passes.
- [ ] After ALL parallel branches merged + deduped → run the ≥95% skeptic on the **merged whole**
      (cross-phase contracts + duplication), not just per-branch.

## Fixture-adequacy pre-check (before F5 scoring)

Green tests prove parity only if the fixtures exercise the failing case. Before scoring, confirm the
oracle covers **each enumerated edge case**, not just the happy-path record:

- [ ] A fixture for each of: restricted/age-gated, closed/inactive, empty, error, auth-redirect,
      pagination boundary — wherever the unit has that state.
- [ ] Fixtures were captured from a record/tenant that actually **has** those edge cases (a benign
      tenant with none makes the suite vacuously green).
- [ ] The skeptic re-derives edge cases from the **source**, not from your fixture set.

## Skeptic prompt (F5)

Give the independent read-only skeptic: this phase's inventory checklist + the `git diff`. Ask it
to find, specifically: a missing endpoint/route/component, an unhandled edge case or UI state, a
dropped validation/auth rule, a broken request/response contract, duplicated code that should
reuse an indexed unit, and avoidable/duplicate API calls or N+1 queries. It returns a 0–100 score
+ the specific gaps. Final confidence = the lower of your score and the skeptic's. Below 95% → fix
the named gaps and re-verify; if a behavior is genuinely ambiguous → ask the user.
