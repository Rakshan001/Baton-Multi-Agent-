---
name: bug-fix
description: >-
  Systematically fix bugs in ANY codebase WITHOUT introducing regressions. Reproduces the
  symptom first, audits every file the fix could touch (optionally using a dependency graph),
  classifies blast radius, finds the true root cause, then requires ≥95% skeptic-corroborated
  confidence AND an explicit approved plan before editing a single line. Enforces clean DRY
  code (reuse, no duplication, no avoidable API calls / N+1 queries), re-verifies the symptom
  is actually gone with an independent skeptic re-check of the diff, then commits automatically
  but NEVER pushes — it explicitly asks and pushes only with permission. Checks the shared
  tracker FIRST (already fixed? stuck on a branch? live collision?) and records the fix — root
  cause + the fixing commit — to shared memory LAST, so the next session inherits it and a later
  regression is one recall away. Use whenever the user says "use the bug fix skill", "/bug-fix",
  "fix this bug", reports a bug, a test fails, behavior is unexpected, or something is broken.
---

# Bug Fix Skill (portable)

Fix bugs systematically. The order is non-negotiable:

```
TRACKER CHECK (already fixed? stuck on a branch? live collision?) →
REPRODUCE-FIRST + TRIAGE → SYNC (current code) → MAP (audit) → MULTI-AGENT AUDIT →
BLAST RADIUS → ROOT CAUSE → WRITTEN PLAN → ⛔ CONFIDENCE ≥95% GATE ⛔ → ⛔ WAIT FOR APPROVAL ⛔ →
TEST → FIX → DRY/PERF QUALITY GATE → RE-VERIFY (symptom gone + independent skeptic) →
RECORD TO SHARED MEMORY → COMMIT (auto) → ⛔ ASK BEFORE PUSH ⛔ → COMPACT IF NEEDED
```
(Re-check git staleness before editing and before committing — other people/sessions move fast.)

