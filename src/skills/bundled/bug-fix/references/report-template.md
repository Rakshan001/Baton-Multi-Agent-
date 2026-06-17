# Bugfix Report: {bug-name}

<!-- Optional. Use if the project keeps bugfix reports. Pair with status.json if a registry exists. -->

- **Date:** {YYYY-MM-DD}
- **Repo / package:** {name}
- **Branch:** {bugfix/{bug-name} | none}
- **Ticket:** {id | none}

## 1. Summary

One-paragraph description of the bug and the fix.

## 2. Symptom & Reproduction

- **Expected:** what should happen.
- **Actual:** what happened instead.
- **Repro steps:** numbered, minimal steps (or the failing input/request).

## 3. Root Cause (Five Whys)

1. Why did the symptom occur? …
2. Why? …
3. Why? …
4. Why? …
5. Why? → **Root cause:** the original trigger point (file:line), not where the error surfaced.

## 4. Blast-radius findings

- Symbols/files touched: …
- Direct dependents (from graph or grep): …
- God node / shared contract involved? {yes — details | no}
- Cross-boundary (service/network) contract impact: {yes — details | no}
- Risk classification: {low | high}. If high — what was decided with the user.

## 5. Fix

- Files changed (path → what changed and why):
  - `…`
- Why this addresses the root cause (not the symptom):
- **Code quality:** reused existing helper {which one | none, justified}; no duplicated logic;
  no avoidable/duplicate API calls or N+1 queries; follows repo conventions.

## 6. Existing features verified safe (no regression)

Every shared consumer of the changed code (from Agent C inbound edges + Agent D sibling sweep):

| Consumer (file:line) | How it uses the changed symbol | Still works because… |
|---|---|---|
| `…` | … | … |

## 7. Regression test (or documented manual verification)

- **If a test harness exists:**
  - Test file/name: `…`
  - Confirmed failing before the fix: {yes}
  - Confirmed passing after the fix: {yes}
- **If no harness (manual/behavioral verification):**
  - Route/endpoint: `…`
  - Steps: 1) … 2) … 3) …
  - Expected: … / Actual after fix: …
  - Confirmed by: {ran the app myself | handed to user}

## 8. Build/lint verification

- Compile/type-check: `{command}` → {pass}
- Build/lint (if non-trivial): `{command}` → {pass}
- No previously-passing test now fails: {confirmed}

## 9. Documentation & knowledge base

- Hand-maintained docs updated: {which | none}
- Map/graph regenerated (if any): {yes | n/a}

## 10. Notes / follow-ups

Anything deferred, related tech debt spotted, or risks the user should know about.
