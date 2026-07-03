---
name: verify-before-done
description: >-
  Verify a change actually works before claiming it is done, so a hallucinated or careless edit
  from ANY model doesn't ship a new bug. Re-read every changed file and its callers, confirm that
  referenced APIs/symbols/imports actually exist (not invented), run the build, tests, and linter,
  confirm the original goal is genuinely met, and have an independent skeptic adversarially
  re-check the diff. Use after editing code, before committing or saying "done", when verifying a
  fix or reviewing another agent's output, or when the user mentions verify, double-check,
  regressions, hallucination, "make sure it works", or "did it really fix it". Pairs with
  traceable-changes and reuses the bug-fix skill's skeptic pattern for bugs specifically.
---

# Verify Before Done (portable)

"It compiles" and "I'm done" are claims, not facts. An author re-reading their own work rubber-
stamps it; LLMs in particular emit confident, plausible code that references **APIs that don't
exist**, breaks a caller, or patches the symptom not the cause. Verification — capped by an
**independent** skeptic — is what stops that from shipping.

```
RE-READ THE DIFF → CONFIRM EVERY SYMBOL EXISTS → BUILD / TEST / LINT →
CONFIRM THE GOAL → INDEPENDENT SKEPTIC RE-CHECK → ONLY THEN DONE
```

**Golden rules**
1. **Re-read your actual diff** before declaring done — not your memory of what you intended.
2. **Every referenced symbol must exist.** Each function, method, import, env var, route, or
   field your change calls must be real in *this* codebase/version — verify it, don't assume it.
3. **Run the real checks.** Build, the test suite (or the relevant tests), and the linter/
   type-checker with the project's actual commands. Don't claim a result you didn't run.
4. **Confirm the goal, not just green.** The build passing ≠ the task done. Re-confirm the
   original symptom is gone / the feature does what was asked, by exercising it.
5. **Check the consumers.** Re-read callers of anything whose signature/output/contract you
   changed — that's where regressions hide.
6. **The reviewer is not the author.** Have an independent skeptic (a fresh, read-only pass with
   no stake in the change) try to *refute* the diff. Author-only sign-off is not verification.
7. **A failed check stops "done".** If anything fails — surface it honestly and fix or revert;
   never report success over a failing or unrun check.

> **Adapt to the project.** Use this repo's real build/test/lint commands and its definition of
> "the feature works". Items marked *(optional)* are skipped if the tooling isn't there.

---

## Workflow

### 1. Re-read the diff
```bash
git diff            # or the staged diff — read what actually changed, line by line
```
Confirm it matches the intended change and contains **no** stray edits, debug logging, secrets,
or commented-out code.

### 2. Confirm every referenced symbol is real
For each function/import/method/route/field/env var the change introduces or calls:
- Grep or query the codebase to confirm it exists with the signature you used.
- For libraries, confirm the API exists in the **installed** version — not a hallucinated or
  newer one. This is the #1 source of confident-but-wrong agent code.

### 3. Run build / tests / lint
- Build/compile and type-check with the project's command.
- Run the relevant tests (add a failing-then-passing test for a fix where a harness exists).
- Run the linter/formatter the project uses.
- If no harness exists for this area, write a concrete **manual verification plan** (exact steps,
  expected vs actual) and execute it — don't silently skip.

### 4. Confirm the goal is genuinely met
- Re-exercise the original request: reproduce the old symptom and confirm it's gone, or use the
  new feature and confirm it behaves as asked. "Passes tests" is necessary, not sufficient.

### 5. Re-read the consumers
- For anything whose interface/output you changed, re-read each caller (grep for call sites) and
  confirm it still gets what it expects. See `references/verification-checklist.md`.

### 6. Independent skeptic re-check
- Spawn or ask for a **fresh, read-only** review (Read/Grep/read-only Bash; no Edit), with no
  stake in the change. Give it the diff and the goal. Instruct it to **try to break the change**:
  a non-existent symbol, a broken consumer, an unhandled edge/boundary case, a symptom-only patch,
  duplicated logic that should reuse a helper, or an avoidable/N+1 call.
- A real issue it finds → fix it (or stop and surface it). The author cannot clear their own work.

---

## Verification checklist (copy into your reply)

```
- [ ] Re-read the full diff; no stray edits, debug logs, secrets, or dead code
- [ ] Every referenced symbol/import/API confirmed to exist in this codebase + version
- [ ] Build/type-check passes (ran it, didn't assume)
- [ ] Tests pass (or documented manual verification was executed)
- [ ] Linter/formatter clean
- [ ] Original goal re-exercised and confirmed (symptom gone / feature works)
- [ ] Consumers of any changed interface re-read and still correct
- [ ] Independent skeptic adversarially re-checked the diff — issues resolved
```

---

## Baton boost *(optional — only if Baton is wired into this repo)*

- **`check_files` / `who_touched`** (Baton MCP) — confirm no other live session is mid-edit in a
  file you're about to call done, and see who last touched a consumer you're verifying.
- **The `bug-fix` skill** — for a *bug specifically*, use it; it bakes in this verify-before-done
  gate plus reproduce-first, the 95% confidence gate, and an approved plan. This skill is the
  general "verify any change" version for features, refactors, and chores.
- **Completion reports** — once verified and merged, Baton files what changed to `.baton/reports/`
  so a waiting agent learns the work is done and what it touched.

---

## Anti-patterns

- Reporting "done" / "fixed" / "should work" without running the build or tests.
- Trusting that a library method exists because it's plausible — confirm against the installed version.
- Treating a green build as proof the feature works (it isn't).
- Letting the author of the change be the only reviewer.
- Skipping verification because the change "is small" — small changes break consumers too.

## Definition of done

- [ ] Diff re-read; every referenced symbol confirmed real.
- [ ] Build, tests, and lint actually run and clean (or manual verification executed).
- [ ] Original goal re-exercised and confirmed met.
- [ ] Consumers of changed interfaces verified.
- [ ] An independent skeptic re-checked the diff and its findings were resolved.
