# Task brief — handoff eval (variance check first)

**Goal:** prove Baton's handoff works, with a number.
**Metric:** tokens burned by the resuming agent before its first correct edit toward the objective.

## Step 0 — variance check (do this FIRST, stop if it fails)

Before building anything else.

1. Pick one large real repo. Clone it. Pin it at a fixed SHA.
2. Write ONE task for it (clear objective, gradeable).
3. Run it 5 times with the SAME setup (Baton brief arm only).
4. Record tokens-to-first-correct-edit each time.

**Gate:** if the 5 numbers swing wildly (spread bigger than any plausible gap
between arms), the eval is noise. STOP and report back — do not build the matrix.

## Step 1 — only if Step 0 passes

Add the other two arms, same repo, same task:

- **cold** — fresh agent, original prompt only
- **naive** — fresh agent, transcript tail pasted in
- **baton** — `baton take <slug>` brief

Run each 5x. Compare.

## Step 2 — widen

Add 2 more tasks on the same repo. Same 3 arms.

## Rules

- Real agent CLIs. No fakes, no replay.
- Repo must be LARGE — Baton is net-negative on small repos (see FWD-11).
  A toy fixture will honestly show Baton losing.
- Publish all 3 arms, including where Baton loses.
- Don't tune the scenarios to make Baton win.

## Out of scope (later, separate cycle)

- Coordination/collision eval
- FWD-03 telemetry

## Verify

`npm run build && npx vitest run`

## Git

Feature branch. Ask before commit. Never push. No AI trailer.

## Context to read first

- `docs/RESUME-pending-work.md` — current state
- `docs/session-continuity-improvements.md` — FWD-11 (break-even), FWD-12 (eval)
- `src/usage.ts` — already parses Claude token usage
