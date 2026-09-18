// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — the worktree flow's shared vocabulary

   `state` and `health` are two different questions and this file keeps
   them apart on purpose (src/worktrees.ts:19-27): `state` is the
   lifecycle value the daemon was TOLD, `health` is what the disk SAYS.
   A task can be `active` and `abandoned` at once — that pair is the
   whole feature, so health renders as a modifier on the card, never as
   a second state pill.

   Every colour here is one of the semantic tokens at
   styles/tokens.css:124-147 (--clean --dirty --conflict --ready --idle)
   returned as a `var(...)` string. That is deliberate: a token resolved
   by the browser at paint time follows a theme switch for free, which
   is exactly what components/GraphCanvas.tsx:60-65 does NOT do (it
   reads the tokens once in a `[]` effect and keeps the old palette
   forever). The only place this screen resolves a token to a literal
   colour is the minimap, which needs an SVG fill — see useFlowTheme.ts
   for how that one stays honest across a theme change.
   ============================================================ */
import type { IconName } from "../Icon";
import type { TaskState, WorktreeHealth } from "../../types";

/**
 * Mirrors STATE_COLOR at features/Pipeline.tsx:47-56. Duplicated rather than
 * imported because Pipeline.tsx does not export it and is not in this change's
 * scope; if a third screen needs it, that is the moment to lift one copy into
 * a shared module rather than adding a third.
 */
export const STATE_COLOR: Record<TaskState, string> = {
  queued: "var(--idle)",
  claimed: "var(--accent)",
  active: "var(--accent)",
  paused: "var(--dirty)",
  review: "var(--dirty)",
  blocked: "var(--conflict)",
  done: "var(--clean)",
  cancelled: "var(--idle)",
};

export interface HealthMeta {
  /** Card wording. Names the evidence, not a verdict the daemon never issued. */
  label: string;
  color: string;
  icon: IconName;
  /** Tooltip: why this row says what it says. */
  blurb: string;
  /** Does this row want a human NOW? Drives the sort and the header count. */
  urgent: boolean;
}

/**
 * ONE GLYPH AND ONE WORD PER HEALTH VALUE, AND NO SHARING.
 *
 * `label` and `icon` are two of the three non-colour channels that carry
 * health (the third is the card's border pattern+width, in encoding.ts), so
 * both have to be unique across all eleven values or two of them become the
 * same node in a greyscale screenshot. They were NOT unique before
 * wt-flow-nodes: `alertTriangle` covered stalled, conflict and unknown at
 * once, and `alertOctagon` covered abandoned and missing — which made the
 * glyph channel worth roughly two bits instead of eleven values.
 *
 * `encoding.test.ts` pins the uniqueness, so adding a twelfth health value
 * that reuses a glyph fails the suite rather than quietly degrading.
 */
export const HEALTH_META: Record<WorktreeHealth, HealthMeta> = {
  /* --- the liveness vocabulary: four names, not a boolean --- */
  working: {
    label: "Working", color: "var(--clean)", icon: "zap", urgent: false,
    blurb: "The progress token advanced inside the period. Nothing to do.",
  },
  quiet: {
    label: "Quiet", color: "var(--dirty)", icon: "clock", urgent: false,
    blurb: "Silent past the period but still inside grace. Visible on purpose, and deliberately not an alarm.",
  },
  stalled: {
    label: "Stalled", color: "var(--conflict)", icon: "alertTriangle", urgent: true,
    blurb: "Past period and grace with nothing moving. Another agent can take this over.",
  },
  abandoned: {
    label: "Abandoned", color: "var(--conflict)", icon: "alertOctagon", urgent: true,
    blurb: "No process, no session, and work here exists nowhere else. This is the one that gets lost.",
  },
  /* --- git-truth modifiers, which outrank liveness --- */
  ok: {
    label: "Clean", color: "var(--idle)", icon: "check", urgent: false,
    blurb: "Nothing uncommitted and nobody is expected to be moving it.",
  },
  dirty: {
    label: "Uncommitted", color: "var(--dirty)", icon: "gitCommit", urgent: false,
    blurb: "Changes on disk that no commit holds, and no agent is here.",
  },
  conflict: {
    label: "Conflict", color: "var(--conflict)", icon: "gitMerge", urgent: true,
    blurb: "A person has to resolve this before 'is it moving' means anything.",
  },
  rebasing: {
    label: "Mid-operation", color: "var(--dirty)", icon: "history", urgent: true,
    blurb: "A rebase, merge, cherry-pick or revert is half-finished. The exact one is on the card.",
  },
  missing: {
    label: "Missing", color: "var(--conflict)", icon: "fileWarning", urgent: true,
    blurb: "Recorded as a worktree, but the directory is gone from disk.",
  },
  "orphan-disk": {
    label: "Orphan", color: "var(--idle)", icon: "folder", urgent: false,
    blurb: "On disk and known to git, but no task owns it.",
  },
  unknown: {
    label: "Unknown", color: "var(--idle)", icon: "wifiOff", urgent: true,
    blurb: "Git did not answer for this worktree. Reported as unknown rather than guessed as fine.",
  },
};

/** Health → the semantic token behind it, for anything that only needs a hue. */
export function healthColor(health: WorktreeHealth): string {
  return HEALTH_META[health]?.color ?? "var(--idle)";
}

/**
 * Quiet time, at a glance. Stays short enough to sit beside the slug at the
 * 11px floor — "1h 36m", not "1 hour and 36 minutes".
 */
export function quietLabel(ms: number | null): string {
  if (ms === null) return "no signal";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h}h ${rem}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
