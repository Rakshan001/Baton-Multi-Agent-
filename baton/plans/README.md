# Plans

A plan is a phased list of tasks, written as markdown, applied with
`baton plan apply <name>`.

Plans live here — **inside git**, unlike `.baton/` — because a plan is a shared
statement of intent. In team mode this directory is how a teammate's plan
reaches your machine.

```bash
baton plan check auth              # parse + validate, write nothing
baton plan apply auth --dry-run    # show the diff
baton plan apply auth              # queue the tasks
```

## Format

````markdown
---
plan: auth              # id; defaults to the filename
goal: Ship JWT auth end to end
requireReview: true     # default. Opting out has to be written down.
---

## Phase 1 — Foundation

### auth-schema @claude
**scope:** `src/db/**`
**expects:** migration runs up and down; vitest test/schema passes
**principles:** no raw SQL outside src/db

Add users + refresh_tokens tables.

## Phase 2 — API

### auth-api @cursor
**after:** auth-schema
**scope:** `src/auth/**`

Issue and verify tokens.
````

- `### <slug>` — the task. Must already **be** a slug: lowercase, hyphens, no
  slashes. It becomes a branch name and a directory, so an unsafe one is
  rejected rather than repaired.
- `@agent` — optional. No `@` means the open pool, which is how an idle agent
  helps finish someone else's phase.
- `**after:**` / `**dependsOn:**` — comma-separated slugs from this plan.
- `**scope:**` — path globs the task owns.
- `**expects:**` — semicolon-separated evidence, checked before `done`.
- Everything else under the heading is the description handed to the agent.

Tasks in the same phase run **in parallel**; phase N+1 stays locked until every
task in phase N is done or cancelled.

## Rules the validator enforces

A plan is all-or-nothing — every problem is reported at once and nothing is
applied until they are all fixed, because a half-applied plan gates phases on
tasks nobody meant to create.

- No duplicate slugs, no unknown dependencies, no dependency cycles.
- No dependency on a **later** phase — the barrier could never satisfy it.
- No two tasks in the **same** phase claiming overlapping scope. The barrier
  gates between phases and does nothing within one, and within a phase is
  exactly where parallel agents run.

## Re-applying

`apply` is a three-way merge between the file, the board, and whatever an agent
is holding right now. It always shows the diff first.

- Finished work is **never rewound**. A plan that edits a `done` task is
  reported and skipped — the plan states intent, history states fact.
- An edit landing on a task an agent currently holds needs `--force`.
- Removing a task that never started deletes the row. Removing one with a
  branch and a worktree **cancels** it instead — deleting would orphan the
  worktree with nothing pointing at it.
- A slug already owned by another plan or by a hand-made task is refused
  outright, `--force` included: both would resolve to the same
  `baton/<slug>` branch.
