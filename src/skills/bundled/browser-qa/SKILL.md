---
name: browser-qa
description: >-
  Test a running web app the way a user does, then fix what breaks. Explores every reachable page
  clicking real controls, submitting forms with empty / invalid / edge input, checking the console
  after every interaction and the mobile viewport, documenting each issue the moment it is found
  with before/after evidence. Scores health on a weighted rubric (functional, console,
  accessibility, UX, links, visual, performance, content), fixes bugs in source with one atomic
  commit each, re-verifies, and reports the before/after score with a ship verdict. Pass
  --report-only to document without touching code when someone else will do the fixing, and
  --quick or --exhaustive to move the severity bar. Use when the user says "qa this", "test the
  app", "find bugs on the site", "is this ready to ship", or says a feature is ready for testing.
  Tests the running app, not the source — for reviewing a diff use code-review.
---

# Browser QA (portable)

You are a QA engineer first and a fix engineer second. Test like a user, not like the person
who wrote it.

```
SETUP (url, tier, mode) → AUTH → ORIENT → EXPLORE → DOCUMENT-AS-YOU-GO →
SCORE → FIX (unless --report-only) → RE-VERIFY → VERDICT
```

**Golden rules**
1. ⛔ **Never read the source while testing.** Reading the code teaches you the intended path
   and blinds you to the one users actually take. Source is for the fix phase only.
2. Reproduce before you document. Retry once; a flake you can't repeat is a note, not a bug.
3. Document immediately, never in a batch at the end. Findings decay.
4. Check the console after *every* interaction — a silent JS error is still a bug.
5. Depth over breadth. Ten well-evidenced issues beat thirty vague ones.
6. ⛔ **`[REDACTED]` covers prose *and pixels*.** The report is built out of screenshots, and a
   capture of a submitted login or OTP form contains the credential verbatim — OTP inputs are
   plain text, not `type=password`. Never screenshot a form holding a credential, token or OTP;
   for auth-flow bugs, describe the step in words. Write evidence to an ignored directory
   (`.qa-evidence/`), never into a tracked `docs/` path, and never `git add` it.
7. ⛔ **Get approval before editing, and never push.** Present the fix list and wait for an
   explicit yes before changing any file — the same gate `bug-fix` puts in front of its own
   auto-commit. Then one atomic commit per fix, re-verified. Ask about push and PR separately.
   If the tree is dirty with work you did not create, STOP and warn — never stash or commit over
   someone else's changes.

---

## 0. Setup

| Parameter | Default | Override |
| --- | --- | --- |
| Target URL | auto-detect, else ask | `http://localhost:3000` |
| Tier | standard | `--quick` (critical+high) · `--exhaustive` (+cosmetic) |
| Mode | fix | `--report-only` (document, change nothing) |
| Scope | whole app | "focus on billing" |
| Auth | none | credentials, or a 2FA code when prompted |

The tier sets which severities get fixed, not which get found — always report everything found.

No URL given but on a feature branch → **diff-aware mode**: `git diff main...HEAD --name-only`,
map changed files to routes, detect the app on ports 3000/4000/8080, test only those routes.

Coordination pre-check *(Baton)*: `baton signals 2>/dev/null || true` — if another session is
live in the files you're about to fix, surface it before editing.

## 1. Authenticate

Sign in if credentials were given; ask for the OTP and wait if 2FA appears. Verify the login
actually succeeded before exploring — half this skill's value is lost testing a logged-out app
you believed was logged in.

## 2. Orient

Land on the target, screenshot it, map the navigation, and check the console on arrival.
Detect the framework from the markup (`__next` → Next.js, a `csrf-token` meta → Rails,
client-side routing → SPA) so you know what behaviour is expected.

## 3. Explore

At every page, in this order: visual scan · click every interactive control · fill and submit
every form with valid, **empty**, invalid, and boundary input · walk every navigation path in
and out · force each state (empty, loading, error, overflow) · re-check the console · check
the mobile viewport.

Spend the time where the product lives — homepage, dashboard, checkout, search — and less on
secondary pages.

## 4. Document as you go

**Interactive bugs:** screenshot before → perform the action → screenshot the result → write
repro steps referencing both. **Static bugs:** one annotated screenshot and what's wrong.

Append each to the report the moment you find it.

## 5. Score

Each category starts at 100. Deduct per finding: critical −25, high −15, medium −8, low −3,
floor 0. Console: 0 errors → 100, 1-3 → 70, 4-10 → 40, more → 10. Links: −15 per broken link.

| Functional | Console | Accessibility | UX | Links | Visual | Performance | Content |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 20% | 15% | 15% | 15% | 10% | 10% | 10% | 5% |

Overall = the weighted sum. Save `baseline.json` so the next run can diff against it.

## 6. Fix — *skipped entirely under `--report-only`*

Now, and only now, read the source. Per issue at or above the tier's bar: fix the cause in
source, commit atomically with a message naming the issue, re-verify that issue in the browser,
mark it FIXED. A fix that introduces a new issue is not done — fix it in the same pass.

Anything you choose not to fix stays in the report as OPEN with a reason. Silent omission reads
as "all clear" when it isn't.

### Blast radius — a fix that breaks something else is not a fix

⛔ Re-verifying the one issue you fixed is not enough; that is how a QA pass ships a regression it
created itself. After the last fix, before scoring:

1. **Re-test every page that shares the code you touched** — not just the page the bug was on. If
   you changed a shared component, header, or util, every page rendering it is in scope.
2. **Re-run the highest-severity issues you already marked FIXED.** A later fix can silently undo
   an earlier one.
3. **Re-check the console on the pages you did not revisit.** New errors there are yours.
4. ⛔ **If a fix introduced a new problem, it is not done** — fix it in the same pass and re-verify.
   Bounded: after two failed attempts on the same regression, stop, revert that fix, and report it
   as OPEN rather than leaving the tree worse than you found it.

The after-score must be measured *after* this pass. A score taken before blast-radius checking is
the score of a codebase you have not finished testing.

## 7. Report

Write `docs/YYYY-MM-DD-<slug>-qa-report.md`: health score with the category table, **Top 3 to
fix**, the issue table (severity · category · page · issue · status), detailed issues with
repro / expected / actual / evidence / fix / commit, console health, before-and-after score,
and the verdict — **SHIP · FIX MORE · BLOCK**.

Record it *(Baton — skip if not wired in)*: prefer the `save_memory` MCP tool — it takes the
fact as a structured argument. The `baton memory add` CLI is the fallback; pass the fact as a
single quoted argv value and never build it by interpolating a URL or free text into a
double-quoted shell string, where a backtick or `$(…)` in a decision note would execute.

## Definition of done

- Every issue has evidence and reproducible steps, and was confirmed by a retry.
- The console was checked after every interaction, not just on page load.
- Under `--report-only`, no source file was changed and nothing was committed. (The report and
  `baseline.json` are still written — that is the deliverable, not a code change.)
- Otherwise every fix is its own commit and was re-verified in the browser.
- Before and after scores are both stated, and a verdict is given.
