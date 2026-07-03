# Commit & traceability cheat sheet

Load this when you need the exact commit format or a tracing command.

## Contents
- Conventional commit format
- Common types
- Agent-authored message examples
- When to split one commit into several
- Tracing commands (blame / bisect / revert)

## Conventional commit format
```
type(scope): imperative summary, lower-case, no trailing period, ~72 chars max

Optional body: WHY the change exists / the root cause it fixes. Wrap ~72 cols.
Refs: <task-or-issue id>
```
- **Summary** = what, in the imperative ("add", "fix", "remove" — not "added"/"fixes").
- **Body** = the *why* and any non-obvious decision. The diff already shows the *what*.
- Frontier models write good commit messages — let the message capture intent, don't pad it.

## Common types
| type | use for |
|------|---------|
| `feat` | a new capability |
| `fix` | a bug fix (name the root cause in the body) |
| `refactor` | behaviour-preserving restructure (no feature/fix) |
| `perf` | a performance change |
| `test` | adding/adjusting tests only |
| `docs` | documentation only |
| `chore` | deps, build, tooling — no src behaviour change |

Keep `refactor`, `fix`, and `feat` in **separate** commits — never one mixed commit.

## Agent-authored message examples
```
feat(routing): add severity-scored tier fallback for task routing

Route heavy tasks to opus, light ones to a local model, skipping any CLI
that isn't installed. Deterministic keyword + severity scoring, no LLM call.
Refs: baton/tiered-routing
```
```
fix(memory): withhold facts whose anchored file changed since they were saved

Root cause: stale facts were served to agents, letting them act on
out-of-date assumptions. Re-check the content hash on read; mark stale.
Refs: baton/anti-hallucination
```
```
refactor(skills): load bundled skills by directory scan instead of a manifest

No behaviour change — adding a skill no longer needs a registry edit.
```

## When to split one commit into several
Split if a single commit would:
- mix a refactor with a behaviour change (do the refactor first, separately),
- touch two unrelated features/areas,
- be too large to review in one sitting, or
- not build/pass on its own at an intermediate point.

A reviewer (human or agent) should understand each commit in isolation.

## Tracing commands
```bash
git log --oneline -- path/to/file        # history of one file
git blame path/to/file                   # who/what last changed each line
git bisect start; git bisect bad; git bisect good <sha>   # find the breaking commit
git revert <sha>                         # cleanly undo one atomic commit
git show <sha>                           # inspect exactly what a commit changed
```
Bisect is only as precise as your commits are atomic — another reason for one change per commit.
