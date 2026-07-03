# Verification checklist & skeptic prompt

Load this when you need the full verification recipe or the skeptic instructions.

## Contents
- Symbol-existence checks
- Consumer / regression checks
- Build / test / lint commands (substitute the project's)
- Manual verification plan (when no harness exists)
- Independent skeptic prompt

## Symbol-existence checks
The most common confident-but-wrong failure: code that calls something that doesn't exist.
```bash
rg -n "methodName|ClassName|CONSTANT" src        # does it exist here?
rg -n "from '.*pkg'|require\('pkg'\)" src         # how is the lib imported elsewhere?
```
For a library API, confirm against the **installed** version:
```bash
cat node_modules/<pkg>/package.json | grep '"version"'
rg -n "exportedThing" node_modules/<pkg>/dist     # or the package's .d.ts / docs for that version
```
Do not assume an API exists because it would be reasonable — check it.

## Consumer / regression checks
For anything whose signature, return shape, route, or field you changed:
```bash
rg -n "changedFnName|/api/changed-route|RENAMED_FIELD" <src + sibling packages>
```
Re-read each call site and confirm it still receives what it expects. Cross-boundary consumers
(frontend↔backend, service↔service) won't show up in a code graph — grep for the string.

## Build / test / lint commands (substitute the project's)
```bash
<build/compile>      # e.g. npm run build, cargo build, go build ./...
<type-check>         # e.g. tsc --noEmit, mypy
<tests>              # e.g. npm test, pytest, go test ./...
<lint/format>        # e.g. eslint ., ruff check, gofmt -l
```
Run them. Report the actual result. Never claim a result you didn't observe.

## Manual verification plan (when no harness exists)
Write and then execute:
```
Goal: <what should now be true>
Steps: <exact route/command/UI actions>
Expected: <observable result>
Actual: <what you observed when you ran it>
```
The change is not verified until Actual == Expected (by you running it, or the user running your
exact steps).

## Independent skeptic prompt
Give a fresh, read-only reviewer (no Edit/Write, no stake in the change) the final diff + the goal:
```
Here is a diff that claims to <goal>. Try to REFUTE that claim. Look specifically for:
- a function/method/import/field/route it references that does NOT exist in this codebase/version,
- a caller or consumer of a changed interface that now breaks,
- an unhandled edge case, boundary, or error path,
- a symptom patch that doesn't address the real cause,
- duplicated logic that should reuse an existing helper, or an avoidable/duplicate/N+1 call.
Return a 0–100 confidence that the change is correct AND safe, plus every specific risk you found.
```
Final confidence = the LOWER of the author's and the skeptic's. Below the project's bar → fix or
stop; do not declare done.
