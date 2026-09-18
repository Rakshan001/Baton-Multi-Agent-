// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — worktree flow layout

   A DETERMINISTIC layered layout, left to right, driven by the plan
   DAG: planId → phase → task, with `dependsOn` edges.

   Deterministic is the whole requirement, not a nicety. The screen
   repolls every few seconds and every SSE frame wakes it; a force
   simulation that re-settles on each of those is the single fastest way
   to make this canvas unusable, because nothing on it would ever be
   where you last looked. So: no simulation, no randomness, no clock.
   The same SET of rows always produces the same picture, and the
   incoming ORDER cannot change it either — everything is sorted before
   it is placed. `layout.test.ts` pins both properties.

   Nothing here touches React Flow beyond its `Node` type, so all of it
   is testable without a DOM.
   ============================================================ */
import type { Node } from "@xyflow/react";
import type { WorktreeRow } from "../../types";

/** Node box. Wide enough for a slug plus a branch at the 11px floor. */
export const NODE_W = 236;
export const NODE_H = 122;
/** Gap between layers (x) and between stacked nodes in one layer (y). */
export const COL_GAP = 92;
export const ROW_GAP = 26;
/** Gap between one plan's band and the next. Larger than ROW_GAP so a band
 *  boundary is legible before any grouping chrome exists (wt-flow-groups). */
export const BAND_GAP = 78;

export interface XY { x: number; y: number }

/** React Flow needs node data to be an index signature; the row is the payload. */
export interface WorktreeNodeData extends Record<string, unknown> {
  row: WorktreeRow;
}
export type WorktreeFlowNode = Node<WorktreeNodeData, "worktree">;

/** The band a row belongs to. `null` planId is its own band, sorted last:
 *  one-off tasks are not part of any plan's left-to-right story. */
function bandKey(row: WorktreeRow): string {
  return row.planId ?? "";
}

/** Band order: named plans alphabetically, the no-plan band last. Alphabetical
 *  rather than first-seen because first-seen depends on server order, and the
 *  server sorts by risk — which moves whenever a worktree gets dirty. */
function compareBands(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "") return 1;
  if (b === "") return -1;
  return a.localeCompare(b);
}

/** Phase order within a band. `null` phase sorts first and shares one layer. */
function phaseOf(row: WorktreeRow): number {
  return row.phase ?? 0;
}

/**
 * Longest `dependsOn` chain within one layer group, as a column offset.
 *
 * Only edges INSIDE the group count: a dependency on an earlier phase is
 * already expressed by the phase base below, and a dependency on another plan
 * is drawn as an edge but must not drag a node out of its own band's grid.
 *
 * `dependsOn` is validated acyclic at src/plan.ts:470, but this is a browser
 * reading whatever the daemon served, so the walk carries its own cycle guard
 * rather than trusting that — a hang here would take the whole screen with it.
 */
function localDepths(group: WorktreeRow[]): Map<string, number> {
  const bySlug = new Map(group.map((r) => [r.slug, r]));
  const depth = new Map<string, number>();
  const onStack = new Set<string>();

  const walk = (slug: string): number => {
    const cached = depth.get(slug);
    if (cached !== undefined) return cached;
    if (onStack.has(slug)) return 0; // cycle: stop, do not recurse further
    onStack.add(slug);
    const row = bySlug.get(slug)!;
    let d = 0;
    // Sorted so the walk order cannot depend on how the daemon listed them.
    for (const dep of [...row.dependsOn].sort()) {
      if (!bySlug.has(dep)) continue;
      d = Math.max(d, walk(dep) + 1);
    }
    onStack.delete(slug);
    depth.set(slug, d);
    return d;
  };

  for (const r of [...group].sort((a, b) => a.slug.localeCompare(b.slug))) walk(r.slug);
  return depth;
}

/**
 * Rows → a position per slug.
 *
 * Columns are cumulative across phases: a phase's base is the previous phase's
 * base plus its widest local chain plus one, so a phase can never share a
 * column with the phase before it however deep its internal dependencies run.
 * Without that, a phase-1 task with one dependency landed in the same column as
 * an independent phase-2 task and the picture stopped reading left to right.
 */
