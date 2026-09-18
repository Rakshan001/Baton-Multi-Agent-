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
