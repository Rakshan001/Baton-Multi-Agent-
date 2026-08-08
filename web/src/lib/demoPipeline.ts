// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — demo pipeline (UI-preview fixture)

   The showcase board for the Pipeline screen. Shaped to put every lane
   status on screen at once — complete, open, locked — because a demo that
   only shows the happy lane teaches nothing about the thing this screen
   exists for: understanding why work is NOT starting.

   Deliberately includes the two situations a person most needs the screen
   to explain:

     · `e2e` depends on `wire-the-auth-api`, so cancelling phase 2 strands
       it — the warning the cancel dialog leads with.
     · `billing-webhooks` is blocked on a human decision, which is what
       makes the board "stuck" rather than "finished".

   Everything here is invented. It must never read as live data — the demo
   badge in the shell is what says so.
   ============================================================ */
import type { PipelineView, LaneTask } from "../types";

const t = (o: Partial<LaneTask> & { slug: string; title: string; phase: number }): LaneTask => ({
  state: "queued", assignee: null, holder: null, dependsOn: [], planId: "auth",
  blocker: null, branch: `baton/${o.slug}`, ...o,
});

export const DEMO_PIPELINE: PipelineView = {
  openPhase: 2,
  integrationHold: null,
  deadlocked: false,
  lanes: [
    {
      phase: 1,
      status: "complete",
      done: 2,
      total: 2,
      tasks: [
        t({ slug: "design-the-schema", title: "Design the auth schema", phase: 1, state: "done" }),
        t({ slug: "pick-a-session-store", title: "Pick a session store", phase: 1, state: "done" }),
      ],
    },
    {
      phase: 2,
      status: "open",
      done: 0,
      total: 3,
      tasks: [
        t({
          slug: "wire-the-auth-api", title: "Wire the auth API", phase: 2, state: "active",
          dependsOn: ["design-the-schema"],
          holder: { agent: "claude", sessionSlug: "wire-the-auth-api", at: "2026-08-07T09:12:00.000Z" },
          blocker: "active (claude)",
        }),
        t({
          slug: "build-the-login-ui", title: "Build the login UI", phase: 2, state: "active",
          dependsOn: ["design-the-schema"], assignee: "cursor",
          holder: { agent: "cursor", sessionSlug: "build-the-login-ui", at: "2026-08-07T09:40:00.000Z" },
          blocker: "active (cursor)",
        }),
        t({
          slug: "billing-webhooks", title: "Handle billing webhooks", phase: 2, state: "blocked",
          dependsOn: ["design-the-schema"],
          stoppedReason: "needs the Stripe test key",
          blocker: "blocked — needs the Stripe test key",
        }),
      ],
    },
    {
      phase: 3,
      status: "locked",
      done: 0,
      total: 2,
      tasks: [
        t({
          slug: "end-to-end-tests", title: "End-to-end tests", phase: 3,
          dependsOn: ["wire-the-auth-api", "build-the-login-ui"],
          blocker: "phase 3 locked behind phase 2",
        }),
        t({
          slug: "ship-the-docs", title: "Ship the docs", phase: 3,
          dependsOn: ["wire-the-auth-api"],
          blocker: "phase 3 locked behind phase 2",
        }),
      ],
    },
  ],
  plans: [{ id: "auth", total: 7, done: 2, cancelled: 0 }],
  totals: { total: 7, done: 2, active: 2, blocked: 1, cancelled: 0 },
};

/*
 * The REAL plan format — frontmatter, `## Phase N` headings, `### slug` task
 * headings, `**after:**` for dependencies (see src/plan.ts).
 *
 * The first draft of this fixture invented a checkbox syntax that Baton does
 * not parse. A showcase that teaches a format the tool rejects is worse than no
 * showcase: someone copies it, `baton plan apply` says "no tasks", and the
 * demo is where they learned it.
 */
export const DEMO_PLAN_MD = `---
goal: Sign-in that a person can actually recover from
---

## Phase 1 — Decide

### design-the-schema
**scope:** \`src/db/**\`

Design the auth schema — sessions, refresh tokens, and what a password reset
actually invalidates.

### pick-a-session-store

Pick a session store. Write down why, so phase 2 does not relitigate it.

## Phase 2 — Build

### wire-the-auth-api
**after:** design-the-schema
**scope:** \`src/api/auth/**\`

Wire the auth API.

### build-the-login-ui
**after:** design-the-schema
**scope:** \`web/src/features/SignIn.tsx\`

Build the login UI.

### billing-webhooks
**after:** design-the-schema

Handle billing webhooks.

## Phase 3 — Prove

### end-to-end-tests
**after:** wire-the-auth-api, build-the-login-ui

End-to-end tests: sign in, expire, recover.

### ship-the-docs
**after:** wire-the-auth-api

Ship the docs.
`;
