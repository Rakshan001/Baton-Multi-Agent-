// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — demo worktrees (UI-preview fixture)

   The showcase set for the Worktrees flow canvas, shaped so every
   health value the daemon can compute is on screen at once — because a
   demo that only shows healthy worktrees teaches nothing about the
   thing this screen exists for: telling a stopped agent apart from a
   working one.

   Deliberately mirrors the plan in lib/demoPipeline.ts (same `auth`
   plan, same slugs, same `dependsOn` edges) so the Pipeline lanes and
   this canvas describe ONE imaginary repo rather than two. The layered
   layout in components/flow/layout.ts reads exactly those three fields
   — planId, phase, dependsOn — so the fixture also doubles as the
   worked example of what the layout does.

   The rows people most need to see are the three the reporter is
   afraid of:

     · `build-the-login-ui` — claimed by cursor, NO process running,
       47 uncommitted lines. `abandoned`: the terminal state.
     · `billing-webhooks`   — held and silent past the grace window,
       nothing on disk at risk yet. `stalled`.
     · `strays/hotfix-auth` — an orphan worktree on disk that no task
       owns, the kind that is forgotten until the disk fills.

   Everything here is invented. It must never read as live data — the
   demo badge in the shell is what says so.
   ============================================================ */
import type { WorktreeRow } from "../types";
// The progress ledger's read-model is declared beside the panel that reads it
// (components/flow/panel.ts) because this change does not own types.ts.
import type { WorktreeProgress } from "../components/flow/panel";

const MIN = 60_000;

/** Defaults for a healthy, uninteresting worktree — so each row below states
 *  only what makes it different, and the differences are the fixture. */
function wt(o: Partial<WorktreeRow> & { slug: string }): WorktreeRow {
  return {
    branch: `baton/${o.slug}`,
    worktreePath: `/Users/dev/code/orbit/.baton/worktrees/${o.slug}`,
    state: "queued",
    health: "ok",
    quietForMs: null,
    lastActivityAt: null,
    unprotected: { lines: 0, commits: 0, atRisk: false },
    filesChanged: 0,
    ahead: 0,
    behind: 0,
    repoState: "clean",
    agent: null,
    claimedBy: null,
    holderRunning: false,
    planId: "auth",
    phase: 1,
    dependsOn: [],
    orphan: false,
    wipRef: null,
    ...o,
  };
}

/**
 * A function rather than a constant because `lastActivityAt` is only honest
 * relative to when the screen is looked at: a fixed ISO timestamp would drift
 * into "quiet for 9 months" the week after it was written, and a canvas whose
 * demo rows are all terminally stalled says the opposite of what it should.
 */
