// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — demo junk audit (UI-preview fixture for the Recover screen)

   Mirrors `GET /api/doctor` (src/cleanup.ts `auditJunk`) for the same
   imaginary repo lib/demoWorktrees.ts describes, so the two screens
   agree: `spike-the-oauth-flow` is the task whose directory vanished
   there and the stale task record here, `hotfix-auth` is the orphan on
   disk in both, and the wip snapshots the Recover screen lists come
   from `demoWorktrees()`'s own `wipRef` fields rather than from a
   second set of facts invented here.

   The fixture has to teach the three things the screen exists to say:

     · A STALE TASK RECORD with commits nobody else has. The row that
       recovers, and the only kind the committed API can delete per item.
     · AN ORPHAN ON DISK that is BLOCKED DIRTY — `auditJunk` enriches
       worktree items with a dirty probe precisely so the report can show
       what a fix would refuse (src/cleanup.ts:228), and a demo without
       that state teaches that delete always works.
     · UNCOUNTABLE ROWS. Orphan branches carry no commit count anywhere
       in the committed API, so they must appear as genuinely unknown —
       and they must sort to the TOP, not the bottom, because an
       uncounted stranding is not evidence of safety.

   It also carries items the screen must DROP — a leaked `.tmp` and a
   ghost tmux session. Those hold no work, so a screen about rescuing
   work has no business listing them, and the fixture proves the filter.

   Everything here is invented. Nothing is fetched. The demo badge in the
   shell is what says so.
   ============================================================ */
import type { DoctorReport, JunkItem, JunkKind } from "./api";

const REPO = "/Users/dev/code/orbit";

/** Defaults for one audit item, so each entry below states only its differences. */
function junk(o: Partial<JunkItem> & { kind: JunkKind; id: string }): JunkItem {
  return {
    path: null,
    reason: "",
    action: "",
    blocked: null,
    bytes: null,
    ...o,
  };
}

/**
 * The items, with their `reason` and `action` strings taken from
 * src/cleanup.ts verbatim — because those are the exact sentences the real
 * route sends, and the Recover screen's job is to re-frame the daemon's own
 * words rather than to be handed friendlier ones by a fixture.
 */
function demoItems(): JunkItem[] {
  return [
    // The task whose worktree directory is gone. In demoWorktrees() this is the
    // `missing` row, claimed by antigravity, with a wip snapshot on file: an
    // agent was stopped mid-task and the directory did not survive it.
    junk({
      kind: "orphan-worktree-task",
      id: "spike-the-oauth-flow",
      path: "/var/folders/T/baton-spike-the-oauth-flow",
      branch: "baton/spike-the-oauth-flow",
      reason: "recorded task, but its worktree directory no longer exists",
      action: "remove the stale task entry + its branch",
    }),
    // On disk, git knows it, no task owns it — AND it is dirty, so `cleanJunk`
    // would skip it without --force. The screen must say that out loud.
    junk({
      kind: "orphan-worktree-disk",
      id: "hotfix-auth",
      path: `${REPO}/.baton/worktrees/hotfix-auth`,
      branch: "hotfix/auth",
      blocked: "dirty",
      reason: "baton worktree on disk with no matching task (interrupted create/remove)",
      action: "remove the worktree + its branch",
    }),
    // Two branches with no task and no live worktree. Nothing in the committed
    // API can count their lead, so both are honest unknowns.
    junk({
      kind: "orphan-branch",
      id: "baton/migrate-the-sessions-table",
      branch: "baton/migrate-the-sessions-table",
      reason: "baton branch with no task and no live worktree",
      action: "delete the branch",
    }),
    junk({
      kind: "orphan-branch",
      id: "baton/retry-the-webhook-queue",
      branch: "baton/retry-the-webhook-queue",
      reason: "baton branch with no task and no live worktree",
      action: "delete the branch",
    }),
    // Holds no work. Listed here because the route lists it, and dropped by the
    // screen — see the header.
    junk({
      kind: "orphan-tmux",
      id: "ship-the-docs",
      reason: "tmux session 'baton-9f2c1a-ship-the-docs' with no matching task",
      action: "kill the tmux session",
    }),
    junk({
      kind: "tmp-file",
      id: "tasks.json.48122.tmp",
      path: `${REPO}/.baton/tasks.json.48122.tmp`,
      bytes: 4096,
      reason: "leaked temp file from an interrupted write",
      action: "delete the file",
    }),
  ];
}

const EMPTY_COUNTS: Record<JunkKind, number> = {
  "orphan-worktree-task": 0,
  "orphan-worktree-disk": 0,
  "orphan-branch": 0,
  "orphan-tmux": 0,
  "tmp-file": 0,
  "tmp-upload": 0,
};

/**
 * A function rather than a constant for the same reason `demoWorktrees()` is:
 * `scannedAt` is only honest relative to when the screen is looked at, and an
 * audit stamped "scanned nine months ago" would read as a stale daemon.
 *
 * `discarded` is the demo's write side — the slugs a demo delete removed. A set
 * of removals laid over one fixture, rather than a second fixture, is the same
 * overlay shape lib/demoWorktrees.ts uses, and it keeps ONE description of the
 * imaginary repo so the screen cannot drift from itself.
 */
export function demoDoctorReport(
  now: number = Date.now(),
  discarded: ReadonlySet<string> = new Set(),
): DoctorReport {
  const items = demoItems().filter((it) => !discarded.has(it.id));
  const counts = { ...EMPTY_COUNTS };
  for (const it of items) counts[it.kind]++;
  return { items, scannedAt: new Date(now - 4_000).toISOString(), counts };
}

/**
 * Would the real delete refuse this item? Returns the daemon's own sentence if
 * so, else null.
 *
 * Both sentences are RECORDED, not reworded — the same discipline
 * lib/demoWorktrees.ts applies to the takeover refusal and lib/demoHandoff.ts
 * to the resume prompt:
 *
 *   · `DirtyWorktreeError` (src/commands/rm.ts:23) formats exactly
 *     `<slug> has uncommitted changes (<state>)`, and
 *     `removeTaskWorktree` throws it whenever `force` is unset and the
 *     worktree still holds unsaved work. `discardStranding` deliberately
 *     does not force, so the demo must be able to hit this.
 *   · Anything else is a kind with no per-item route at all, which is a
 *     refusal the client makes before any daemon is involved.
 */
export function demoDiscardRefusal(item: JunkItem): string | null {
  if (item.kind !== "orphan-worktree-task") {
    return `No endpoint deletes one ${item.kind}. Run \`baton clean --apply\`, which acts on the whole audit.`;
  }
  if (item.blocked === "dirty") return `${item.id} has uncommitted changes (dirty)`;
  return null;
}
