---
name: handoff
description: >-
  Relay unfinished work to another agent instead of losing it. When a session nears its
  usage/context limit, gets blocked, or the user says "hand off" / "create handoff", write a
  structured brief (done, pending, the single next step, decisions) with the create_handoff
  tool BEFORE the limit hits — the next agent resumes with `baton resume` and continues instead
  of restarting. Also covers the receiving side: execute the brief's plan, don't re-plan.
---

# Handoff — pass the baton, don't drop it

A session that dies at its usage limit takes everything it learned with it. A
handoff brief costs ~1 minute and ~1–2k tokens; re-deriving the same state in a
fresh session costs the whole investigation again.

## When to hand off (don't wait to be asked)

- Your **usage or context limit is near** (~90%): hand off NOW, before the
  limit hits, while you can still write a good brief. A brief written at 99%
  is a bad brief.
- You are **blocked** (missing access, a decision only the user can make,
  another session holds the files you need).
- The **user asks** ("create handoff", "pass this to X").

## How to write the brief

Checkpoint first: **commit** (or at least stage) work in flight so the next
agent starts from real state, and note anything intentionally uncommitted.

Then call the **create_handoff** tool with:

- `title` — one line on what this work is.
- `done` — what is verifiably complete (tests passing, commits made). Facts,
  not hopes: "wrote fix" ≠ "fix verified".
- `pending` — what remains, most important first.
- `next` — the **single next step**, concrete enough to start on immediately
  ("run `npx vitest run test/token.test.ts` — the last assertion still fails").
  This one line is the most valuable thing in the brief.
- `decisions` — decisions made and gotchas found, the things git can't show
  ("kept the 5-min clock skew — mobile clients need it"). **Never secrets**
  (tokens, keys, passwords) — briefs are plain files other agents read.

The tool returns the brief path and the pickup command. **Tell the user both**,
e.g. "Brief written — next agent picks it up with `baton resume sess-p1234`."

## How to resume one (the receiving side)

- `baton resume` lists open briefs; `baton resume <slug>` (or `baton take
  <slug>` inside a task worktree) prints the brief and marks it in-progress.
- Read the brief, `cd` where it says, verify its "done" claims cheaply (run the
  tests it names) — then **execute the plan. Do NOT re-plan from scratch**;
  the previous agent's investigation is the value you're inheriting. Flag
  blockers instead of silently changing course.
- When finished: `baton done <slug>` (task briefs) or mark the brief done, so
  the list stays honest.

## Don't

- Don't hand off uncommitted chaos — checkpoint first.
- Don't write a diary; write instructions for a stranger with zero context.
- Don't put secrets in a brief.
- Don't resume a brief marked `done` — create a fresh one if there's new work.