export function demoWorktrees(now: number = Date.now()): WorktreeRow[] {
  const ago = (ms: number) => new Date(now - ms).toISOString();
  return [
    /* Phase 1 — finished and landed. The quiet baseline the rest is read against. */
    wt({
      slug: "design-the-schema", state: "done", health: "ok", phase: 1,
      lastActivityAt: ago(210 * MIN), quietForMs: 210 * MIN,
    }),
    wt({
      slug: "pick-a-session-store", state: "done", health: "ok", phase: 1,
      lastActivityAt: ago(180 * MIN), quietForMs: 180 * MIN,
    }),

    /* Phase 2 — where everything interesting is. */
    // Working: the token advanced two minutes ago. Silent by design.
    wt({
      slug: "wire-the-auth-api", state: "active", health: "working", phase: 2,
      dependsOn: ["design-the-schema"],
      agent: "claude", claimedBy: "claude", holderRunning: true,
      lastActivityAt: ago(2 * MIN), quietForMs: 2 * MIN,
      filesChanged: 6, ahead: 3, behind: 0,
      unprotected: { lines: 118, commits: 3, atRisk: true },
    }),
    // Abandoned: claimed by cursor, no process in the worktree, work at risk.
    // This is the reported bug rendered honestly — the row the old board filed
    // under "Idle · No agent attached" (see lib/derive.ts and its tests).
    wt({
      slug: "build-the-login-ui", state: "active", health: "abandoned", phase: 2,
      dependsOn: ["design-the-schema"],
      agent: null, claimedBy: "cursor", holderRunning: false,
      lastActivityAt: ago(96 * MIN), quietForMs: 96 * MIN,
      filesChanged: 9, ahead: 1, behind: 2,
      unprotected: { lines: 47, commits: 1, atRisk: true },
      wipRef: "refs/baton/wip/build-the-login-ui",
    }),
    // Stalled: held, past period + grace, but nothing on disk is at risk.
    wt({
      slug: "billing-webhooks", state: "blocked", health: "stalled", phase: 2,
      dependsOn: ["design-the-schema"],
      agent: null, claimedBy: "codex", holderRunning: false,
      lastActivityAt: ago(58 * MIN), quietForMs: 58 * MIN,
      filesChanged: 0, ahead: 0, behind: 2,
    }),
    // Quiet: inside the grace window. Visible, but nothing shouts — the state
    // that buys zero false alarms (src/worktrees.ts:38-45).
    wt({
      slug: "rotate-the-signing-key", state: "active", health: "quiet", phase: 2,
      dependsOn: ["pick-a-session-store"],
      agent: "gemini", claimedBy: "gemini", holderRunning: true,
      lastActivityAt: ago(19 * MIN), quietForMs: 19 * MIN,
      filesChanged: 2, ahead: 0, behind: 0,
      unprotected: { lines: 24, commits: 0, atRisk: true },
    }),

    /* Phase 3 — locked behind phase 2, so both rows are still queued. */
    wt({
      slug: "end-to-end-tests", state: "queued", health: "ok", phase: 3,
      dependsOn: ["wire-the-auth-api", "build-the-login-ui"],
    }),
    wt({
      slug: "ship-the-docs", state: "queued", health: "ok", phase: 3,
      dependsOn: ["wire-the-auth-api"],
    }),

    /* A second plan, so the canvas has to band two DAGs rather than one. */
    wt({
      slug: "cut-the-cold-start", state: "active", health: "conflict", phase: 1,
      planId: "perf", agent: "claude", claimedBy: "claude", holderRunning: true,
      lastActivityAt: ago(6 * MIN), quietForMs: 6 * MIN,
      filesChanged: 3, ahead: 2, behind: 5,
      unprotected: { lines: 96, commits: 2, atRisk: true },
    }),
    wt({
      slug: "cache-the-repo-map", state: "active", health: "rebasing", phase: 2,
      planId: "perf", dependsOn: ["cut-the-cold-start"],
      agent: "codex", claimedBy: "codex", holderRunning: true,
      repoState: "rebasing",
      lastActivityAt: ago(11 * MIN), quietForMs: 11 * MIN,
      filesChanged: 4, ahead: 1, behind: 0,
      unprotected: { lines: 31, commits: 1, atRisk: true },
    }),

    /* No plan at all — a one-off task. It gets its own band. */
    wt({
      slug: "fix-the-flaky-test", state: "review", health: "dirty",
      planId: null, phase: null,
      lastActivityAt: ago(41 * MIN), quietForMs: 41 * MIN,
      filesChanged: 1, ahead: 1, behind: 0,
      unprotected: { lines: 12, commits: 1, atRisk: true },
    }),
    // A recorded worktree whose directory is gone: the OS swept the temp dir and
    // took the 70-byte .git symlink with it. A known fact, not a guess.
    wt({
      slug: "spike-the-oauth-flow", state: "paused", health: "missing",
      planId: null, phase: null,
      branch: "baton/spike-the-oauth-flow",
      worktreePath: "/var/folders/T/baton-spike-the-oauth-flow",
      claimedBy: "antigravity",
      lastActivityAt: ago(320 * MIN), quietForMs: 320 * MIN,
      filesChanged: null, ahead: null, behind: null, repoState: null,
      unprotected: { lines: 0, commits: null, atRisk: true },
      wipRef: "refs/baton/wip/spike-the-oauth-flow",
    }),
    // On disk, git knows about it, no task owns it. `state: null` — an orphan
    // has no lifecycle, so it gets no state pill rather than a guessed one.
    wt({
      slug: "hotfix-auth", state: null, health: "orphan-disk", orphan: true,
      planId: null, phase: null,
      branch: "hotfix/auth",
      worktreePath: "/Users/dev/code/orbit/.baton/worktrees/hotfix-auth",
    }),
  ];
}

