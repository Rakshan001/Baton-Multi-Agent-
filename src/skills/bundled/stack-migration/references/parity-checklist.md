# Per-phase parity checklist

Run this for the phase you're verifying (Phase F4–F5). Parity means the target reproduces the
source's behavior for every unit in the phase — not that it merely compiles or renders.

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

## Build / run gate (every phase)

- [ ] Typecheck passes (no `any` where a real type exists).
- [ ] Lint passes; no dead/commented code, no leftover debug logging or secrets.
- [ ] Tests pass.
- [ ] The target app **runs** and the phase's flow was exercised and observed — not just built.

## Skeptic prompt (F5)

Give the independent read-only skeptic: this phase's inventory checklist + the `git diff`. Ask it
to find, specifically: a missing endpoint/route/component, an unhandled edge case or UI state, a
dropped validation/auth rule, a broken request/response contract, duplicated code that should
reuse an indexed unit, and avoidable/duplicate API calls or N+1 queries. It returns a 0–100 score
+ the specific gaps. Final confidence = the lower of your score and the skeptic's. Below 95% → fix
the named gaps and re-verify; if a behavior is genuinely ambiguous → ask the user.
