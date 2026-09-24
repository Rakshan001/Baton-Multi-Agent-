// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The two properties the Worktrees canvas is unusable without.
 *
 * 1. The layout is DETERMINISTIC. The screen repolls every few seconds and
 *    every SSE frame wakes it, so a layout that depended on the order the
 *    daemon served (it sorts by RISK, which moves whenever a worktree gets
 *    dirty) or on anything time-like would redraw a different picture several
 *    times a minute.
 * 2. The node map MERGES rather than re-seeds. A fresh node array per poll is
 *    deterministic and still ruinous: it discards every drag and — because
 *    React Flow tracks selection on the node object — every multi-selection.
 */
import { describe, expect, it } from "vitest";
import {
  dropRemovals, layoutWorktrees, mergeFlowNodes, uniqueSlugs, worktreeEdges, NODE_W, COL_GAP,
  type WorktreeFlowNode,
} from "./layout";
import type { WorktreeRow } from "../../types";

const row = (over: Partial<WorktreeRow> & { slug: string }): WorktreeRow => ({
  branch: `baton/${over.slug}`,
  worktreePath: `/tmp/${over.slug}`,
  state: "active",
  health: "working",
  quietForMs: 0,
  lastActivityAt: null,
  unprotected: { lines: 0, commits: 0, atRisk: false },
  filesChanged: 0, ahead: 0, behind: 0, repoState: "clean",
  agent: null, claimedBy: null, holderRunning: false,
  planId: "p", phase: 1, dependsOn: [], orphan: false, wipRef: null,
  ...over,
});

const COL = NODE_W + COL_GAP;

describe("the layout is deterministic", () => {
  const rows = [
    row({ slug: "a", phase: 1 }),
    row({ slug: "b", phase: 2, dependsOn: ["a"] }),
    row({ slug: "c", phase: 2, dependsOn: ["a"] }),
    row({ slug: "d", phase: 3, dependsOn: ["b", "c"] }),
    row({ slug: "z", planId: null, phase: null }),
  ];

  it("gives the same picture however the daemon ordered the rows", () => {
    const forward = layoutWorktrees(rows);
    const reversed = layoutWorktrees([...rows].reverse());
    for (const r of rows) {
      expect(reversed.get(r.slug)).toEqual(forward.get(r.slug));
    }
  });

  it("repeats itself exactly", () => {
    expect(layoutWorktrees(rows)).toEqual(layoutWorktrees(rows));
  });

  it("advances phases left to right", () => {
    const pos = layoutWorktrees(rows);
    expect(pos.get("a")!.x).toBeLessThan(pos.get("b")!.x);
    expect(pos.get("b")!.x).toBeLessThan(pos.get("d")!.x);
  });

  it("puts siblings in one column and stacks them", () => {
    const pos = layoutWorktrees(rows);
    expect(pos.get("b")!.x).toBe(pos.get("c")!.x);
    expect(pos.get("b")!.y).not.toBe(pos.get("c")!.y);
  });

  it("bands a plan-less worktree below the plan, not on top of it", () => {
    const pos = layoutWorktrees(rows);
    expect(pos.get("z")!.y).toBeGreaterThan(pos.get("d")!.y);
  });

  it("never shares a column between consecutive phases, however deep the chain", () => {
    // Two chained tasks inside phase 1 push phase 2's base out by two columns;
    // before the cumulative base this landed 'late' on top of 'deep'.
    const pos = layoutWorktrees([
      row({ slug: "first", phase: 1 }),
      row({ slug: "deep", phase: 1, dependsOn: ["first"] }),
      row({ slug: "late", phase: 2 }),
    ]);
    expect(pos.get("first")!.x).toBe(0);
    expect(pos.get("deep")!.x).toBe(COL);
    expect(pos.get("late")!.x).toBe(2 * COL);
  });

  it("survives a dependency cycle the daemon should never have served", () => {
    // src/plan.ts:470 validates acyclicity, but this is a browser reading
    // whatever arrived; a hang here would take the whole screen down.
    const pos = layoutWorktrees([
      row({ slug: "x", dependsOn: ["y"] }),
      row({ slug: "y", dependsOn: ["x"] }),
    ]);
    expect(pos.size).toBe(2);
  });

  it("ignores a dependency on a slug that has no worktree", () => {
    const edges = worktreeEdges([row({ slug: "only", dependsOn: ["ghost"] })]);
    expect(edges).toEqual([]);
  });

  it("points an edge from the dependency to the dependent", () => {
    expect(worktreeEdges([row({ slug: "a" }), row({ slug: "b", dependsOn: ["a"] })]))
      .toEqual([{ id: "a->b", source: "a", target: "b" }]);
  });
});