export function layoutWorktrees(rows: WorktreeRow[]): Map<string, XY> {
  const positions = new Map<string, XY>();
  const bands = [...new Set(rows.map(bandKey))].sort(compareBands);
  let bandTop = 0;

  for (const band of bands) {
    const inBand = rows.filter((r) => bandKey(r) === band);
    const phases = [...new Set(inBand.map(phaseOf))].sort((a, b) => a - b);

    // Pass 1: column per slug, walking phases in order so the base accumulates.
    const column = new Map<string, number>();
    let base = 0;
    for (const phase of phases) {
      const group = inBand.filter((r) => phaseOf(r) === phase);
      const depths = localDepths(group);
      let widest = 0;
      for (const r of group) {
        const d = depths.get(r.slug) ?? 0;
        column.set(r.slug, base + d);
        widest = Math.max(widest, d);
      }
      base += widest + 1;
    }

    // Pass 2: stack each column, and remember the tallest so the next band
    // starts below this one rather than on top of it.
    const byColumn = new Map<number, WorktreeRow[]>();
    for (const r of inBand) {
      const c = column.get(r.slug) ?? 0;
      const list = byColumn.get(c);
      if (list) list.push(r);
      else byColumn.set(c, [r]);
    }
    let tallest = 0;
    for (const [c, list] of byColumn) {
      // Slug order inside a column: the one tiebreak that cannot move between
      // polls. Sorting by health or risk would reshuffle the canvas the moment
      // a worktree got dirty, which is the failure this file exists to avoid.
      list.sort((a, b) => a.slug.localeCompare(b.slug));
      list.forEach((r, i) => {
        positions.set(r.slug, {
          x: c * (NODE_W + COL_GAP),
          y: bandTop + i * (NODE_H + ROW_GAP),
        });
      });
      tallest = Math.max(tallest, list.length);
    }
    bandTop += tallest * (NODE_H + ROW_GAP) - ROW_GAP + BAND_GAP;
  }

  return positions;
}

/**
 * `dependsOn` → edges, dependency on the left, dependent on the right.
 *
 * Only edges whose BOTH endpoints are on the canvas: a dependency on a task
 * with no worktree yet has no node to attach to, and React Flow drops a
 * dangling edge silently anyway — so filtering here keeps the count honest for
 * anything that later wants to report it.
 */
export function worktreeEdges(rows: WorktreeRow[]): Array<{ id: string; source: string; target: string }> {
  const known = new Set(rows.map((r) => r.slug));
  const edges: Array<{ id: string; source: string; target: string }> = [];
  for (const r of [...rows].sort((a, b) => a.slug.localeCompare(b.slug))) {
    for (const dep of [...r.dependsOn].sort()) {
      if (!known.has(dep) || dep === r.slug) continue;
      edges.push({ id: `${dep}->${r.slug}`, source: dep, target: r.slug });
    }
  }
  return edges;
}

/**
 * MERGE, never re-seed. This is the function the screen's usability rests on.
 *
 * A fresh `layoutWorktrees(...)` on every poll would be deterministic but would
 * still throw away anything the person had done: a dragged node would snap
 * back, and — because React Flow tracks selection ON the node object — a
 * multi-selection would evaporate every few seconds.
 *
 * So an existing slug keeps its own node object's `position` (the dragged one,
 * or the one it was first laid out at) and everything React Flow wrote onto it
 * (`selected`, `dragging`, measured size). Only `data` is replaced, which is
 * what makes the card redraw. A layout position is allocated ONLY for a slug
 * that was not here before — and a slug that has gone is dropped.
 *
 * Nothing in here touches the viewport, which is the other half of the promise:
 * the canvas cannot move on a refresh if no code path asks it to.
 */
export function mergeFlowNodes(
  prev: Map<string, WorktreeFlowNode>,
  rows: WorktreeRow[],
  positions: Map<string, XY>,
): Map<string, WorktreeFlowNode> {
  const next = new Map<string, WorktreeFlowNode>();
  for (const row of rows) {
    const existing = prev.get(row.slug);
    if (existing) {
      // New object (React Flow compares node identity to decide what to
      // repaint) but the SAME position object, so no move is even expressible.
      next.set(row.slug, { ...existing, data: { row } });
    } else {
      next.set(row.slug, {
        id: row.slug,
        type: "worktree",
        position: positions.get(row.slug) ?? { x: 0, y: 0 },
        data: { row },
      });
    }
  }
  return next;
}
