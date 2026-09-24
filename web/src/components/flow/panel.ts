// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — what the worktree detail panel DECIDES

   Every judgement the panel makes lives here, as a pure function over
   the read-models the daemon already serves, so it can be pinned by a
   test instead of eyeballed in a browser. features/WorktreePanel.tsx
   is the presentation and holds no rules.

   THE THREE RULES THIS FILE EXISTS TO KEEP:

   1. ORDER IS DIAGNOSIS-FIRST, AND IT IS DATA.
      `PANEL_SECTION_ORDER` is the plan's order (verdict → why → who →
      work → progress → identity → actions), exported so a test fails
      if somebody puts identity back at the top. This panel is read by
      a person who has just found stuck work: the name of the branch is
      the last thing they need and the first thing a conventional
      detail pane would show them.

   2. THE BROWSER NEVER WRITES A REFUSAL AND NEVER WRITES A PROMPT.
      `blockerFor` passes the pipeline's own sentence through untouched
      (types.ts:LaneTask.blocker — "rendered verbatim, the dashboard
      must not invent a second vocabulary for a refusal the CLI answers
      to"), and `resolveCopyPrompt` can only ever return text the
      DAEMON produced: a brief's body, or the CLI command that claims
      the worktree (or, for an orphan, inspects it). There is no branch
      that assembles a brief,
      because a fabricated handoff read as a real one is worse than no
      handoff at all.

   3. THE WRITE GATES DO NOT RE-IMPLEMENT THE LIFECYCLE BARRIER.
      `takeover` refuses non-active work, work that is already yours,
      and anything that showed activity inside the stall window
      (src/lifecycle.ts:158-171) — and that refusal arrives here as a
      409 carrying the CLI's own sentence. So the gates below check only
      the two things that make the BUTTON meaningless (no `--write`, or
      no task record to act on) and let the daemon answer everything
      else. A second copy of the barrier in the browser would disagree
      with the first exactly when it mattered: a dashboard offering a
      takeover every agent is refused, or hiding one that would have
      worked.
   ============================================================ */
import type { WorktreeRow } from "../../types";
import { HEALTH_META } from "./health";

/* ---------- which rows are Baton's -------------------------------------
   The daemon lists every worktree git knows (src/worktrees.ts:WorktreeKind).
   Only a `task` row has a record to act on; `task` and `orphan` are the ones
   Baton made; `main` and `external` are shown and never acted on. */

type KindOf = Pick<WorktreeRow, "kind">;

/** A task row: the only kind any write, the ledger, or a brief applies to. */
export const isTaskRow = (row: KindOf): boolean => row.kind === "task";

/** A row Baton made: a task, or an orphan of one. */
export const isBatonRow = (row: KindOf): boolean => row.kind === "task" || row.kind === "orphan";

/** At risk as the screen COUNTS it. A row Baton does not track is never read,
 *  so its fail-closed `atRisk` is not "work that exists nowhere else". */
export const shownAtRisk = (row: Pick<WorktreeRow, "kind" | "unprotected">): boolean =>
  isBatonRow(row) && row.unprotected.atRisk;

/** The name a person reads: the task slug, or the directory part of a non-task
 *  id (`<name>~<hash>`). The full id belongs in a `title`. */
export function displayName(row: Pick<WorktreeRow, "kind" | "slug">): string {
  if (isTaskRow(row)) return row.slug;
  const cut = row.slug.lastIndexOf("~");
  return cut > 0 ? row.slug.slice(0, cut) : row.slug;
}

/**
 * The Worktrees screen's one-line count, over Baton's rows only: a main
 * checkout is not "work that exists nowhere else". Null only when there are
 * no rows at all — the true empty state. With only rows Baton did not create,
 * it still speaks, so the screen keeps showing them.
 */
export function worktreeSummary(rows: readonly WorktreeRow[]): string | null {
  if (rows.length === 0) return null;
  const baton = rows.filter(isBatonRow);
  const others = `${rows.length - baton.length} not Baton's`;
  if (baton.length === 0) return `No Baton worktrees · ${others}`;
  // An unrecognised health counts as needing attention, never as fine.
  const urgent = baton.filter((r) => HEALTH_META[r.health]?.urgent ?? true).length;
  const atRisk = baton.filter(shownAtRisk).length;
  return `${baton.length} worktree${baton.length === 1 ? "" : "s"} · ${urgent} needing attention · ${atRisk} holding work that exists nowhere else`
    + (rows.length > baton.length ? ` · +${others}` : "");
}

/* ---------- the two read-models this module reads, NARROWED ----------
   `blockerFor` and `resolveCopyPrompt` take structural shapes rather than the
   full `PipelineView` / `HandoffBriefEntry` from types.ts, and that is
   deliberate: these are the only fields either function touches, so neither
   this module nor panel.test.ts pins a shape it does not use. A fixture that
   had to spell out every field of a brief would break the day an unrelated
   field is added to the brief — and a test that compiles only against one
   revision of types.ts is worse than no test. The real types satisfy these
   structurally, so callers pass them unchanged. */

/** The only fields Copy prompt reads off a handoff brief. */
export interface PanelBrief {
  slug: string;
  /** Body without frontmatter — what the daemon documents as the resume
   *  prompt to paste into the next agent. */
  body: string;
  /** The whole HANDOFF.md, frontmatter included. */
  markdown: string;
}

/** The only shape section 2 and the merge gate need out of the pipeline
 *  read-model. `integrationHold` is the phase barrier's own answer
 *  (src/pipeline-view.ts:167 — the number `integrationHold()` returned), and it
 *  is read here rather than fetched again because the panel already joins
 *  worktree to pipeline task by slug. */
export interface PanelPipeline {
  integrationHold: number | null;
  lanes: ReadonlyArray<{ tasks: ReadonlyArray<{ slug: string; blocker: string | null }> }>;
}

/** The plan's panel order, as data so `panel.test.ts` can pin it. */
export const PANEL_SECTION_ORDER = [
  "verdict",
  "why",
  "who",
  "work",
  "progress",
  "identity",
  "files",
  "actions",
] as const;

export type PanelSection = (typeof PANEL_SECTION_ORDER)[number];

/* ---------- the progress ledger read-model ----------------------------
   Mirrors `ProgressView` in src/handoff/progress-ledger.ts:175, which
   GET /api/worktrees/:slug/progress serves verbatim. Declared here rather
   than in types.ts because this change does not own that file; if a second
   screen ever reads the ledger, that is the moment to lift it. Every
   optional field is an explicit null for the reason the daemon states: a
   reader must never have to guess whether `undefined` means "not flagged"
   or "field not served". */

export interface WorktreeTodo {
  content: string;
  status: string;
}

export interface WorktreeDiffStamp {
  filesChanged: number;
  insertions: number;
  deletions: number;
  commits: number;
}

export interface WorktreeProgress {
  slug: string;
  /** False when nothing was ever checkpointed for this slug. */
  hasLedger: boolean;
  plan: WorktreeTodo[];
  notes: string[];
  next: string | null;
  filesEdited: string[];
  stamp: WorktreeDiffStamp | null;
  /** The overclaim marker, VERBATIM — never softened or dropped. */
  flagged: string | null;
  updatedAt: string | null;
}

/* ---------- section 2: why ------------------------------------------- */

/**
 * The pipeline's own sentence for why this slug cannot start, or null.
 *
 * A worktree row does not carry one — `src/worktrees.ts` answers "what is on
 * disk", and "why is this refused" is the pipeline's question
 * (src/pipeline-view.ts:51 takes it verbatim from `blockers()`). So the panel
 * joins the two by slug and renders whatever comes back, unedited.
 */
export function blockerFor(pipeline: PanelPipeline | null, slug: string): string | null {
  if (!pipeline) return null;
  for (const lane of pipeline.lanes) {
    const task = lane.tasks.find((t) => t.slug === slug);
    if (task) return task.blocker;
  }
  return null;
}

/* ---------- section 3: who ------------------------------------------- */

/**
 * `agent` is the process actually detected; `claimedBy` is who the task RECORD
 * says holds it. They differ in exactly one situation and it is the situation
 * this whole screen exists for: the holder died.
 */
export interface WhoFacts {
  /** The agent handle to badge, preferring the live process over the record. */
  badge: string | null;
  /** Is a process genuinely alive in this worktree? */
  running: boolean;
  /** One sentence naming the evidence, never a verdict the daemon never issued. */
  line: string;
}

export function whoFacts(row: WorktreeRow): WhoFacts {
  const badge = row.agent ?? row.claimedBy ?? null;
  if (row.agent && row.holderRunning) {
    return { badge, running: true, line: `${row.agent} is running in this worktree.` };
  }
  if (row.claimedBy && !row.holderRunning) {
    return {
      badge,
      running: false,
      line: `${row.claimedBy} holds this task, but no process is running in the worktree.`,
    };
  }
  if (row.claimedBy) {
    return { badge, running: row.holderRunning, line: `${row.claimedBy} holds this task.` };
  }
  return { badge: null, running: false, line: "Nobody holds this worktree." };
}

/* ---------- section 4: work in flight -------------------------------- */

export interface WorkFact {
  key: string;
  label: string;
  /** Already-formatted value. "unknown" is a real answer and says so. */
  value: string;
  tip: string;
  /** Wants attention: drives the one accent this section is allowed. */
  urgent: boolean;
}

const countOrUnknown = (n: number | null): string => (n === null ? "unknown" : String(n));

/**
 * Ahead/behind, files changed, conflicts — and nothing invented. A null
 * counter renders as "unknown" rather than 0, because "git did not answer" and
 * "nothing changed" are opposite facts about whether work is safe.
 */
export function workInFlightFacts(row: WorktreeRow): WorkFact[] {
  const facts: WorkFact[] = [
    {
      key: "ahead",
      label: "ahead",
      value: countOrUnknown(row.ahead),
      tip: "Commits on this branch that the base branch does not have",
      urgent: false,
    },
    {
      key: "behind",
      label: "behind",
      value: countOrUnknown(row.behind),
      tip: "Commits on the base branch this worktree has not taken",
      urgent: (row.behind ?? 0) > 0,
    },
    {
      key: "files",
      label: row.filesChanged === 1 ? "file changed" : "files changed",
      value: countOrUnknown(row.filesChanged),
      tip: "Uncommitted files in the worktree",
      urgent: false,
    },
  ];
  if (row.repoState && row.repoState !== "clean") {
    facts.push({
      key: "repoState",
      label: "half-finished",
      value: row.repoState,
      tip: "An in-progress git operation nobody has finished",
      urgent: true,
    });
  }
  if (!isBatonRow(row)) {
    facts.push({
      key: "atRisk",
      label: "exists nowhere else",
      value: "not read — Baton does not track this worktree",
      tip: "Baton reads no git state for a worktree it did not create",
      urgent: false,
    });
  } else if (row.unprotected.atRisk) {
    const parts: string[] = [];
    if (row.unprotected.lines > 0) parts.push(`${row.unprotected.lines} lines`);
    if (row.unprotected.commits) parts.push(`${row.unprotected.commits} commits`);
    facts.push({
      key: "atRisk",
      label: "exists nowhere else",
      value: parts.length ? parts.join(" · ") : "at risk",
      tip: "Uncommitted lines plus commits that live only on this disk",
      urgent: true,
    });
  }
  return facts;
}

/* ---------- section 5: what it said it was doing --------------------- */

export interface PlanProgress {
  done: number;
  total: number;
}

export function planProgress(view: WorktreeProgress): PlanProgress {
  return {
    done: view.plan.filter((p) => p.status === "completed").length,
    total: view.plan.length,
  };
}

/**
 * The one line above the ledger.
 *
 * "Said nothing" is a real answer with its own sentence — the daemon goes out
 * of its way not to collapse it into a 404 (server.ts:2168), and a panel that
 * rendered an empty list there would throw that distinction away.
 */
export function progressHeadline(view: WorktreeProgress): string {
  if (!view.hasLedger) {
    return "This worktree never checkpointed. There is no record of what it was doing.";
  }
  const { done, total } = planProgress(view);
  const plan = total > 0 ? `${done} of ${total} planned items done` : "no plan recorded";
  const notes = view.notes.length === 1 ? "1 note" : `${view.notes.length} notes`;
  return `${plan} · ${notes}`;
}

/* ---------- section 7: actions --------------------------------------- */

/** The tooltip this codebase already uses for a write the daemon will refuse
 *  (features/Settings.tsx:564). Copied, not reworded: two sentences for one
 *  refusal is how a dashboard starts teaching two different things. */
export const READ_ONLY_TIP =
  "Read-only — enable Write actions (the daemon needs baton serve --write)";

export interface ActionGate {
  enabled: boolean;
  /** Present only when disabled — why the button will not act. */
  tip?: string;
}

/** What to DO with an orphan, in commands that exist. There is no adopt
 *  command; `baton clean` (src/cleanup.ts) is what removes one. `--fix` also
 *  deletes its branch (the tip is archived) and every other item the dry run
 *  listed, so the sentence says both before anybody runs it. */
const ORPHAN_NEXT =
  "Inspect the directory, commit or push anything worth keeping, then run `baton clean` to see what it would remove. `baton clean --fix` removes it and deletes its branch (the tip is kept under refs/baton/archive/). It also removes any other junk the dry run listed. A dirty orphan is skipped unless you also pass `-f`. In a multi-repo hub, `baton clean` scans only the hub's own repo.";

const ORPHAN_TIP = `No task owns this worktree, so there is no claim to move. ${ORPHAN_NEXT}`;

/** A main checkout or another tool's worktree. Never names `baton clean`:
 *  clean does not touch these, and must not be suggested as if it did. */
export const NOT_BATONS_TIP =
  "Baton did not create this worktree. It is shown so you can see it; nothing here takes, pauses, merges, removes or cleans it. Its diff is read-only, against HEAD (no base branch to compare).";

/** Why a row with no task record refuses: the orphan's sentence, or not-Baton's. */
const noTaskTip = (row: WorktreeRow, orphanTip: string): string =>
  isBatonRow(row) ? orphanTip : NOT_BATONS_TIP;

/**
 * Take over / Pause / Hand off all act on the TASK RECORD, and an orphan
 * worktree has none: the daemon answers those with an honest 404. Beyond that
 * the gates stop, deliberately — see rule 3 in the header.
 */
function recordGate(row: WorktreeRow, writeEnabled: boolean): ActionGate {
  if (!isTaskRow(row) || row.state === null) return { enabled: false, tip: noTaskTip(row, ORPHAN_TIP) };
  if (!writeEnabled) return { enabled: false, tip: READ_ONLY_TIP };
  return { enabled: true };
}

export const takeoverGate = recordGate;
export const pauseGate = recordGate;
export const handoffGate = recordGate;

/**
 * Open Live and Diff are READS. They are not gated on `--write`, and that is
 * the daemon's own decision carried up: GET /api/worktrees is "read-only and
 * deliberately not write-gated — somebody looking for work that has gone quiet
 * must be able to see it from a daemon that cannot touch anything"
 * (server.ts:2145). Gating the inspection behind the verb would lock the panel
 * away from exactly the person it was built for.
 *
 * What DOES disable them is having nothing to read: a directory that is gone,
 * or a worktree with no task to diff.
 *
 * Live and Diff no longer share one gate: Live needs an agent-in-worktree
 * target, which only a task row has, but Diff works for ANY kind now
 * (GET /api/worktrees/:id/diff, phase 5 C2) — so Diff's gate must not refuse
 * an orphan/main/external row the way Live's still does.
 */
export function liveGate(row: WorktreeRow): ActionGate {
  if (!isTaskRow(row) || row.state === null) return { enabled: false, tip: noTaskTip(row, ORPHAN_TIP) };
  if (row.health === "missing") {
    return { enabled: false, tip: "The worktree directory is gone from disk — there is nothing left to read." };
  }
  return { enabled: true };
}

/**
 * Diff is a read for ANY worktree kind — task, orphan, main or external
 * (GET /api/worktrees/:id/diff for the last three, GET /api/tasks/:slug/diff
 * for a task). It only refuses when there is nothing left to read at all: a
 * directory gone from disk. `collectDiff` already degrades to an empty,
 * non-error result rather than failing, so an empty-but-valid diff on a stale
 * row is an acceptable outcome, not something this gate needs to predict.
 */
export function diffGate(row: WorktreeRow): ActionGate {
  if (row.health === "missing") {
    return { enabled: false, tip: "The worktree directory is gone from disk — there is nothing left to read." };
  }
  return { enabled: true };
}

/* ---------- Merge: the one button here that can land work somewhere ---

   WHY THIS GATE IS LONGER THAN THE OTHERS, AND WHY IT CARRIES ITS TARGET.

   `mergeTaskBranch` merges into `currentBranch(gitRepo)`
   (src/commands/merge.ts:104) and makes no reference to the task's own base
   branch. On a canvas showing a dozen worktrees at once, a button labelled
   just "Merge" therefore lands work on whatever branch the hub repo happens
   to be sitting on — which the person clicking cannot see from here. So the
   gate carries the TARGET with it, read from GET /api/meta (`branch`,
   src/server.ts:2218, which is the same `currentBranch(root)` call the merge
   will make), and when the daemon cannot name that branch the button refuses
   instead. There is deliberately no fallback to "main": features/Board.tsx
   hard-codes that word in its own merge dialog, and a dialog naming a branch
   the merge will not use is worse than one that admits it does not know.

   WHY EVERY UNKNOWN REFUSES. `repoState`, `filesChanged`, `ahead` and
   `behind` are all nullable because git can fail to answer, and "git did not
   answer" is not "the worktree is clean". Each null below withholds the
   button and names the fact that is missing, the same rule the rest of this
   file keeps.

   WHAT THIS GATE DOES NOT DO is decide the merge is SAFE. It decides the
   BUTTON is meaningful. The merge itself stays the daemon's, and a merge that
   hits conflicts comes back 409 carrying its own file list. */

/** The only fields the merge gate reads out of GET /api/meta. Narrowed for the
 *  reason stated above `PanelBrief`: a fixture spelling out the whole of `Meta`
 *  would pin a shape this module does not use. */
export interface PanelMeta {
  /** The branch the daemon's root repo is on — null when the root is not a git
   *  repo at all, which is a hub. */
  branch: string | null;
  /** True when the root is a multi-repo hub, where the branch a merge lands on
   *  belongs to the SUB-PROJECT's repo (`task.repoRoot`,
   *  src/commands/merge.ts:100) and is therefore not the one `/api/meta`
   *  reports. */
  hub?: boolean;
}

export const MERGE_NO_TASK_TIP =
  `No task owns this worktree, so there is no task branch to merge. ${ORPHAN_NEXT}`;

/**
 * What the Merge button may do — and, when it may not, the sentence saying so.
 *
 * `target` and `commits` are only present on the enabled arm on purpose: the
 * confirmation has to name both, and a shape where they were optional
 * everywhere would let a dialog render "merge into undefined".
 */
export type MergeGate =
  | {
      enabled: true;
      /** The branch the daemon says it is on: where this merge lands. */
      target: string;
      /** Commits this branch would bring over. 0 is a real answer. */
      commits: number;
      /** Commits the target has that this branch does not. */
      behind: number;
      tip?: undefined;
      refused?: undefined;
    }
  | {
      enabled: false;
      tip: string;
      /**
       * True when something REFUSES this merge — the phase barrier, a sentence
       * the pipeline issued, an unresolved conflict, a target that cannot be
       * named — rather than the work simply not being finished yet. The
       * wording is identical either way; this only decides whether the panel
       * says it out loud instead of leaving it in a tooltip on a disabled
       * button, which is easy to never see.
       */
      refused: boolean;
      target?: undefined;
      commits?: undefined;
      behind?: undefined;
    };

/**
 * Merge is offered only for a worktree that is clean, conflict-free, whose
 * task the record says is done, and whose phase barrier is not holding — with
 * the branch it would land on read from the daemon.
 *
 * ON "done OR APPROVED": `done` is the only one of those two this screen can
 * evidence. The review verdict the pipeline keeps
 * (src/pipeline.ts:80 — `reviewedBy.verdict: 'approve' | 'reject'`) is NOT
 * carried into the read-model the dashboard is served: `LaneTask`
 * (src/pipeline-view.ts:35-60) has no such field, and neither does
 * `WorktreeRow`. So "approved" is a fact nothing served here can corroborate,
 * and an approval nobody can evidence is exactly what must not open this
 * button. A `review` task therefore gets a refusal that says which fact is
 * missing rather than a silent no.
 */
export function mergeGate(
  row: WorktreeRow,
  pipeline: PanelPipeline | null,
  meta: PanelMeta | null,
  writeEnabled: boolean,
): MergeGate {
  const no = (tip: string, refused = false): MergeGate => ({ enabled: false, tip, refused });

  if (!isTaskRow(row) || row.state === null) return no(noTaskTip(row, MERGE_NO_TASK_TIP));
  if (!writeEnabled) return no(READ_ONLY_TIP);
  if (!row.branch) return no(`'${row.slug}' has no branch recorded, so there is nothing to merge.`);

  /* 1 — the task record has to say the work is finished. See the note above. */
  if (row.state !== "done") {
    return no(row.state === "review"
      ? `'${row.slug}' is awaiting review. Merge opens once the task record says done — nothing served to this screen reports a review verdict, and an approval this screen cannot evidence is not one.`
      : `'${row.slug}' is ${row.state}. Merge is offered for work the task record says is done.`);
  }

  /* 2 — the phase barrier, which REFUSES rather than warns. */
  if (!pipeline) return no("Reading the pipeline — the phase barrier has not answered yet, and an unanswered barrier is not a cleared one.");
  // Verbatim, when the pipeline has a sentence for this slug at all. It
  // normally will not: `blockers()` skips terminal states
  // (src/pipeline.ts:283), so a done task carries none — which is exactly why
  // the hold below has to be read off the view's own `integrationHold`.
  const blocker = blockerFor(pipeline, row.slug);
  if (blocker) return no(blocker, true);
  const held = pipeline.integrationHold;
  if (held !== null) {
    // A worktree with no phase cannot be placed either side of the barrier,
    // and the barrier exists because branches that were never combined can
    // each be correct and still not compose (src/pipeline.ts:136-152).
    if (row.phase === null) {
      return no(`Phase ${held} is finished but has not landed, and this worktree records no phase — so nothing here can say which side of the barrier it is on. Run \`baton integrate\` first.`, true);
    }
    if (row.phase > held) {
      return no(`Phase ${row.phase} is held: phase ${held} is finished but has not landed, so its branches have never been combined. Run \`baton integrate\` before merging this.`, true);
    }
    // phase <= held: merging one of the held phase's own branches is what
    // CLEARS the barrier, so it is not refused by it.
  }

  /* 3 — the target branch, from the daemon or not at all. */
  if (!meta) return no("The daemon has not said which branch it is on, so there is no target to name. Refusing rather than guessing where this would land.", true);
  if (meta.hub) {
    return no(`This root is a multi-repo hub, so the merge lands on the sub-project repo's branch — which \`/api/meta\` does not report. Merge from inside that repo: \`baton merge ${row.slug}\`.`, true);
  }
  if (!meta.branch) {
    return no("The daemon reports no current branch, so this cannot name where the merge would land. Refusing rather than guessing.", true);
  }

  /* 4 — clean and conflict-free, with every unknown refusing. */
  if (row.health === "missing") return no("The worktree directory is gone from disk — there is nothing left to merge.");
  if (row.health === "conflict") {
    return no(`'${row.slug}' has unresolved conflicts in its worktree. Resolve them there and commit before merging.`, true);
  }
  if (row.health === "unknown") return no("Nothing is known about this worktree's git state, and not knowing is not the same as clean.");
  if (row.repoState === null) return no("Git did not answer what state this worktree is in, and not knowing is not the same as clean.");
  if (row.repoState !== "clean") {
    return no(`A ${row.repoState} operation is half-finished in this worktree. Finish or abort it before merging.`, true);
  }
  if (row.filesChanged === null) return no("Git did not answer how many files changed here, and not knowing is not the same as clean.");
  if (row.filesChanged > 0) {
    return no(`${row.filesChanged} uncommitted file${row.filesChanged === 1 ? "" : "s"} in this worktree. A merge would leave ${row.filesChanged === 1 ? "it" : "them"} behind — commit first.`);
  }
  if (row.ahead === null || row.behind === null) {
    return no("Git did not answer how far this branch is ahead or behind, so the number of commits this would land is unknown.");
  }

  return { enabled: true, target: meta.branch, commits: row.ahead, behind: row.behind };
}

/* ---------- Copy prompt ---------------------------------------------- */

/** A path as one shell word. Left bare when it is plainly safe, so the common
 *  path copies exactly as it reads; single-quoted otherwise. */
function shq(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * The pickup command, in the CLI's own grammar (features/Handoff.tsx:153 and
 * :302 already copy this exact shape for a task brief). A worktree is a task
 * checkout, so `baton take` in its directory is what claims it.
 *
 * `--resume` when somebody still holds active work: `baton take` refuses a
 * held task without it (src/commands/take.ts), so the copy would just fail.
 */
export function pickupCommand(row: WorktreeRow): string {
  const held = row.claimedBy !== null && (row.state === "active" || row.state === "claimed");
  return `cd ${shq(row.worktreePath)} && baton take ${row.slug}${held ? " --resume" : ""}`;
}

/** An orphan has no task to take, so the useful command is the one that looks. */
export function inspectCommand(row: WorktreeRow): string {
  return `cd ${shq(row.worktreePath)} && git status`;
}

export type CopyPrompt =
  | { kind: "brief"; label: string; text: string; tip: string }
  | { kind: "pickup"; label: string; text: string; tip: string }
  | { kind: "inspect"; label: string; text: string; tip: string };

/**
 * WHAT COPY PROMPT RESOLVES TO, AND WHY THERE ARE ONLY TWO ANSWERS.
 *
 * With an open brief it copies the brief BODY — the field the daemon documents
 * as "the resume prompt to paste into the next agent"
 * (src/handoff/resume.ts:BriefEntry.body), served by GET /api/handoffs and
 * copied here byte for byte. With no brief there is no prompt in existence, so
 * it copies the command that claims the worktree instead.
 *
 * An orphan has no task, so `baton take` would fail: it copies the command
 * that inspects the directory instead.
 *
 * There is deliberately no branch that ASSEMBLES a prompt. Assembling a plausible-looking brief
 * in the browser would produce a document that reads exactly like one an agent
 * wrote and carries none of the evidence — the single worst thing this panel
 * could hand somebody. Writing a real brief is what Hand off does, through the
 * daemon.
 */
export function resolveCopyPrompt(
  row: WorktreeRow,
  brief: PanelBrief | null,
  writeEnabled: boolean,
): CopyPrompt {
  // First, before any brief: a non-task row's id names no task, and a brief
  // joined on it would belong to some other worktree.
  if (!isTaskRow(row)) {
    return {
      kind: "inspect",
      label: "Copy inspect command",
      text: inspectCommand(row),
      tip: noTaskTip(row, `No task owns this worktree, so there is nothing to take. ${ORPHAN_NEXT}`),
    };
  }
  // `body` is the frontmatter-stripped brief; `markdown` is the whole file.
  // Preferring body, falling back to the file, means a brief that is somehow
  // all frontmatter still copies something real instead of an empty clipboard.
  const text = brief ? (brief.body.trim() || brief.markdown) : "";
  if (brief && text) {
    return {
      kind: "brief",
      label: "Copy prompt",
      text,
      tip: `Copies the open handoff brief for ${brief.slug}, exactly as the daemon built it`,
    };
  }
  return {
    kind: "pickup",
    label: "Copy pickup command",
    text: pickupCommand(row),
    tip: writeEnabled
      ? "No handoff brief exists, so there is no prompt to copy — this copies the command that claims the worktree. Use Hand off to have the daemon write a brief."
      : "No handoff brief exists, and a read-only daemon cannot write one — this copies the command that claims the worktree.",
  };
}

/** The open brief for this slug, if the daemon is serving one. */
export function briefFor<T extends { slug: string }>(
  briefs: readonly T[] | null,
  slug: string,
): T | null {
  return briefs?.find((b) => b.slug === slug) ?? null;
}