/* ============================================================
   THE DEMO'S WRITE SIDE (wt-node-actions)

   The panel's Take over and Pause buttons have to do something in the
   showcase, or the demo teaches that they are decorative. There is no
   daemon here, so BatonAPI keeps a patch per slug and lays it over
   `demoWorktrees()` on every read — the same overlay shape
   `agentOverride` already uses in lib/api.ts.

   Two rules this section keeps:

   · A PATCH, NOT A SECOND FIXTURE. The rows above stay the single
     description of the imaginary repo; a write edits one field of one
     row, so the canvas, the ranked list and the panel all move together
     and nothing can drift.
   · THE STALL GUARD IS NOT SOFTENED. `takeover` refuses a worktree that
     showed activity inside the stall window, and that refusal is the
     product (src/lifecycle.ts:169: "Two agents in one worktree is the
     failure this prevents"). A demo where the guard does not exist
     teaches the opposite of the feature, so the sentence below is that
     line RECORDED VERBATIM — the same thing lib/demoHandoff.ts does
     with the real resume prompt — rather than a softer one invented
     here.
   ============================================================ */

/** Patches laid over `demoWorktrees()`, keyed by slug. */
export type DemoWorktreeOverlay = ReadonlyMap<string, Partial<WorktreeRow>>;

export function applyDemoOverlay(rows: WorktreeRow[], overlay: DemoWorktreeOverlay): WorktreeRow[] {
  if (overlay.size === 0) return rows;
  return rows.map((r) => {
    const patch = overlay.get(r.slug);
    return patch ? { ...r, ...patch } : r;
  });
}

/**
 * Would the real `takeover` refuse this row? Returns the CLI's own sentence if
 * so, else null.
 *
 * Narrow on purpose: it reproduces only the two refusals a demo row can
 * actually evidence — a worktree that is not active work, and a holder that is
 * demonstrably still alive. Everything subtler (session identity, the liveness
 * probe's mtime walk) belongs to the daemon and is not guessed at here.
 */
export function demoTakeoverRefusal(row: WorktreeRow): string | null {
  if (row.orphan || row.state === null) return `No task '${row.slug}'.`;
  if (row.state !== "active") {
    return `'${row.slug}' is ${row.state} — takeover applies to active work that went quiet.`;
  }
  if (row.holderRunning) {
    const mins = Math.max(1, Math.round((row.quietForMs ?? 0) / 60_000));
    return `'${row.slug}' showed activity ${mins}m ago — not stalled. Two agents in one worktree is the failure this prevents.`;
  }
  return null;
}

/** The patch a successful takeover leaves: a live holder, and the clock reset. */
export function demoTakeoverPatch(agent: string): Partial<WorktreeRow> {
  return {
    state: "active",
    claimedBy: agent,
    agent,
    holderRunning: true,
    health: "working",
    quietForMs: 0,
    lastActivityAt: new Date().toISOString(),
  };
}

/** Would the real `pause` refuse this row? (src/lifecycle.ts:189-194.) */
export function demoPauseRefusal(row: WorktreeRow): string | null {
  if (row.orphan || row.state === null) return `No task '${row.slug}'.`;
  if (row.state !== "active" && row.state !== "claimed" && row.state !== "blocked") {
    return `'${row.slug}' is ${row.state} — nothing to hand back.`;
  }
  return null;
}

