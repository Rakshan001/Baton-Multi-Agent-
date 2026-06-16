# How the `/bug-fix` skill works

A plain-English walkthrough — what it does, why each step exists, and the rules it will never
break. This is the **portable** version: it works in any codebase and skips infrastructure
(shared registry, dependency graph) that a given project doesn't have.

---

## TL;DR

`/bug-fix` is a **disciplined pipeline** for fixing bugs without introducing regressions. It
refuses to touch a single line of code until it has **proven the root cause**, reached **≥95%
confidence corroborated by an independent skeptic agent**, AND gotten your **explicit approval**.
It commits automatically when verified — but **never pushes** without asking.

The fixed order (non-negotiable):

```
REPRODUCE-FIRST + TRIAGE → SYNC → MAP → MULTI-AGENT AUDIT → BLAST RADIUS → ROOT CAUSE →
WRITTEN PLAN → ⛔95% CONFIDENCE GATE⛔ → ⛔WAIT FOR APPROVAL⛔ → TEST → FIX → DRY/PERF GATE →
RE-VERIFY → REPORT → COMMIT (auto) → ⛔ASK BEFORE PUSH⛔
```

---

## What's optional vs. always-on

| Feature | When it runs |
|---|---|
| **Phase 0 shared registry** (multi-session claim/dedup) | Only if the project has a shared bugfix ledger. Skipped for normal single-dev repos. |
| **Phase 2 dependency graph** | Only if the project has a graph/index tool. Otherwise blast radius falls back to grep + IDE references. |
| **Everything else (gates, audit, verify, commit rules)** | **Always.** These are the safety core and never get skipped. |

---

## Phase-by-phase

### Phase 0.5 — Reproduce-FIRST + triage *(always first)*
- **Make it fail before you fix it.** If the symptom doesn't reproduce on current code → **STOP**
  (it may already be fixed). 
- **Complexity triage** decides only *how many audit agents* spawn:
  - **TRIVIAL/LOW** → 1 combined audit agent, 1 skeptic.
  - **MEDIUM/HIGH** → full parallel fan-out (Agents A–D), both skeptic checks.
- ⚠️ Triage scales agent **count** only. The safety gates (95% confidence, approval, regression
  check, no-auto-push) apply to **every** tier, including one-liners.

### Phase 1 — Sync to current code
`git fetch` → rebase/merge onto the integration branch so you audit *current* code, not stale
code someone else changed. Conflict → STOP and warn.

### Phase 2 — Refresh the map *(if a graph exists)*
A dependency/call graph drives blast-radius analysis. Refresh it if it's stale. No graph tool →
skip; the grep sweep (Agent D) becomes the primary method.

### Phase 3 — Multi-agent audit (mandatory)
Reads **every file the fix could touch** before forming any plan. Four duties (1 agent if
trivial, or parallel agents if medium/high):
- **A — Knowledge base:** conventions/architecture docs.
- **B — Bug area deep-read:** the implicated files *in full*, full call chain.
- **C — Blast radius:** who depends on the symbols you'll change (inbound edges).
- **D — Sibling/shared-consumer sweep:** `grep` for every other call site — because a static
  graph is **unsound** (it misses dynamic dispatch, string keys, and any network boundary).
  This catches consumers the graph can't see.

### Phase 4 — Blast-radius classification
**HIGH RISK** if it touches a god node, a shared contract (API shape, model field, shared util,
event), crosses a service/network boundary, or hits a flagged risky area (auth, CORS, payments,
tenancy). **HIGH RISK → STOP** and hand you options.

### Phase 5 — Root cause
**Five Whys** traced *backward* to the trigger, not where the error surfaces. No fix without a
named root cause. (3 failed fixes → likely architectural → stop.)

### Phase 6 — Written plan + the two gates ⛔
Writes an explicit plan: root cause, exact change, why each consumer is safe, exhaustive file
list, reuse check, verification plan, confidence score.
1. **95% confidence gate:** self-score, then an **independent read-only skeptic agent** (fresh
   context, no Edit) tries to *refute* it. **Final confidence = the lower of the two scores.**
   Below 95% → investigate more or escalate. Never edit below 95%.
2. **Approval gate:** STOP and present the plan. **No file is edited until you say "go ahead."**
   Applies to every bug, including one-liners.

### Phase 7 — Regression test first
Write a **failing** test that reproduces the bug. No test harness → write a concrete **manual
verification plan** instead — never a silent skip.

### Phase 8 / 8.5 — Implement + code-quality gate
Re-check staleness, then make the **minimal** root-cause fix, **only** files in the approved
plan. The fix must be **clean, not just correct**: DRY/reuse, no avoidable API calls or N+1
queries, no O(n²) hot paths, follows conventions, nothing debug/dead left behind.

### Phase 9 — Re-read & re-verify
Re-read every changed file and every shared consumer, run the test (or manual steps), **confirm
the original symptom is actually gone**, compile/lint, and have a **fresh skeptic agent
adversarially re-check the final diff**. The author never clears their own fix.

### Phase 10 — Docs & knowledge base
If the fix added new surface (endpoint, route, model field, component, env var), update the docs
and regenerate the map/graph if any.

### Phase 11 — Report *(optional)*
Write a short report / update the registry if the project keeps them.

### Phase 12 — Commit (auto) → ask before push ⛔
Re-check staleness, then **commit automatically** — proper `fix(<area>): …` message, the
project's configured author, only this bug's files staged. Then **STOP and ask** before pushing.
Push only on your explicit yes; PRs only if you ask.

---

## The rules it will never break

- ⛔ **No edit** until BOTH gates pass: ≥95% skeptic-corroborated confidence **AND** your
  explicit plan approval.
- Sync onto the integration branch **before** auditing; re-check staleness before editing and
  before committing.
- The fix author ≠ the fix verifier — an independent read-only skeptic corroborates.
- Reproduce before fixing; no root cause → no fix; symptom patches forbidden.
- Commit auto on verify; **never push automatically** — always ask.

---

*This file is documentation only. To run the workflow, invoke `/bug-fix` with a bug description.*
