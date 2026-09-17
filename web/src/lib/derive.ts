// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — board column derivation (ported from api.jsx)
   Columns are DERIVED from real contract fields — never a
   fabricated sub-state.
   ============================================================ */
import type { StatusRow, ColumnId } from "../types";

/**
 * Is there work here that exists nowhere else?
 *
 * Uncommitted changes, or commits that have never left this branch. `ahead` is
 * measured against the task's base, so it counts commits that are on no other
 * branch on this machine, let alone on a remote.
 *
 * A gone directory counts too: the recorded worktree is unreachable, so
 * whatever was in it is unreachable with it.
 */
function hasWorkAtRisk(s: StatusRow): boolean {
  return s.status === "missing" || s.status === "dirty" || s.ahead > 0 || s.filesChanged > 0;
}

/**
 * ORDER IS THE CONTRACT HERE. Several rows match more than one rule, and which
 * rule wins is the whole behaviour — see web/src/lib/derive.test.ts.
 *
 * The rule that used to sit second, `agent === null -> idle`, short-circuited
 * every check below it. When an agent process died, `agent` became null, so a
 * worktree holding hours of uncommitted work was filed under "Idle · No agent
 * attached" — beside tasks nobody had started. The dashboard reported dead work
 * as nothing-to-see-here, which is how a worktree gets abandoned and then lost.
 *
 * So: an absent agent is only "idle" once we know there is nothing to lose.
 */
export function deriveColumn(s: StatusRow): ColumnId {
  // Conflict stays first. It is the more specific answer — it names the actual
  // problem and the board already draws it as dangerous — and it outranks
  // "stopped" even for a dead agent, whose conflict is still the thing to fix.
  if (s.status === "conflict") return "conflict";
  // Work nobody is holding. Checked BEFORE the agent test, which is the fix.
  if (s.agent === null && hasWorkAtRisk(s)) return "stopped";
  // A recorded worktree with no directory is unreachable whatever is attached:
  // a process matched to a path that no longer exists is not doing work there.
  if (s.status === "missing") return "stopped";
  if (s.agent === null) return "idle"; // genuinely empty: no agent, nothing to lose
  if (s.status === "dirty") return "dirty";
  if (s.status === "clean" && s.ahead > 0) return "ready";
  return "active"; // agent attached, clean, nothing committed yet
}

export interface ColumnDef {
  id: ColumnId;
  label: string;
  hint: string;
  color: string;
  tokenSoft: string;
  tokenBorder: string;
}

export const COLUMN_DEFS: ColumnDef[] = [
  // Named for what is at stake, not for what is absent. "Idle · No agent
  // attached" described the agent; the human reading this column needs to know
  // there is work here that only exists on this disk.
  { id: "stopped", label: "Stopped", hint: "No agent · work at risk", color: "var(--conflict)", tokenSoft: "var(--conflict-soft)", tokenBorder: "var(--conflict-border)" },
  { id: "idle", label: "Idle", hint: "No agent attached", color: "var(--idle)", tokenSoft: "var(--idle-soft)", tokenBorder: "var(--idle-border)" },
  { id: "active", label: "Active", hint: "Agent attached · no commits yet", color: "var(--accent)", tokenSoft: "var(--accent-soft)", tokenBorder: "var(--accent-border)" },
  { id: "dirty", label: "In progress", hint: "Uncommitted changes", color: "var(--dirty)", tokenSoft: "var(--dirty-soft)", tokenBorder: "var(--dirty-border)" },
  { id: "conflict", label: "Conflict", hint: "Overlapping edits — merge risk", color: "var(--conflict)", tokenSoft: "var(--conflict-soft)", tokenBorder: "var(--conflict-border)" },
  { id: "ready", label: "Ready to merge", hint: "Clean · commits ahead", color: "var(--ready)", tokenSoft: "var(--ready-soft)", tokenBorder: "var(--ready-border)" },
];