/**
 * The patch a pause leaves.
 *
 * `state: "queued"`, not `"paused"` — that is what `pause` in src/lifecycle.ts
 * actually writes, and the demo showing a state the daemon never produces would
 * be a fixture teaching a state machine that does not exist. `pause` drops
 * ownership and NOTHING else: the worktree, the branch and every uncommitted
 * line survive, so the row keeps its `unprotected` accounting untouched.
 */
export function demoPausePatch(): Partial<WorktreeRow> {
  return { state: "queued", claimedBy: null, agent: null, holderRunning: false };
}

/* ---------- the progress ledger (GET /api/worktrees/:slug/progress) ----------

   `hasLedger: false` is a REAL ANSWER and the daemon fights to keep it one
   (src/handoff/progress-ledger.ts:170 — an unknown slug is deliberately not a
   404, because "said nothing" and "does not exist" are different facts). So the
   fixture answers for every slug, and only the three rows a person would
   actually interrogate carry a ledger. `build-the-login-ui` carries the
   `flagged` overclaim marker, because a checkpoint claiming work the repository
   cannot corroborate is the single most useful thing this section can show. */

const LEDGERS: Record<string, Omit<WorktreeProgress, "slug" | "hasLedger">> = {
  "build-the-login-ui": {
    plan: [
      { content: "Scaffold the login route", status: "completed" },
      { content: "Wire the form to POST /session", status: "completed" },
      { content: "Handle the expired-token redirect", status: "in_progress" },
      { content: "Add the Playwright happy path", status: "pending" },
    ],
    notes: [
      "The redirect loop only reproduces when the refresh token is already expired at first paint.",
      "Left the form uncontrolled on purpose — react-hook-form fought the autofill.",
    ],
    next: "Reproduce the redirect loop with an expired token, then guard the first-paint fetch.",
    filesEdited: ["web/src/routes/login.tsx", "web/src/lib/session.ts"],
    stamp: { filesChanged: 9, insertions: 47, deletions: 6, commits: 1 },
    flagged: "Checkpoint marked 2 items completed, but the repository shows no new commits and no uncommitted change since the last one.",
    updatedAt: null,
  },
  "billing-webhooks": {
    plan: [
      { content: "Verify the Stripe signature", status: "completed" },
      { content: "Idempotency key on the invoice write", status: "pending" },
    ],
    notes: ["Blocked: no Stripe test key in this environment."],
    next: "Get a Stripe test key, then finish the idempotency key.",
    filesEdited: ["src/billing/webhook.ts"],
    stamp: { filesChanged: 0, insertions: 0, deletions: 0, commits: 0 },
    flagged: null,
    updatedAt: null,
  },
  "wire-the-auth-api": {
    plan: [
      { content: "Session table migration", status: "completed" },
      { content: "POST /session", status: "completed" },
      { content: "DELETE /session", status: "in_progress" },
    ],
    notes: ["Sessions are opaque ids in Postgres — see the decision note on the task."],
    next: "Finish DELETE /session and its test.",
    filesEdited: ["src/auth/session.ts", "src/auth/routes.ts", "test/auth.test.ts"],
    stamp: { filesChanged: 6, insertions: 118, deletions: 12, commits: 3 },
    flagged: null,
    updatedAt: null,
  },
};

export function demoWorktreeProgress(slug: string, now: number = Date.now()): WorktreeProgress {
  const led = LEDGERS[slug];
  if (!led) {
    return {
      slug, hasLedger: false, plan: [], notes: [], next: null,
      filesEdited: [], stamp: null, flagged: null, updatedAt: null,
    };
  }
  // Same reason `demoWorktrees` is a function: a frozen `updatedAt` reads as
  // "checkpointed nine months ago" the week after it was written.
  return { slug, hasLedger: true, ...led, updatedAt: new Date(now - 14 * MIN).toISOString() };
}