describe("a poll merges into the graph instead of re-seeding it", () => {
  const seed = (rows: WorktreeRow[]) =>
    mergeFlowNodes(new Map<string, WorktreeFlowNode>(), rows, layoutWorktrees(rows));

  it("keeps a dragged position across a refresh", () => {
    const rows = [row({ slug: "a" })];
    const first = seed(rows);
    // The person drags it somewhere of their own choosing.
    const dragged = new Map(first);
    dragged.set("a", { ...first.get("a")!, position: { x: 999, y: -42 } });

    const after = mergeFlowNodes(dragged, rows, layoutWorktrees(rows), new Set(["a"]));
    expect(after.get("a")!.position).toEqual({ x: 999, y: -42 });
  });

  it("keeps a multi-selection across a refresh", () => {
    const rows = [row({ slug: "a" }), row({ slug: "b" })];
    const first = seed(rows);
    const selected = new Map(first);
    selected.set("a", { ...first.get("a")!, selected: true });
    selected.set("b", { ...first.get("b")!, selected: true });

    const after = mergeFlowNodes(selected, rows, layoutWorktrees(rows));
    expect(after.get("a")!.selected).toBe(true);
    expect(after.get("b")!.selected).toBe(true);
  });

  it("updates the data on the node it already had", () => {
    const rows = [row({ slug: "a", health: "working" })];
    const first = seed(rows);
    const next = [row({ slug: "a", health: "abandoned" })];
    const after = mergeFlowNodes(first, next, layoutWorktrees(next));
    expect(after.get("a")!.data.row.health).toBe("abandoned");
    // Same position OBJECT, not merely an equal one: nothing can move it.
    expect(after.get("a")!.position).toBe(first.get("a")!.position);
  });

  it("allocates a layout position only for a genuinely new slug", () => {
    const first = seed([row({ slug: "a" })]);
    const grown = [row({ slug: "a" }), row({ slug: "b", phase: 2, dependsOn: ["a"] })];
    const after = mergeFlowNodes(first, grown, layoutWorktrees(grown));
    expect(after.get("a")!.position).toBe(first.get("a")!.position);
    expect(after.get("b")!.position.x).toBe(COL);
  });

  it("moves an undragged node when a band above it grows", () => {
    // Nobody dragged `z`, so it has no position of its own to keep. Holding
    // the one it was first laid at would leave it under the grown band.
    const before = [row({ slug: "a" }), row({ slug: "z", planId: null, phase: null })];
    const first = seed(before);
    const grown = [...before, row({ slug: "b" }), row({ slug: "c" })];
    const positions = layoutWorktrees(grown);
    const after = mergeFlowNodes(first, grown, positions, new Set());
    expect(after.get("z")!.position).toEqual(positions.get("z"));
    expect(after.get("z")!.position.y).toBeGreaterThan(first.get("z")!.position.y);
    // A dragged one stays put through the same change.
    const pinned = mergeFlowNodes(first, grown, positions, new Set(["z"]));
    expect(pinned.get("z")!.position).toBe(first.get("z")!.position);
  });

  it("drops a worktree that is gone", () => {
    const first = seed([row({ slug: "a" }), row({ slug: "b" })]);
    const after = mergeFlowNodes(first, [row({ slug: "a" })], layoutWorktrees([row({ slug: "a" })]));
    expect([...after.keys()]).toEqual(["a"]);
  });
});

describe("the canvas cannot lose a worktree", () => {
  it("never lets the canvas delete a worktree", () => {
    // Backspace on a selected card makes React Flow emit a `remove`. A card
    // is a view of a directory on disk; deleting the card deletes nothing
    // but the only sign the directory is there.
    const kept = dropRemovals([
      { type: "remove", id: "a" },
      { type: "select", id: "b", selected: true },
      { type: "position", id: "c", position: { x: 1, y: 2 } },
    ]);
    expect(kept.map((c) => c.type)).toEqual(["select", "position"]);
  });

  it("never emits two rows with one slug", () => {
    // An orphan directory named like a task slug would give React Flow two
    // nodes with one id; one of them would silently not render.
    const rows = [
      row({ slug: "auth" }),
      row({ slug: "auth", orphan: true, state: null, planId: null, phase: null }),
      row({ slug: "auth", orphan: true, state: null, planId: null, phase: null, worktreePath: "/x/auth" }),
      row({ slug: "auth~orphan" }),
    ];
    const out = uniqueSlugs(rows);
    expect(new Set(out.map((r) => r.slug)).size).toBe(out.length);
    // The task keeps its own slug; only an orphan is renamed.
    expect(out[0]!.slug).toBe("auth");
    expect(out[3]!.slug).toBe("auth~orphan");
    expect(out[1]!.slug).toMatch(/^auth~orphan-\d+$/);
  });

  it("hands back the same array when nothing collides", () => {
    const rows = [row({ slug: "a" }), row({ slug: "b", orphan: true })];
    expect(uniqueSlugs(rows)).toBe(rows);
  });
});
