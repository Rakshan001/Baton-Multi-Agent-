/* ============================================================
   BATON — board column derivation (ported from api.jsx)
   Columns are DERIVED from real contract fields — never a
   fabricated sub-state.
   ============================================================ */
import type { StatusRow, ColumnId } from "../types";

export function deriveColumn(s: StatusRow): ColumnId {
  if (s.status === "conflict") return "conflict";
  if (s.agent === null) return "idle";
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
  { id: "idle", label: "Idle", hint: "No agent attached", color: "var(--idle)", tokenSoft: "var(--idle-soft)", tokenBorder: "var(--idle-border)" },
  { id: "active", label: "Active", hint: "Agent attached · no commits yet", color: "var(--accent)", tokenSoft: "var(--accent-soft)", tokenBorder: "var(--accent-border)" },
  { id: "dirty", label: "In progress", hint: "Uncommitted changes", color: "var(--dirty)", tokenSoft: "var(--dirty-soft)", tokenBorder: "var(--dirty-border)" },
  { id: "conflict", label: "Conflict", hint: "Overlapping edits — merge risk", color: "var(--conflict)", tokenSoft: "var(--conflict-soft)", tokenBorder: "var(--conflict-border)" },
  { id: "ready", label: "Ready to merge", hint: "Clean · commits ahead", color: "var(--ready)", tokenSoft: "var(--ready-soft)", tokenBorder: "var(--ready-border)" },
];
