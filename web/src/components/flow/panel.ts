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
      the worktree. There is no third branch that assembles a brief,
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

/** The only shape section 2 needs out of the pipeline read-model. */
export interface PanelPipeline {
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
  if (row.unprotected.atRisk) {
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

const ORPHAN_TIP =
  "No task owns this worktree, so there is no claim to move. Adopt it with `baton adopt` first.";

/**
 * Take over / Pause / Hand off all act on the TASK RECORD, and an orphan
 * worktree has none: the daemon answers those with an honest 404. Beyond that
 * the gates stop, deliberately — see rule 3 in the header.
 */
function recordGate(row: WorktreeRow, writeEnabled: boolean): ActionGate {
  if (!writeEnabled) return { enabled: false, tip: READ_ONLY_TIP };
  if (row.orphan || row.state === null) return { enabled: false, tip: ORPHAN_TIP };
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
 */
export function inspectGate(row: WorktreeRow): ActionGate {
  if (row.health === "missing") {
    return { enabled: false, tip: "The worktree directory is gone from disk — there is nothing left to read." };
  }
  if (row.orphan || row.state === null) return { enabled: false, tip: ORPHAN_TIP };
  return { enabled: true };
}

/* ---------- Copy prompt ---------------------------------------------- */

/**
 * The pickup command, in the CLI's own grammar (features/Handoff.tsx:153 and
 * :302 already copy this exact shape for a task brief). A worktree is a task
 * checkout, so `baton take` in its directory is what claims it.
 */
export function pickupCommand(row: WorktreeRow): string {
  return `cd ${row.worktreePath} && baton take ${row.slug}`;
}

export type CopyPrompt =
  | { kind: "brief"; label: string; text: string; tip: string }
  | { kind: "pickup"; label: string; text: string; tip: string };

/**
 * WHAT COPY PROMPT RESOLVES TO, AND WHY THERE ARE ONLY TWO ANSWERS.
 *
 * With an open brief it copies the brief BODY — the field the daemon documents
 * as "the resume prompt to paste into the next agent"
 * (src/handoff/resume.ts:BriefEntry.body), served by GET /api/handoffs and
 * copied here byte for byte. With no brief there is no prompt in existence, so
 * it copies the command that claims the worktree instead.
 *
 * There is deliberately no third branch. Assembling a plausible-looking brief
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