**Golden rules**
0. CHECK THE SHARED TRACKER FIRST, record to it LAST. Before anything, ask the tracker: is this
   bug already fixed, stuck on an unmerged branch, or being edited by a live session right now?
   If so → STOP and surface it; don't re-fix or collide. When done, write the root cause + files
   + the fixing commit back so the next session inherits it. *(In this repo the tracker is
   **baton** — `baton status` / `signals` / `check_files` / memory recall + `save_memory`. No
   shared tracker in the project → skip Phase 0 and Phase 11's memory write; the rest is unchanged.)*
1. REPRODUCE BEFORE YOU FIX. If the symptom doesn't reproduce on current code → STOP. Scale
   effort to complexity (triage) — but never weaken the safety gates.
2. SYNC BEFORE YOU AUDIT. Audit the *current* code, not stale code. Re-check staleness again
   before editing and before committing.
3. AUDIT EVERY FILE THE FIX COULD TOUCH. Do not reason about code you have not read.
4. NO FIX WITHOUT ROOT CAUSE. Symptom patches are forbidden.
5. ⛔ CONFIDENCE ≥ 95% TO EDIT. After auditing, score your confidence; an independent
   read-only skeptic agent must corroborate it. Below 95% → investigate more or escalate.
   Never edit below 95%.
6. WRITE THE PLAN, THEN STOP. ⛔ Wait for the user's explicit approval before editing ANY file.
7. STOP AND WARN on high blast radius. Do not edit. Wait.
8. EDIT ONLY THE FILES IN THE APPROVED PLAN. Need another file? Re-plan, re-approve.
9. CLEAN CODE, NOT JUST CORRECT. DRY — reuse existing helpers, no duplication, no avoidable/
   duplicate API calls, follow repo conventions (Phase 8.5).
10. RE-READ ALL CHANGED FILES + their callers after the fix; confirm the reported symptom is
    actually gone; an independent skeptic agent adversarially re-checks the diff.
11. COMMIT AUTOMATICALLY when verified — but ⛔ NEVER push. Explicitly ask; push only if approved.

> **Adapt to the project.** This skill is stack-agnostic. Wherever it says "the app", "the
> test command", "the build command", "the graph", or "the registry", substitute this
> repo's actual tooling. Anything marked *(optional)* is skipped if the project lacks it —
> never invent infrastructure that isn't there.

---

## Phase 0 — Multi-session coordination & "is it already fixed?" *(if a shared tracker exists)*

*The #1 avoidable failure is running the whole pipeline on a bug someone already fixed, or
colliding with a live session. Ask the shared tracker BEFORE doing anything. No shared tracker
in the project → skip to Phase 0.5.*

**With baton** (this repo's tracker — the concrete instantiation of the generic steps below):
1. **Already fixed / in-flight?** Recall prior knowledge and scan history for this symptom's
   files: `save_memory`'s counterpart recall (the `recall_memory` tool or `baton memory list`),
   `baton status`, and history/blame for the buggy file. A merged fix already touches it →
   **STOP**, link it. A fix exists on an unmerged branch ("stuck between branches") → **STOP**,
   surface it, ask whether to merge/rebase that instead of writing a new one.
2. **Live collision?** Ask `check_files <paths>` (or `baton signals`): if **another session is
   editing these files right now**, **warn + ask** before proceeding — don't collide.

**Generic tracker (no baton):** if a shared `specs/bugfixes/` ledger exists, derive a
`bug-name` + fingerprint, **atomically claim** it (CLAIMED → proceed · TAKEN → read status,
already-fixed STOP / in-progress warn+ask · DUP → STOP and point to it), and skim for related
in-flight work. `status.json` is the source of truth (`references/status-template.json`).

---

## Phase 0.5 — Triage & reproduce-FIRST gate (do this first on EVERY bug)

*Why: don't run the full machinery on a bug that's already fixed, can't be reproduced, or is a
trivial one-liner.*

1. **Reproduce-first** ("make it fail" before you fix). Confirm the reported symptom actually
   happens on the current code:
   - Repro steps given → follow them (launch the app, hit the endpoint, or trace the code path)
     and confirm expected vs actual.
   - Symptom does NOT reproduce → **STOP.** Tell the user it appears already fixed / not
     reproducible; check `git log` (and the registry, if any) for an existing fix. Do not run
     the pipeline.
   - Repro steps missing/unclear and not inferable from the code → **ask the user** for steps /
     environment before proceeding.

2. **Complexity triage — sets how many agents Phase 3 spawns (the gates below NEVER change):**
   - **TRIVIAL / LOW** (localized, 1 file, no shared contract — CSS, copy, a null guard):
     Phase 3 = **1 combined audit agent**; Phase 6 = 1 skeptic; skip the parallel fan-out.
   - **MEDIUM / HIGH** (multiple files, shared service/model/API, cross-package, or any risky
     area): Phase 3 = **full parallel fan-out (Agents A–D)**; both skeptic checks.
   - Unsure → treat as **MEDIUM**.

⚠️ The **95% confidence gate, plan-approval gate, regression check, and no-auto-push rule apply
to EVERY tier, including trivial.** Triage scales agent COUNT only — never the safety gates.

---

## Phase 1 — Sync to CURRENT code BEFORE auditing

*Why first: if someone else changed these files on the main branch, then auditing, the map, and
the plan would all be built on stale code. Get current first.*

1. `git fetch origin` (or the project's remote).
2. **Rebase/merge the working branch onto the integration branch** (`origin/main` or your
   project's equivalent). Conflict → **STOP, warn the user**, do not force through.
3. Check for other in-flight branches touching this area (`git branch -r`, the registry) so you
   don't rebuild on removed work.
4. Create the bugfix branch (`bugfix/<bug-name>`) or stay on the current branch. (A branch is
   fine now — no *code* is edited until the plan is approved in Phase 6.)
5. If using a registry, set `status: "in-progress"`.

---

## Phase 2 — Codebase map freshness *(optional — only if the project has a dependency graph)*

*Why: a dependency/call graph is the source of truth for blast radius and caller/callee chains.
If the project has one (e.g. a generated graph file, a language-server index, or you build an
ad-hoc one with grep/ctags), make sure it reflects the now-current code.*

- If a generated graph exists and is **older than the latest source commit** → refresh it with
  the project's command.
- No graph tooling at all → skip; Phase 3/4 fall back to source-reading + `grep` (Agent D below
  becomes the primary blast-radius method).

> **Golden rule: the graph is only as fresh as its last build.** Even a just-rebuilt graph
> cannot see *uncommitted* edits — yours or another session's. If a graph answer flags a file
> as having uncommitted changes (or `check_files` says someone is editing it),
> **re-read the file** and treat its graph symbols as unverified. Trusting a stale symbol is
> how a fix lands next to a function that no longer exists — or gets duplicated.

---

## Phase 3 — Parallel multi-agent audit of EVERY file the fix could touch (MANDATORY)

*Why: you must read the full codebase context of the bug — and every sibling that shares the
same component/service/module — before forming any plan. Rushing here is the #1 cause of
"fix one bug, create another".*

**Scale by the Phase 0.5 tier:** TRIVIAL/LOW → run **one** agent that does A+B+D inline.
MEDIUM/HIGH → **launch these Explore agents IN PARALLEL** (one message, multiple tool calls).
Either way, every duty below (A–D) must be covered before you proceed.

### Agent A — Knowledge base
- Project conventions docs (e.g. `AGENTS.md`, `CONTRIBUTING.md`, `README`, architecture docs).
- Any codebase overview / module map the project maintains.
- The graph report / god-node summary *(if a graph exists)*.

### Agent B — Bug area deep-read (read the files IN FULL)
- Find and read the exact file(s) implicated (component, template, service, controller, model).
- Trace the full call chain: entry point → handler → service → external call → data store.
- Note every property/variable the bug's code path reads or writes.

### Agent C — Blast-radius query (who depends on what you'll change)
Recipe in `references/blast-radius-checklist.md`. Using the graph *(if present)* or
grep/IDE references:
- **Inbound** dependents (callers/importers) — what your change can BREAK.
- **Outbound** dependencies — what could break the target if its inputs change.
- Report inbound dependent count, each dependent's file, whether any god node / hot spot is hit.

### Agent D — Sibling / shared-consumer sweep (the "don't break existing features" check)
*Why grep, not just the graph: a static graph is UNSOUND — it misses dynamic dispatch,
string/reflection calls, and any network boundary (frontend↔backend, service↔service). Grep
recovers the edges the graph dropped. On projects with no graph, this is your primary method.*

- For every function/service/component/endpoint the fix will touch, grep for **all other call
  sites** across the repo (and across sibling repos/packages if it's a shared contract):
  ```bash
  grep -rn "sharedFnName\|ComponentSelector\|/api/route\|FIELD_NAME" <src dirs>
  ```
- **Hunt the graph's blind spots** — search for the symbol as a STRING, not just a call:
  - API **route paths** and **response field names** (consumers read them by string key)
  - event names (websockets/pub-sub), queue/job names, cache keys
  - ORM/model field names used in projections/selects/serializers
  - dynamic patterns: `obj[fnName]()`, bracket access, reflection, template-driven dispatch
- **Contract check (across a boundary):** if the fix changes any API/response shape or model
  field, the graph will NOT show consumers on the other side of the network — you MUST grep
  every consumer (other repos/packages/clients) and confirm each still gets what it expects.
- Report every consumer with file:line and how it uses the shared symbol — these are the
  "existing features that must not break."

**Completeness gate — do NOT proceed until BOTH hold:**
- All agents returned, AND
- Every file you intend to list in the plan's `FILES CHANGED` has been **read in full**, and
  every shared symbol's **other consumers** (Agent D) are accounted for.

Then synthesize: in one paragraph, state how the buggy area works, its dependents, and which
existing features share the code you'll touch.

---

## Phase 4 — Blast-radius classification

Mark **HIGH RISK** if ANY hold:
- Target is a **god node / hot spot** (many inbound dependents).
- Changing a **shared contract**: API response shape, DB/ORM model field, shared util, event
  name/payload, or anything consumed by multiple apps/packages.
- Change crosses a **service/network boundary** (e.g. backend ↔ frontend, service ↔ service).
- Target sits in a known **risky area** (auth, CORS, payments, tenancy/permissions, migrations).

**HIGH RISK → STOP.** Hand the user: root cause (file:line), proposed fix, impacted surface
(dependents + Agent-D consumers), options. Wait. Do not edit.

**LOW RISK** (localized, few/no external dependents) → proceed to Phase 5.

---

## Phase 5 — Root-cause investigation

- **Initial overview** — state precisely: expected vs actual, repro steps.
- **Five Whys** — trace the behavior **backward** (use the Agent-C callers) to the original
  trigger point, not where the error surfaces.
- **Name the root cause** in one sentence before designing any fix.

If 3 fixes have failed → STOP, likely architectural; surface to the user.

---

## Phase 6 — Written plan + ⛔ APPROVAL GATE ⛔ (NOTHING is edited before this is approved)

Write the plan explicitly:
```
ROOT CAUSE:    <one sentence>
FIX:           <file:line — what changes, from what to what>
WHY SAFE:      <why each caller/consumer from Agent C & D is unaffected>
FILES CHANGED: <exhaustive list — ONLY these files will be edited>
EXISTING FEATURES VERIFIED SAFE: <each shared consumer from Agent D + why it still works>
REUSE CHECK:   <existing helper/service/util the fix will reuse — or "none exists, justified new code">
VERIFICATION PLAN: <test to add, OR manual/behavioral steps if no harness — see Phase 7>
CONFIDENCE:    <0–100%> + one line on what would lower it
```

### ⛔ Confidence gate — must reach ≥ 95% BEFORE any edit ⛔

*Why an independent check: self-graded confidence is unreliable. A second agent with no stake
in the fix and a fresh context catches what the author rationalizes away.*

1. **Score your own confidence** that (a) the named root cause is the real one, and (b) the
   fix resolves it WITHOUT breaking any consumer from Phase 3 (Agents C & D).
2. **Spawn an independent skeptic agent** (read-only — `Read`, `Grep`, read-only `Bash`;
   **no Edit/Write**, fresh context). Give it the bug, the root cause, the proposed fix, and
   the consumer list. Instruct it to **try to REFUTE** the diagnosis and fix — find an input it
   mishandles, a consumer it breaks, or evidence it's a symptom patch. It returns its own
   **0–100 score + the specific risks/unknowns** it found.
3. **Final confidence = the LOWER of your score and the skeptic's score.**
4. **Decision:**
   - **≥ 95%** → proceed to the approval gate below.
   - **< 95%** → DO NOT EDIT. Either (a) close the specific unknowns the skeptic raised —
     spawn more audit agents, read more code, or **reproduce the bug to confirm the root
     cause** — then re-score; or (b) if it can't be raised (architectural, ambiguous, missing
     info), **STOP and surface to the user** with exactly what is blocking certainty.

### ⛔ Approval gate ⛔

**Then STOP and present the plan (including the confidence scores) to the user. Do NOT edit any
file until the user explicitly approves** (e.g. "go ahead", "proceed", "yes"). This applies to
**every** bug, including one-line fixes. If the user requests changes, revise and re-ask.

(If running inside Claude Code plan mode, use ExitPlanMode to request approval.)

---

## Phase 7 — Regression test first (or documented manual verification)

**Preferred:** write a minimal **failing** test that reproduces the bug; run it; confirm it
fails for the right reason before fixing.

**If no usable test harness exists for this area:** do NOT silently skip. Write down a concrete
**manual/behavioral verification plan** in the report — exact route/endpoint, exact steps, exact
expected vs actual, plus a compile/type check. The fix is not "verified" until these manual
steps are confirmed (by you running the app, or handed to the user to run).

---

## Phase 8 — Implement the fix

0. **Re-check staleness first** (the approval gate may have waited a while; someone else could
   have pushed). `git fetch origin`; if the integration branch advanced and touched any file in
   your plan → rebase and re-confirm the audit/plan still hold before editing. Conflict → STOP,
   warn the user.
1. Minimal, targeted change addressing the root cause only. Match surrounding style. No
   opportunistic refactors. **Edit only the files in the approved Phase 6 plan.** If you
   discover you need an unlisted file → STOP, return to Phase 4/6, re-plan, re-approve.

---

## Phase 8.5 — Code-quality gate (DRY · performance · standards)

*Why: a fix that works but duplicates logic, adds an extra API round-trip, or ignores repo
conventions is tech debt and a future bug. The fix must be clean, not just correct.*

- **DRY / no duplication** — you did NOT copy-paste logic that already exists. Search first
  (`grep` for the behavior, check existing services/utils/helpers) and **reuse the existing
  helper**. If the same logic now appears 2+ places, extract it to a shared function.
- **Avoid unnecessary API/DB calls** — no duplicate/redundant requests; don't call an endpoint
  inside a loop (batch it); reuse data already in memory/state instead of re-fetching; debounce
  rapid event handlers; clean up subscriptions/listeners to prevent leaks; no N+1 queries.
- **Performance** — no obvious O(n²) over large lists, no heavy work in hot/render paths, no
  blocking calls on the request path.
- **Conventions** — follows the repo's existing patterns (layering, naming, error handling,
  typing); no `any`/untyped where a real type exists; no dead/commented code; no secrets or
  debug logging left behind.

If the cleanest fix needs a small refactor beyond the approved files → that changes the plan:
return to Phase 6, note it, re-approve. Do not silently expand scope.

---

## Phase 9 — Re-read & re-verify (the "did the fix create a new bug" gate)

1. **Re-read every file you changed** — confirm the edit matches the approved plan exactly.
2. **Re-read each shared consumer from Agent C & D** — confirm their existing logic still works
   with the changed output/interface (the regression check for existing features).
3. **Run the regression test** → must pass. (Or execute the Phase 7 manual steps.)
4. **Confirm the ORIGINAL reported symptom is actually gone** — not just "it compiles". Re-run
   the exact Phase 0.5 reproduction; for UI/behavioral bugs, launch the app and observe the
   symptom no longer happens. If you cannot run it, hand the user the precise steps.
5. **Compile / lint** with the project's commands (type-check, build, linter as appropriate).
6. **Code-quality pass — re-check the Phase 8.5 checklist** on the final diff.
7. **Independent skeptic re-check of the actual diff** — spawn a fresh read-only agent
   (`Read`/`Grep`/read-only `Bash`, no Edit) and give it the final `git diff`. Instruct it to
   adversarially hunt for: a broken consumer, an unhandled edge/boundary case, a symptom-only
   patch, **duplicated code that should reuse an existing helper, and avoidable/duplicate API
   calls or N+1 queries.** (Reviewer ≠ author — the agent that wrote the fix cannot clear it.)
   If it finds a real issue → fix or STOP.
8. **If any previously-passing test fails or the build breaks → STOP**, warn the user, offer to
   revert. A clean run is required before declaring the fix done.
9. Refresh the codebase map/graph *(if the project has one)* so later work reflects the fix.

---

## Phase 10 — Update documentation & knowledge base

*If the fix added NEW code surface — a new API endpoint/route, controller, model field, UI
route/component/service, event, or env var — it does NOT exist in the docs (or graph) yet.
Update both.*

- New API endpoint / route / controller / model change → the project's API/architecture docs.
- New UI route / module / component / service → the project's frontend docs.
- New env var → the env example file + config docs.
- Behavior change → inline code comments.
- Regenerate the graph/map *(if any)* so the new node + edges appear for the next session.

---

## Phase 11 — Record the fix to shared memory *(if a shared tracker exists)*

*Why: so the NEXT session finds your work instead of re-investigating — and so a regression that
resurfaces months later (after 5–6 features land on the same files) is one recall away, not a
fresh hunt.*

**With baton:** write the durable knowledge with `save_memory` (or `baton memory add`) — a
**fact, not a diary**: the symptom, the root cause (`file:line`), the fix, and any non-obvious
gotcha (a shared contract, an envelope quirk, a consumer that had to stay compatible). Anchor it
to the files you changed and include the fixing commit (`fixed-in: <sha>`, filled once Phase 12
commits) so a later `recall` on those files surfaces this fix immediately. Store the insight,
not the whole diff. Type it as a `gotcha` when it encodes a trap a future edit could re-trigger.

**Report (optional):** if the project keeps bugfix reports, write a short one
(`references/report-template.md`); with a generic registry, update `status.json` + regenerate any
dashboard.

---

## Phase 12 — Commit (automatic) → ⛔ ASK before push ⛔

Once the fix is verified (Phase 9 clean):

0. **Re-check staleness one last time.** `git fetch origin`; if the integration branch advanced
   and touched your files → rebase and re-run the Phase 9 checks before committing.
1. **Commit automatically — do NOT wait to be asked.**
   - Stage **only** this bug's files (leave unrelated changes untouched).
   - Use the project's configured git author. Do **not** add a `Co-Authored-By` / tool trailer
     unless the project explicitly wants one.
   - Conventional message: `fix(<area>): <what was fixed>`, body line naming the root cause.
   - If using a registry: set `status: "committed"` + commit hash.
2. **Do NOT push.** After committing, **STOP and explicitly ask**:
   > "Fix committed to `<branch>` as `<hash>`. Push to `origin/<branch>`?"
   - Push **only** if the user explicitly grants permission. On "no" → leave it local. Done.
3. **On approved push only:** `git push origin <branch>`; update the registry if any; run any
   project post-push routine (e.g. branch cleanup) — confirm first if it would discard anything.
4. **Finalize the memory fact:** now that the commit exists, fill the Phase 11 fact's
   `fixed-in: <sha>` (with baton, the commit is already linked to the file in history — the sha
   just makes the recall explicit).

**PRs:** open a PR only if the user explicitly asks.

---

## Phase 13 — Context/token hygiene

Once the bug is fully done and recorded, if the working context is near full (≈95%), **compact**
(run `/compact`, or remind the user) so the next task doesn't re-send this whole history as input
tokens. Only compact when genuinely finished — a mid-fix compact can drop the plan you still need.

---

## Guardrails (always enforced)

- ⛔ **No file is edited until BOTH gates pass: confidence ≥ 95% (skeptic-corroborated) AND the
  user explicitly approved the Phase 6 plan.**
- Edit only files in the approved plan; need another → re-plan, re-approve.
- The agent that writes the fix is NOT the one that clears it — an independent read-only skeptic
  corroborates confidence (Phase 6) and re-checks the diff (Phase 9).
- Sync onto the integration branch BEFORE auditing; re-check staleness before edit & commit.
- Reproduce before fixing; no root cause → no fix; symptom patches forbidden.
- **Commit happens automatically once the fix is verified** (proper message, project author,
  only this bug's files staged).
- ⛔ **Never `git push` automatically.** After committing, explicitly ask; push only on the
  user's explicit yes. PRs only if explicitly asked.

---

## Definition of done

- [ ] Shared tracker checked FIRST (already fixed / stuck-unmerged / live collision) — else STOPPED & surfaced.
- [ ] Bug reproduced on current code (or STOPPED if it didn't reproduce); complexity tier set.
- [ ] Synced onto the integration branch BEFORE auditing; staleness re-checked before edit & commit.
- [ ] (If a graph exists) map refreshed / confirmed current on the synced code.
- [ ] Audit covered A–D (scaled to tier); every file-to-change read in full; all shared consumers found.
- [ ] Blast-radius classified; HIGH RISK stopped for user approval.
- [ ] Root cause named.
- [ ] Confidence ≥ 95% AND corroborated by an independent read-only skeptic agent — else not edited.
- [ ] Written plan produced AND explicitly approved by the user before any edit.
- [ ] Code-quality gate passed: DRY/reuse, no duplication, no avoidable API calls, repo conventions.
- [ ] Regression test written & passing, OR documented manual verification executed.
- [ ] Original reported symptom confirmed gone.
- [ ] All changed files + their shared consumers re-read after the fix.
- [ ] Independent skeptic re-checked the final diff (correctness + DRY/perf).
- [ ] Compile/lint clean; no previously-passing test broken.
- [ ] Docs updated; map/graph refreshed if new code surface was added.
- [ ] Committed automatically (proper message, project author, only this bug's files).
- [ ] Push NOT done automatically — explicitly asked; pushed only if the user approved.
- [ ] Fix recorded to shared memory (fact, not diary — root cause + `fixed-in: <sha>`) if a tracker exists.
- [ ] Context hygiene: compacted (or reminded) if the working context was near full.
