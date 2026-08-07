# MID-PHASE mode — audit an existing project

The project already exists and has drifted. **Nothing here is a rewrite.** The deliverable may
legitimately be *only a plan* — that is a success, not a cop-out.

```
SCAN → DIAGNOSE → SCORE → RANKED PLAN → ⛔ APPROVE EACH STEP ⛔ → APPLY → VERIFY
```

## Golden rules for this mode

1. **Security first, always.** A committed `.env` is urgent in a way that folder layout never is.
   Run the history scan before anything else and report it before discussing structure.
2. **Never move a file without approval.** Present the plan; let the user pick steps.
3. **Every step must be independently shippable.** A half-finished restructure is worse than the
   mess it replaced. If a step cannot land on its own, split it.
4. **Never touch working code to make it pretty.** Structure changes move files and fix imports.
   They do not rewrite logic.
5. **Refuse what you cannot do safely.** Monorepos, mixed-language repos and repos with
   uncommitted changes get a plan and a warning, not an automatic edit.

## SCAN

```bash
git status --porcelain          # uncommitted work? → STOP, ask the user to commit or stash
git log --oneline | head -20
gitleaks git --redact --verbose # history leak scan — FIRST
git ls-files | grep -E '(^|/)\.env'
```

Then classify. For every source file, decide:

- **domain-shaped** — lives in a business folder (`auth/`, `billing/`)
- **layer-shaped** — lives in `controllers/`, `services/`, `models/`, `utils/`, `helpers/`
- **unplaced** — root-level source files, `misc/`, `temp/`, `new/`, `final/`, `test2/`

Detect the domains from filenames and route paths, not from folders — the folders are the
problem. `userController.ts`, `user.service.ts`, `getUser.ts` all point at a `user` domain.

Also count:

- cross-feature imports (feature A reaching into feature B's internals)
- barrel files (`index.ts` that only re-exports)
- files over ~400 lines (a file that is doing too much)
- secrets-in-code hits from gitleaks on the working tree

## DIAGNOSE — say it plainly, without insulting anyone

The user is often a beginner. Describe the situation, not the person.

```
Scanned 72 files.

  Structure   layer-based (controllers/ services/ models/)
              3 business areas are mixed across those folders: auth, billing, orders
              14 places where one area reaches into another's internals
              4 source files sitting in the project root
  Security    .env has been committed since 12 Mar (in 31 commits)   ⚠ URGENT
              no pre-commit hook installed
              no CI secret scan
  Docs        no STRUCTURE.md, no AGENTS.md — nothing tells the next
              person (or agent) where files should go
```

## SCORE

Two independent scores out of 10. Show how each was reached.

```
Security   2/10   committed .env (-5), no hook (-2), no CI (-1)
Structure  4/10   layer-based (-3), cross-area imports (-2), root files (-1)
```

Rescore after the applied steps so the improvement is visible.

## RANKED PLAN

Ordered by *risk reduced per hour spent*, never by tidiness. Security always outranks structure.

```
  1. 🔴 SECURITY   Rotate the leaked keys, untrack .env, install the hook
                   Why: the keys in git history are usable by anyone with the repo
                   Effort: 30 min · Risk: none to running code

  2. 🟠 SECURITY   Add the CI secret scan
                   Effort: 10 min · Risk: none

  3. 🟠 STRUCTURE  Move billing/* into features/billing/
                   11 files, imports updated · Effort: 2 h · Risk: low, tests must pass after

  4. 🟡 STRUCTURE  Break the 14 cross-area imports
                   Effort: 3 h · Risk: medium — do it after step 3, one area at a time

  5. 🟢 DOCS       Add STRUCTURE.md + AGENTS.md
                   Why: stops the drift coming back, and stops AI agents scattering files
                   Effort: 10 min · Risk: none

⛔ Pick the steps you want (e.g. "1, 2 and 5"), or say "just the plan" and I'll stop here.
```

Do exactly what they pick. Do not slip step 4 in because you were already nearby.

## APPLY

Per approved step:

1. Confirm the working tree is clean. Refuse to start otherwise.
2. Make the change — moves and import fixes only.
3. Run the project's tests. If they fail, **stop and report**; do not push on to the next step.
4. Record what was touched, so it can be undone:

```
Step 3 changed:
  moved      src/controllers/billing.ts → src/features/billing/api/billing.ts   (+10 more)
  edited     14 import statements
  git config unchanged
  Undo: git checkout -- . (nothing is committed until you approve)
```

Config changes are **not** in git — `core.hooksPath` must be listed separately and undone with
`git config --unset core.hooksPath`.

Ask before committing. Then ask separately before pushing.

## Cases to refuse or flag rather than fix

| Situation | Do this |
|---|---|
| uncommitted changes present | stop — ask the user to commit or stash first |
| monorepo (workspaces / turbo / nx) | report only; per-package layout is out of scope |
| `.gitignore` needs changes | **append** missing lines only; never rewrite or reorder |
| a CI file with the same name exists | show a diff, ask; default is skip |
| existing husky / pre-commit framework | extend it — never set `core.hooksPath` (see `security.md`) |
| the repo is someone else's, cloned | structure advice only; do not restructure |
