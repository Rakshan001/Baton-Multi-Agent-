---
name: traceable-changes
description: >-
  Make every change traceable so a bug introduced by ANY agent (Claude, Cursor, Codex, Gemini)
  is easy to find, attribute, and revert. One logical change per commit; a clear conventional
  commit message that states intent and root cause; isolated git worktrees per task so parallel
  agents never silently overwrite each other; and a clean bisect/blame trail. Use when several
  agents or models work on one repo, when changes must be auditable or cleanly revertable, before
  a large or multi-step change, or when the user mentions traceability, atomic commits, worktrees,
  git history, blame, bisect, or "so we can tell what broke". Pairs with verify-before-done.
---

# Traceable Changes (portable)

A commit is the smallest immutable unit of institutional knowledge. When work is split into
**small, isolated, well-described commits**, `git bisect`, `git blame`, and `git revert` turn a
"who broke this and where?" investigation into a one-command answer — even when the change came
from a different model that hallucinated.

```
ISOLATE (worktree/branch) → ONE LOGICAL CHANGE PER COMMIT → MESSAGE STATES WHY →
KEEP DIFFS REVIEWABLE → LEAVE A TRAIL → REVERT IS A FIRST-CLASS OPTION
```

**Golden rules**
1. **Isolate the work.** Each task gets its own worktree or branch. Parallel agents writing to
   the same checkout silently overwrite each other and produce failures that are impossible to
   bisect.
2. **One logical change per commit.** A commit should do exactly one thing and still build. Don't
   mix a refactor, a fix, and a rename in one commit — split them.
3. **The message states intent, not just the diff.** Say *why* and (for a fix) the root cause.
   The diff shows what changed; the message records the decision.
4. **Keep diffs reviewable.** No reformatting untouched code, no unrelated churn — noise hides
   the real change and pollutes blame.
5. **Leave a trail.** Link the commit to the task/issue and record any non-obvious decision so a
   later agent can reconstruct *why*, not just *what*.
6. **Revert is normal, not failure.** A small atomic commit can be reverted cleanly. If a change
   turns out wrong, `git revert <sha>` beats a risky manual unwind.
7. **Never force-push shared history** and never amend a commit another agent may have based work
   on — it destroys traceability.

> **Adapt to the project.** Use this repo's branch naming, commit convention, and remote. Items
> marked *(optional)* are skipped if the project doesn't have that tooling.

---

## Workflow

### 1. Isolate before you touch code
- Create a dedicated branch or git worktree for the task. One task = one isolated working tree.
- Never start work on a branch another agent/session is actively using — check first.

### 2. Stage one logical change at a time
- Group only the files that belong to a single intent. Stage them explicitly (`git add <paths>`),
  never `git add -A` blindly — that sweeps in unrelated edits.
- If you changed several unrelated things, make several commits.

### 3. Write a message that records the decision
Conventional format (see `references/commit-conventions.md` for the full cheat sheet):
```
type(scope): imperative summary under ~72 chars

Why this change / the root cause it addresses.
Refs: <task-or-issue id>
```
Example:
```
fix(auth): reject expired refresh tokens before issuing a session

Root cause: token expiry was compared against the issue time, not now,
so any once-valid token kept working. Compare against the current time.
Refs: baton/fix-refresh-expiry
```
- Use the project's configured git author. Do **not** add a tool/co-author trailer unless the
  project explicitly wants one.

### 4. Commit small and often; keep each commit green
- Commit when one logical step is done and the build still passes — not one giant end-of-task
  commit. Small commits are what make bisect precise.

### 5. Leave a trail for the next agent
- Reference the task/issue id in the message.
- Record non-obvious *why* (a tricky constraint, a rejected alternative) where the team keeps it
  — a decision log, an issue comment, or shared memory — not buried only in your head.

### 6. When something breaks, trace it — don't guess
- `git log --oneline -- <file>` and `git blame <file>` → which commit and author/agent.
- `git bisect` → the exact commit that introduced a regression (precise only if commits are
  atomic).
- `git revert <sha>` → undo one bad change without disturbing the rest.

---

## Traceability checklist (copy into your reply)

```
- [ ] Work is in its own branch/worktree, not shared with another session
- [ ] Each commit is ONE logical change and builds on its own
- [ ] Staged only the files for that change (no `git add -A` catch-all)
- [ ] Message states intent / root cause + links the task or issue
- [ ] No reformatting or unrelated churn polluting the diff or blame
- [ ] Project's git author used; no unwanted co-author trailer
- [ ] A bad change could be cleanly `git revert`ed (it's atomic)
```

---

## Baton boost *(optional — only if Baton is wired into this repo)*

- **Worktree isolation** — `baton new "<task>"` gives each task its own git worktree, so parallel
  agents can't clobber each other. This is the isolation primitive that keeps history bisectable.
- **Agent blame** — `baton blame <file>` / the `who_touched` MCP tool answers which task and which
  agent last touched a file, merging committed history with live edit signals.
- **Edit signals / `check_files`** — before editing a shared file, check whether another session
  is in it, so two agents don't produce an un-bisectable overlap.
- **Completion reports** — on merge, Baton files a report (summary, files, commits) to
  `.baton/reports/`, so a waiting agent can see exactly what a finished task changed.

---

## Anti-patterns

- One massive "did everything" commit at the end of a task — un-bisectable, un-revertable.
- `git add -A` / `git commit -am` that sweeps in unrelated changes.
- Commit messages that restate the diff ("update file.ts") instead of the intent.
- Reformatting a whole file alongside a one-line fix — destroys blame and hides the real change.
- Multiple agents on the same branch/working tree at once.
- Force-pushing or amending shared history.

## Definition of done

- [ ] Change lived in an isolated branch/worktree.
- [ ] History is a sequence of atomic, individually-building commits.
- [ ] Each message records intent/root cause and links the task.
- [ ] Diffs are clean; blame and bisect point straight at the real change.
- [ ] Any wrong commit could be reverted in one command.
