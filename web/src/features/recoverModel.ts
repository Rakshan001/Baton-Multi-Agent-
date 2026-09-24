// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — what the Recover screen decides (pure, so it is pinned)

   THE REFRAMING, which is the whole point of this file.

   `src/cleanup.ts` and `GET /api/doctor` are written as JUNK DETECTION:
   every item carries a `reason` ("baton branch with no task and no live
   worktree") and an `action` ("delete the branch"). That framing is
   correct for `baton clean`, whose job is to reclaim disk.

   It is the WRONG framing for the person who opens this screen. Their
   sentence is the reporter's: "one agent may be stopped in between so
   that worktree work will be paused, user will think that work is
   completed but that work will be lost if worktree is lost." They are
   not here to tidy up. They are here to find work that nobody is
   holding any more.

   Same data, opposite verb. So this module reads the audit and re-states
   it as STRANDINGS — work with no owner — and the screen's primary
   action recovers, while delete is secondary and confirmed.

   TWO RULES ABOUT NUMBERS, both of which exist because a wrong zero here
   reads as "nothing to lose" and is the exact failure the screen guards:

     1. UNKNOWN IS NOT ZERO. `commits === null` means nothing could count
        what exists only on this disk (`src/worktrees.ts` health rung 4:
        "we could not count what exists only here, so we cannot claim it
        is safe"). An unknown therefore sorts ABOVE every counted row,
        never to the bottom.
     2. A SYNTHESIZED ZERO IS AN UNKNOWN. `src/worktrees.ts` deliberately
        declines to run `worktreeStatus` per orphan worktree — one git
        spawn each is the per-request fan-out that route must not do — and
        fills the row with zeros instead. Those zeros are placeholders, so
        they are read back as unknown here rather than as evidence.
   ============================================================ */
import type { DoctorReport, JunkItem, JunkKind } from "../lib/api";
import type { WorktreeRow } from "../types";

/**
 * The three things this screen lists, in the order it lists them.
 *
 * Each is sorted INDEPENDENTLY by unmerged commits descending. Ranking a
 * snapshot (whose size no committed route reports) against a branch with a
 * counted lead would mean comparing an unknown with a measurement, and the
 * sections exist precisely because those are different kinds of fact.
 */
export type StrandingCategory = "worktree" | "branch" | "snapshot";

export const RECOVER_CATEGORIES: StrandingCategory[] = ["worktree", "branch", "snapshot"];

export interface Stranding {
  /** Stable key — unique across the whole screen, so it can key React rows. */
  id: string;
  category: StrandingCategory;
  /** The task slug, when a task record exists. null for a bare branch. */
  slug: string | null;
  branch: string | null;
  /** Where the worktree is (or was). null for a branch or a bare snapshot. */
  path: string | null;
  /** `refs/baton/wip/<slug>` when a snapshot of the last uncommitted state exists. */
  wipRef: string | null;
  /** Commits that exist nowhere but this disk. null = nobody could count them. */
  commits: number | null;
  /** Uncommitted lines still on disk. null = nobody could count them. */
  lines: number | null;
  /** Why it is unowned — the daemon's own sentence wherever there is one. */
  reason: string;
  /** The audit would refuse to delete this (it still holds uncommitted work). */
  blockedDirty: boolean;
  /** The `GET /api/doctor` kind this came from; null for a snapshot-only row. */
  junkKind: JunkKind | null;
}

/** How much of this exists anywhere other than this disk. */
export type Exposure = "nowhere-else" | "pushed" | "unknown";

/* ------------------------------------------------------------------ */
/* Reading the numbers honestly                                        */
/* ------------------------------------------------------------------ */

/**
 * The counts a worktree row can actually vouch for. See rule 2 in the header:
 * an orphan-disk row's zeros were never measured, so they come back as unknown.
 */
function countsOf(row: WorktreeRow | undefined): { commits: number | null; lines: number | null } {
  if (!row) return { commits: null, lines: null };
  if (row.orphan) return { commits: null, lines: null };
  return {
    commits: row.unprotected.commits,
    // `filesChanged === null` is the one place a row says "git did not answer"
    // (src/worktrees.ts:buildWorktreeRow), and `unprotected.lines` is 0 in that
    // case by construction rather than by observation.
    lines: row.filesChanged === null ? null : row.unprotected.lines,
  };
}

const WORKTREE_KINDS: JunkKind[] = ["orphan-worktree-task", "orphan-worktree-disk"];

/** The slug a doctor item is about: its `id` is the task slug or the directory name. */
function slugOf(item: JunkItem): string {
  return item.id;
}

/* ------------------------------------------------------------------ */
/* The join                                                           */
/* ------------------------------------------------------------------ */

/**
 * Turn the junk audit + the worktree read-model into strandings.
 *
 * `rows` is nullable on purpose: a daemon older than `GET /api/worktrees` 404s
 * it, and losing the commit counts must not lose the LIST. Every count then
 * reads unknown, which is true, and unknowns sort to the top — which is the
 * behaviour a person hunting for lost work needs from a degraded daemon.
 *
 * `tmp-file`, `tmp-upload` and `orphan-tmux` items are dropped: a leaked
 * `.tmp` and a ghost tmux session hold no work, so they are junk in the
 * original sense and belong to `baton clean`, not here.
 */
export function buildStrandings(report: DoctorReport | null, rows: WorktreeRow[] | null): Stranding[] {
  const bySlug = new Map((rows ?? []).map((r) => [r.slug, r]));
  // An on-disk orphan's item id is its basename, which a task can share, so it
  // takes its row by PATH — the same git-reported string on both sides.
  const byPath = new Map((rows ?? []).map((r) => [r.worktreePath, r]));
  const items = report?.items ?? [];
  const out: Stranding[] = [];

  for (const item of items) {
    if (!WORKTREE_KINDS.includes(item.kind)) continue;
    const slug = slugOf(item);
    const row = item.kind === "orphan-worktree-disk"
      ? (item.path === null ? undefined : byPath.get(item.path))
      : bySlug.get(slug);
    const { commits, lines } = countsOf(row);
    out.push({
      // By path: two orphans with one basename are two rows. This also makes
      // the id tiebreak in `compareStrandings` order worktrees by path.
      id: `worktree:${item.path ?? slug}`,
      category: "worktree",
      slug,
      branch: item.branch || row?.branch || null,
      path: item.path,
      wipRef: row?.wipRef ?? null,
      commits,
      lines,
      reason: item.reason,
      blockedDirty: item.blocked === "dirty",
      junkKind: item.kind,
    });
  }

  for (const item of items) {
    if (item.kind !== "orphan-branch") continue;
    const branch = item.branch || item.id;
    // No committed route counts the lead of a branch with no task behind it —
    // `/api/worktrees` only speaks for branches a task or a worktree owns — so
    // this is a genuine unknown rather than a zero we declined to look up.
    out.push({
      id: `branch:${branch}`,
      category: "branch",
      slug: null,
      branch,
      path: null,
      wipRef: null,
      commits: null,
      lines: null,
      reason: item.reason,
      blockedDirty: item.blocked === "dirty",
      junkKind: item.kind,
    });
  }

  // Every `refs/baton/wip/*` the worktree route reports. A wip ref is only ever
  // written when a worktree went stalled or abandoned while still dirty
  // (src/wip-snapshot.ts), so its existence IS the evidence of a stranding —
  // and a ref in the common store outlives the directory it was taken from,
  // which is why this is the only section that can speak for a vanished disk.
  for (const row of rows ?? []) {
    if (!row.wipRef) continue;
    out.push({
      id: `snapshot:${row.slug}`,
      category: "snapshot",
      slug: row.slug,
      branch: row.branch,
      path: row.worktreePath,
      wipRef: row.wipRef,
      // The ref name is all the daemon serves. Nothing reports the snapshot's
      // own commit or line count, so claiming one would be an invention.
      commits: null,
      lines: null,
      reason:
        row.health === "missing"
          ? "the worktree directory is gone, but its last uncommitted state was snapshotted first"
          : "uncommitted work was snapshotted when this worktree went quiet",
      blockedDirty: false,
      junkKind: null,
    });
  }

  return out.sort(compareStrandings);
}

/**
 * Most valuable stranding first — unmerged commits descending, as the plan
 * requires. See rule 1 in the header for why `null` beats every number.
 */
export function compareStrandings(a: Stranding, b: Stranding): number {
  const byCommits = compareUnknownFirst(a.commits, b.commits);
  if (byCommits !== 0) return byCommits;
  const byLines = compareUnknownFirst(a.lines, b.lines);
  if (byLines !== 0) return byLines;
  return a.id.localeCompare(b.id);
}

/** Descending, with `null` (uncounted) ahead of every counted value. */
export function compareUnknownFirst(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return b - a;
}

export function strandingsIn(all: Stranding[], category: StrandingCategory): Stranding[] {
  return all.filter((s) => s.category === category);
}

/* ------------------------------------------------------------------ */
/* Saying what is at stake                                             */
/* ------------------------------------------------------------------ */

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * The stakes, in one clause. Never reassuring about something it does not know:
 * an unknown count says so instead of reading as "nothing".
 */
export function stakesOf(s: Stranding): string {
  const parts: string[] = [];
  if (s.commits === null) parts.push("commits uncounted");
  else if (s.commits > 0) parts.push(plural(s.commits, "commit") + " nowhere else");
  if (s.lines === null) parts.push("uncommitted lines uncounted");
  else if (s.lines > 0) parts.push(plural(s.lines, "uncommitted line"));
  if (s.wipRef) parts.push("snapshot on file");
  if (parts.length === 0) return "nothing unmerged — everything here is already on a remote";
  return parts.join(" · ");
}

/** Does this exist anywhere other than this disk? Three answers, never two. */
export function exposureOf(s: Stranding): Exposure {
  if (s.wipRef && s.category === "snapshot") return "unknown";
  if (s.commits === null || s.lines === null) return "unknown";
  if (s.commits === 0 && s.lines === 0) return "pushed";
  return "nowhere-else";
}

export const EXPOSURE_LABEL: Record<Exposure, { label: string; tip: string }> = {
  "nowhere-else": {
    label: "nowhere else",
    tip: "These commits have no upstream copy. If this disk goes, they go.",
  },
  pushed: {
    label: "also on a remote",
    tip: "Nothing here is unmerged — a remote already has it. Safe to delete.",
  },
  unknown: {
    label: "unverified",
    tip: "Nothing could count what exists only here, so this is not evidence of safety.",
  },
};

/* ------------------------------------------------------------------ */
/* The two verbs                                                       */
/* ------------------------------------------------------------------ */

/** One step of the rescue, ready to paste. */
export interface RecoverStep {
  command: string;
  why: string;
}

/**
 * How the stranded work gets into the task the screen just created.
 *
 * This is a DEPARTURE FROM THE SPEC forced by the committed API, and it is
 * stated rather than papered over: `POST /api/tasks` takes `{ task, project }`
 * and nothing else, so it always branches from the base — there is no committed
 * route that checks a stranded branch or a wip ref out into a new worktree.
 * The task creation is therefore real, and the graft is a command the reader
 * runs. The snapshot lines are `src/wip-snapshot.ts`'s own documented recovery
 * recipe, pointed at the new worktree.
 */
export function recoverSteps(s: Stranding, worktreePath: string): RecoverStep[] {
  const at = `git -C ${worktreePath}`;
  if (s.wipRef && s.category === "snapshot") {
    return [
      { command: `git show ${s.wipRef} --stat`, why: "See what the snapshot actually holds before taking it." },
      { command: `${at} restore --source ${s.wipRef} -- .`, why: "Lay the snapshotted files into the new worktree as uncommitted changes." },
    ];
  }
  const steps: RecoverStep[] = [];
  if (s.branch) {
    steps.push({ command: `${at} log --oneline ${s.branch}`, why: "Read the stranded commits before you take them." });
    steps.push({ command: `${at} merge --no-ff ${s.branch}`, why: "Bring the stranded branch into the new task's branch." });
  }
  if (s.wipRef) {
    steps.push({ command: `${at} restore --source ${s.wipRef} -- .`, why: "Then lay the snapshotted uncommitted state on top." });
  }
  if (steps.length === 0) {
    steps.push({ command: `${at} status`, why: "This stranding names no branch and no snapshot — there is nothing to graft." });
  }
  return steps;
}

/** The description the rescue task is created with. */
export function recoverTaskDescription(s: Stranding): string {
  const what = s.branch ?? s.slug ?? s.id;
  return `Recover stranded work from ${what}`;
}

/**
 * Is there a committed PER-ITEM route that can delete this stranding?
 *
 * Only the stale task record: `DELETE /api/tasks/:slug`. `POST
 * /api/doctor/clean` acts on the WHOLE report at once (`cleanJunk` iterates
 * every item it was handed), so wiring a per-row button to it would delete
 * things the reader never looked at — and a screen whose whole premise is that
 * delete must not be the easy click cannot offer that button. The other kinds
 * therefore show the CLI command instead, which at least makes the blast
 * radius visible before it runs.
 */
export function canDiscard(s: Stranding): boolean {
  return s.junkKind === "orphan-worktree-task";
}

/** What `baton clean` is, for the rows no per-item route can delete. */
export const DISCARD_CLI = "baton clean --apply";

/** The sentence a delete confirmation has to name. Consequence, not reassurance. */
export function discardConsequence(s: Stranding): string {
  const commits =
    s.commits === null
      ? "an unknown number of commits"
      : s.commits === 0
        ? "no unmerged commits"
        : plural(s.commits, "commit") + " that exist nowhere else";
  return `This deletes the task record and its branch, and with it ${commits}. Nothing in Baton can bring them back.`;
}
