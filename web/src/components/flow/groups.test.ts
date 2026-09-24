// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The four things collapse is worthless — or worse than worthless — without.
 *
 * 1. THE ROLLUP IS THE WORST CHILD. If a collapsed group could read as
 *    healthy while holding a stalled worktree, then collapsing would be a way
 *    to hide problems and the tidy-up button would undo the entire screen.
 * 2. `unknown` IS NEVER REASSURING, and never masks a verdict either. Both
 *    directions are pinned, because getting either one wrong turns an absent
 *    answer into a claim.
 * 3. AN EDGE NEVER SILENTLY VANISHES. Crossing a collapsed boundary reroutes
 *    it to the group node. A dependency that disappears when somebody tidies
 *    the canvas is a dependency they rediscover the hard way.
 * 4. COLLAPSE DOES NOT RE-SEED. React Flow tracks position and selection on
 *    the node object, so collapsing and expanding must hand back the same
 *    objects — the same promise layout.test.ts pins for a poll.
 */
import { describe, expect, it } from "vitest";
import {
  BAND_GAP, COL_GAP, NODE_H, NODE_W, layoutWorktrees, mergeFlowNodes,
  worktreeEdges, type WorktreeFlowNode,
} from "./layout";
import {
  GROUP_PAD_BOTTOM, GROUP_PAD_TOP, GROUP_PAD_X, HEALTH_SEVERITY,
  composeFlowNodes, computeGroups, groupIdFor, groupLabel, groupMembership,
  healthSeverity, hiddenSlugs, mergeGroupNodes, routeEdges, worstHealth,
  type FlowNode, type GroupFlowNode,
} from "./groups";
import { HEALTH_META } from "./health";
import type { WorktreeHealth, WorktreeRow } from "../../types";

const row = (over: Partial<WorktreeRow> & { slug: string }): WorktreeRow => ({
  kind: over.orphan ? "orphan" : "task",
  branch: `baton/${over.slug}`,
  worktreePath: `/tmp/${over.slug}`,
  state: "active",
  health: "working",
  quietForMs: 0,
  lastActivityAt: null,
  unprotected: { lines: 0, commits: 0, atRisk: false },
  filesChanged: 0, ahead: 0, behind: 0, repoState: "clean",
  agent: null, claimedBy: null, holderRunning: false,
  planId: "auth", phase: 1, dependsOn: [], orphan: false, wipRef: null,
  ...over,
});

const ALL_HEALTH = Object.keys(HEALTH_SEVERITY) as WorktreeHealth[];

/* ================================================== the worst-health rollup */

describe("a collapsed group carries its worst child's health", () => {
  it("picks the worst, not the commonest", () => {
    // Nine reassuring rows and one stalled one. An average, a mode, or "the
    // first child" would all answer `working` here.
    const healths: WorktreeHealth[] = [
      "working", "working", "working", "working", "ok",
      "ok", "ok", "working", "working", "stalled",
    ];
    expect(worstHealth(healths)).toBe("stalled");
  });

  it("does not depend on the order the daemon served the rows", () => {
    const healths: WorktreeHealth[] = ["quiet", "abandoned", "ok", "conflict", "working"];
    expect(worstHealth(healths)).toBe("abandoned");
    expect(worstHealth([...healths].reverse())).toBe("abandoned");
  });

  it("answers a single child with that child's own health", () => {
    for (const h of ALL_HEALTH) expect(worstHealth([h])).toBe(h);
  });

  it("answers `unknown` for an empty group, never `ok`", () => {
    // A group with no members should not be constructible, but if one ever is,
    // "we cannot say" is honest and "clean" would be a claim about nothing.
    expect(worstHealth([])).toBe("unknown");
  });

  it("orders every health value distinctly, so the rollup is a total order", () => {
    const severities = ALL_HEALTH.map(healthSeverity);
    expect(new Set(severities).size).toBe(ALL_HEALTH.length);
  });

  it("treats a health value this build has never heard of as unknown", () => {
    // A newer daemon adding a twelfth value must not have it default to `ok`.
    const future = "quantum-entangled" as WorktreeHealth;
    expect(healthSeverity(future)).toBe(HEALTH_SEVERITY.unknown);
    expect(worstHealth(["ok", future])).toBe(future);
  });

  it("never disagrees with HEALTH_META.urgent about which values are worse", () => {
    // The two orderings are defined in different files; if they could
    // disagree, a group would collapse to a health the card vocabulary calls
    // calm while the rollup calls it alarming, or the reverse.
    const urgent = ALL_HEALTH.filter((h) => HEALTH_META[h].urgent);
    const calm = ALL_HEALTH.filter((h) => !HEALTH_META[h].urgent);
    const worstCalm = Math.max(...calm.map(healthSeverity));
    const mildestUrgent = Math.min(...urgent.map(healthSeverity));
    expect(mildestUrgent).toBeGreaterThan(worstCalm);
  });
});

describe("`unknown` rolls up as a question, never as an answer", () => {
  it("is never reassuring: it outranks every calm value", () => {
    for (const calm of ALL_HEALTH.filter((h) => !HEALTH_META[h].urgent)) {
      expect(worstHealth(["unknown", calm])).toBe("unknown");
    }
  });

  it("does not let one unreadable worktree hide four clean ones' one stalled sibling", () => {
    // The explicit case from the task: a group of five where git failed on one.
    expect(worstHealth(["ok", "working", "unknown", "ok", "stalled"])).toBe("stalled");
  });

  it("never masks a value the daemon has positive evidence for", () => {
    for (const evidenced of ["abandoned", "missing", "conflict", "stalled", "rebasing"] as WorktreeHealth[]) {
      expect(worstHealth(["unknown", evidenced])).toBe(evidenced);
    }
  });

  it("is the mildest of the urgent values and nothing else", () => {
    const urgent = ALL_HEALTH.filter((h) => HEALTH_META[h].urgent);
    expect(urgent).toContain("unknown");
    const mildest = urgent.reduce((a, b) => (healthSeverity(a) <= healthSeverity(b) ? a : b));
    expect(mildest).toBe("unknown");
  });
});

/* ============================================================== grouping */

describe("worktrees group by plan and phase", () => {
  const rows = [
    row({ slug: "schema", phase: 1 }),
    row({ slug: "store", phase: 1 }),
    row({ slug: "api", phase: 2, dependsOn: ["schema"] }),
    row({ slug: "ui", phase: 2, dependsOn: ["schema"] }),
    row({ slug: "cold-start", planId: "perf", phase: 1 }),
    row({ slug: "flaky", planId: null, phase: null }),
  ];

  it("keys a group on the plan AND the phase, never on the plan alone", () => {
    expect(groupIdFor(row({ slug: "a", planId: "auth", phase: 1 })))
      .not.toBe(groupIdFor(row({ slug: "b", planId: "auth", phase: 2 })));
    expect(groupIdFor(row({ slug: "a", planId: "auth", phase: 1 })))
      .toBe(groupIdFor(row({ slug: "b", planId: "auth", phase: 1 })));
  });

  it("never groups a worktree with no plan", () => {
    expect(groupIdFor(row({ slug: "flaky", planId: null, phase: null }))).toBeNull();
    const membership = groupMembership(rows);
    expect(membership.has("flaky")).toBe(false);
    expect(membership.get("schema")).toBe(membership.get("store"));
  });

  it("keeps 'no phase' distinct from 'phase 0'", () => {
    // Two different facts, and the label has to be able to say which.
    expect(groupIdFor(row({ slug: "a", planId: "p", phase: null })))
      .not.toBe(groupIdFor(row({ slug: "b", planId: "p", phase: 0 })));
    expect(groupLabel("p", null)).toBe("p · no phase");
    expect(groupLabel("p", 2)).toBe("p · phase 2");
  });

  it("makes one group per plan/phase and leaves the plan-less row out of all of them", () => {
    const groups = computeGroups(rows, layoutWorktrees(rows));
    expect(groups.map((g) => g.label).sort()).toEqual([
      "auth · phase 1", "auth · phase 2", "perf · phase 1",
    ]);
    for (const g of groups) expect(g.members).not.toContain("flaky");
  });

  it("is the same set of groups however the daemon ordered the rows", () => {
    const forward = computeGroups(rows, layoutWorktrees(rows));
    const reversed = computeGroups([...rows].reverse(), layoutWorktrees([...rows].reverse()));
    expect(reversed.map((g) => [g.id, g.members, g.position])).toEqual(
      forward.map((g) => [g.id, g.members, g.position]),
    );
  });

  it("puts a child back on its absolute layout position once the container offset is added", () => {
    // The lemma computeGroups rests on: the offset between the full layout and
    // a group's local one is CONSTANT across that group's members, so the
    // container's origin is well defined from any one of them. If it were not,
    // every child but the first would be misplaced.
    const positions = layoutWorktrees(rows);
    for (const g of computeGroups(rows, positions)) {
      for (const [slug, rel] of g.childPositions) {
        expect({ x: g.position.x + rel.x, y: g.position.y + rel.y }).toEqual(positions.get(slug));
      }
    }
  });

  it("sizes a container so every child fits inside it", () => {
    // `extent: 'parent'` clamps a drag to the parent box, so a box smaller than
    // its contents would trap cards half outside and unreachable.
    for (const g of computeGroups(rows, layoutWorktrees(rows))) {
      for (const rel of g.childPositions.values()) {
        expect(rel.x).toBeGreaterThanOrEqual(GROUP_PAD_X);
        expect(rel.y).toBeGreaterThanOrEqual(GROUP_PAD_TOP);
        expect(rel.x + NODE_W + GROUP_PAD_X).toBeLessThanOrEqual(g.width);
        expect(rel.y + NODE_H + GROUP_PAD_BOTTOM).toBeLessThanOrEqual(g.height);
      }
    }
  });

  it("never overlaps two containers, whatever the plan shape", () => {
    // The padding is sized against layout.ts's COL_GAP and BAND_GAP; if either
    // constant moves, this is what says so rather than a screenshot.
    const wide = [
      ...rows,
      row({ slug: "deep", phase: 1, dependsOn: ["schema"] }),
      row({ slug: "deeper", phase: 1, dependsOn: ["deep"] }),
      row({ slug: "tests", phase: 3, dependsOn: ["api", "ui"] }),
      row({ slug: "cache", planId: "perf", phase: 2, dependsOn: ["cold-start"] }),
    ];
    const groups = computeGroups(wide, layoutWorktrees(wide));
    expect(groups.length).toBe(5);
    for (const a of groups) {
      for (const b of groups) {
        if (a.id >= b.id) continue;
        const disjoint =
          a.position.x + a.width <= b.position.x || b.position.x + b.width <= a.position.x ||
          a.position.y + a.height <= b.position.y || b.position.y + b.height <= a.position.y;
        expect(disjoint, `${a.id} overlaps ${b.id}`).toBe(true);
      }
    }
    // And the padding genuinely fits inside the gaps layout.ts leaves.
    expect(2 * GROUP_PAD_X).toBeLessThan(COL_GAP);
    expect(GROUP_PAD_TOP + GROUP_PAD_BOTTOM).toBeLessThan(BAND_GAP);
  });

  it("never overlaps a plan's no-phase and phase-0 containers", () => {
    // Two different groups (see above), so they must also be two different
    // layers — laid in one, both boxes were drawn at the same origin.
    const mixed = [
      row({ slug: "unphased", planId: "p", phase: null }),
      row({ slug: "zeroth", planId: "p", phase: 0 }),
    ];
    const [a, b] = computeGroups(mixed, layoutWorktrees(mixed));
    const disjoint =
      a!.position.x + a!.width <= b!.position.x || b!.position.x + b!.width <= a!.position.x ||
      a!.position.y + a!.height <= b!.position.y || b!.position.y + b!.height <= a!.position.y;
    expect(disjoint).toBe(true);
  });

  it("rolls up the worst health and the at-risk count per group", () => {
    const mixed = [
      row({ slug: "a", phase: 1, health: "working" }),
      row({ slug: "b", phase: 1, health: "abandoned", unprotected: { lines: 47, commits: 1, atRisk: true } }),
      row({ slug: "c", phase: 1, health: "ok" }),
    ];
    const [g] = computeGroups(mixed, layoutWorktrees(mixed));
    expect(g!.count).toBe(3);
    expect(g!.worstHealth).toBe("abandoned");
    expect(g!.atRiskCount).toBe(1);
  });
});

/* ================================================== hidden descendants */

describe("collapse hides exactly the right nodes", () => {
  const rows = [
    row({ slug: "schema", phase: 1 }),
    row({ slug: "store", phase: 1 }),
    row({ slug: "api", phase: 2, dependsOn: ["schema"] }),
    row({ slug: "flaky", planId: null, phase: null }),
  ];
  const membership = groupMembership(rows);
  const phase1 = groupIdFor(rows[0]!)!;
  const phase2 = groupIdFor(rows[2]!)!;

  it("hides nothing when nothing is collapsed", () => {
    expect(hiddenSlugs(membership, new Set())).toEqual(new Set());
  });

  it("hides every member of a collapsed group and nobody else's", () => {
    expect(hiddenSlugs(membership, new Set([phase1]))).toEqual(new Set(["schema", "store"]));
  });

  it("hides the union when several groups are collapsed", () => {
    expect(hiddenSlugs(membership, new Set([phase1, phase2])))
      .toEqual(new Set(["schema", "store", "api"]));
  });

  it("never hides a worktree with no plan, whatever is collapsed", () => {
    // The documented consequence of not grouping them: a one-off task, an
    // orphan directory or a worktree wedged mid-rebase stays individually
    // visible no matter how tidy the rest of the canvas gets.
    const everything = new Set([phase1, phase2, "grp:anything:9"]);
    expect(hiddenSlugs(membership, everything).has("flaky")).toBe(false);
  });
});

/* ==================================================== edge rerouting */

describe("edges reroute across a collapsed boundary instead of disappearing", () => {
  const rows = [
    row({ slug: "schema", phase: 1 }),
    row({ slug: "store", phase: 1 }),
    row({ slug: "api", phase: 2, dependsOn: ["schema"] }),
    row({ slug: "ui", phase: 2, dependsOn: ["schema", "store"] }),
    row({ slug: "tests", phase: 3, dependsOn: ["api", "ui"] }),
    row({ slug: "inner", phase: 1, dependsOn: ["schema"] }),
  ];
  const edges = worktreeEdges(rows);
  const membership = groupMembership(rows);
  const P1 = groupIdFor(rows[0]!)!;
  const P2 = groupIdFor(rows[2]!)!;
  const P3 = groupIdFor(rows[4]!)!;

  it("changes nothing when nothing is collapsed", () => {
    const routed = routeEdges(edges, membership, new Set());
    expect(routed.map((e) => [e.source, e.target]))
      .toEqual(edges.map((e) => [e.source, e.target]));
    expect(routed.every((e) => !e.rerouted && e.count === 1)).toBe(true);
  });

  it("re-points an edge leaving a collapsed group at the group node", () => {
    const routed = routeEdges(edges, membership, new Set([P1]));
    const toApi = routed.find((e) => e.target === "api")!;
    expect(toApi.source).toBe(P1);
    expect(toApi.rerouted).toBe(true);
  });

  it("re-points an edge entering a collapsed group at the group node", () => {
    const routed = routeEdges(edges, membership, new Set([P3]));
    expect(routed.find((e) => e.source === "api")!.target).toBe(P3);
    expect(routed.find((e) => e.source === "ui")!.target).toBe(P3);
  });

  it("points group to group when both ends are in different collapsed groups", () => {
    const routed = routeEdges(edges, membership, new Set([P1, P2]));
    const between = routed.filter((e) => e.source === P1 && e.target === P2);
    expect(between.length).toBe(1);
    expect(between[0]!.rerouted).toBe(true);
  });

  it("merges several dependencies that reroute onto the same pair into one edge with a count", () => {
    // schema->api, schema->ui and store->ui all become P1->P2: three facts, one
    // line. Ten identical lines between two cards would be noise, not ten facts.
    const routed = routeEdges(edges, membership, new Set([P1, P2]));
    const between = routed.find((e) => e.source === P1 && e.target === P2)!;
    expect(between.count).toBe(3);
    expect(between.id).toBe(`${P1}->${P2}`);
  });

  it("drops the one edge whose BOTH ends are inside a single collapsed group", () => {
    // schema->inner is internal to phase 1. Rerouted it would be P1->P1, which
    // React Flow draws as a self-loop saying "this depends on itself" — false,
    // and it would appear on exactly the phases with the best inner structure.
    expect(edges.some((e) => e.source === "schema" && e.target === "inner")).toBe(true);
    const routed = routeEdges(edges, membership, new Set([P1]));
    expect(routed.some((e) => e.source === e.target)).toBe(false);
    expect(routed.some((e) => e.target === "inner")).toBe(false);
  });

  it("loses no dependency except that one, however much is collapsed", () => {
    // The promise in one assertion: every original edge is either still
    // present, or accounted for by a merged edge's count, or internal to a
    // single collapsed group. Nothing else may go missing.
    for (const collapsed of [
      new Set<string>(), new Set([P1]), new Set([P2]), new Set([P1, P2]),
      new Set([P1, P2, P3]),
    ]) {
      const internal = edges.filter((e) =>
        membership.get(e.source) === membership.get(e.target)
        && collapsed.has(membership.get(e.source) ?? "")).length;
      const carried = routeEdges(edges, membership, collapsed)
        .reduce((n, e) => n + e.count, 0);
      expect(carried + internal).toBe(edges.length);
    }
  });

  it("leaves a plan-less worktree's edges alone", () => {
    const withStray = [
      ...rows,
      row({ slug: "stray", planId: null, phase: null, dependsOn: ["schema"] }),
    ];
    const m = groupMembership(withStray);
    const routed = routeEdges(worktreeEdges(withStray), m, new Set([P1]));
    const e = routed.find((x) => x.target === "stray")!;
    // Its own end is untouched; only the collapsed end moved.
    expect(e.source).toBe(P1);
    expect(e.target).toBe("stray");
  });
});

/* ============================================== composition + identity */

describe("collapse does not re-seed the graph", () => {
  const rows = [
    row({ slug: "schema", phase: 1 }),
    row({ slug: "store", phase: 1 }),
    row({ slug: "api", phase: 2, dependsOn: ["schema"] }),
    row({ slug: "flaky", planId: null, phase: null }),
  ];
  const P1 = groupIdFor(rows[0]!)!;

  const build = (
    collapsed: Set<string>,
    prevWt = new Map<string, WorktreeFlowNode>(),
    prevG = new Map<string, GroupFlowNode>(),
    pinned: ReadonlySet<string> = new Set(),
    input: WorktreeRow[] = rows,
  ) => {
    const positions = layoutWorktrees(input);
    const descriptors = computeGroups(input, positions);
    const wt = mergeFlowNodes(prevWt, input, positions, pinned);
    const groupNodes = mergeGroupNodes(prevG, descriptors, collapsed, pinned);
    return {
      composed: composeFlowNodes(groupNodes, wt, descriptors, collapsed, pinned, positions),
      wt, groupNodes, descriptors, positions,
    };
  };

  it("lists every parent before its children", () => {
    // React Flow resolves a child's position against its parent; a child that
    // appears first lands in the wrong place or is dropped with a warning.
    const { composed } = build(new Set());
    const index = new Map(composed.map((n, i) => [n.id, i]));
    for (const n of composed) {
      if (!n.parentId) continue;
      expect(index.get(n.parentId)!).toBeLessThan(index.get(n.id)!);
    }
  });

  it("expresses grouping with parentId and extent:'parent'", () => {
    const { composed } = build(new Set());
    const child = composed.find((n) => n.id === "schema")!;
    expect(child.parentId).toBe(P1);
    expect(child.extent).toBe("parent");
    // And the plan-less row carries neither, so nothing can clamp it.
    const stray = composed.find((n) => n.id === "flaky")!;
    expect(stray.parentId).toBeUndefined();
    expect(stray.extent).toBeUndefined();
    expect(stray.hidden).toBe(false);
  });

  it("sets hidden on a collapsed group's children and clears it again on expand", () => {
    const first = build(new Set());
    const map = new Map(first.composed.map((n) => [n.id, n]));
    const wt = new Map([...map].filter(([, n]) => n.type === "worktree") as [string, WorktreeFlowNode][]);
    const gr = new Map([...map].filter(([, n]) => n.type === "worktreeGroup") as [string, GroupFlowNode][]);

    const collapsed = build(new Set([P1]), wt, gr);
    expect(collapsed.composed.find((n) => n.id === "schema")!.hidden).toBe(true);
    expect(collapsed.composed.find((n) => n.id === "api")!.hidden).toBe(false);

    const again = build(new Set(), wt, gr);
    expect(again.composed.find((n) => n.id === "schema")!.hidden).toBe(false);
  });

  it("keeps a dragged child exactly where it was put, across a collapse and an expand", () => {
    const first = build(new Set());
    const wt = new Map([...first.wt]);
    const gr = new Map([...first.groupNodes]);
    // The composed node is the one React Flow hands back through
    // onNodesChange, so it is the one that goes into the next merge — with its
    // parentId already on it, which is what makes the position relative.
    const composedSchema = first.composed.find((n) => n.id === "schema")! as WorktreeFlowNode;
    const dragged = { ...composedSchema, position: { x: 31, y: 77 } };
    wt.set("schema", dragged);

    const pinned = new Set(["schema"]);
    const collapsed = build(new Set([P1]), wt, gr, pinned);
    expect(collapsed.composed.find((n) => n.id === "schema")!.position).toEqual({ x: 31, y: 77 });
    const wt2 = new Map(collapsed.composed
      .filter((n) => n.type === "worktree")
      .map((n) => [n.id, n as WorktreeFlowNode]));
    const gr2 = new Map(collapsed.composed
      .filter((n) => n.type === "worktreeGroup")
      .map((n) => [n.id, n as GroupFlowNode]));
    const expanded = build(new Set(), wt2, gr2, pinned);
    expect(expanded.composed.find((n) => n.id === "schema")!.position).toEqual({ x: 31, y: 77 });
  });

  it("moves an undragged container and its children when a band above grows, but not a pinned one", () => {
    // `perf` sorts after `auth`, so a taller auth band pushes perf's box down.
    // Holding the box where it was first laid would draw it over the new rows.
    const base = [...rows, row({ slug: "cold", planId: "perf", phase: 1 })];
    const grown = [...base, row({ slug: "extra-1", phase: 1 }), row({ slug: "extra-2", phase: 1 })];
    const PERF = groupIdFor(row({ slug: "cold", planId: "perf", phase: 1 }))!;
    const toMaps = (c: FlowNode[]) => ({
      wt: new Map(c.filter((n) => n.type === "worktree").map((n) => [n.id, n as WorktreeFlowNode])),
      gr: new Map(c.filter((n) => n.type === "worktreeGroup").map((n) => [n.id, n as GroupFlowNode])),
    });

    const first = build(new Set(), undefined, undefined, new Set(), base);
    const { wt, gr } = toMaps(first.composed);
    const moved = build(new Set(), wt, gr, new Set(), grown);
    const box = moved.descriptors.find((g) => g.id === PERF)!;
    expect(moved.groupNodes.get(PERF)!.position).toEqual(box.position);
    expect(box.position.y).toBeGreaterThan(first.groupNodes.get(PERF)!.position.y);
    // An unmoved child keeps its very position object: nothing repaints.
    const cold = moved.composed.find((n) => n.id === "cold")!;
    expect(cold.position).toBe(first.composed.find((n) => n.id === "cold")!.position);
    // A plan-less row below every band moves down with them.
    const flaky = moved.composed.find((n) => n.id === "flaky")!;
    expect(flaky.position).toEqual(moved.positions.get("flaky"));

    const held = build(new Set(), wt, gr, new Set([PERF]), grown);
    expect(held.groupNodes.get(PERF)!.position).toBe(first.groupNodes.get(PERF)!.position);
  });

  it("puts a pinned child that lost its plan back on the absolute layout", () => {
    // Its stored position is relative to the box it just left; read as
    // absolute it would land near the canvas origin.
    const first = build(new Set());
    const wt = new Map(first.composed
      .filter((n) => n.type === "worktree")
      .map((n) => [n.id, n as WorktreeFlowNode]));
    wt.set("store", { ...wt.get("store")!, position: { x: 5, y: 5 } });
    const next = [rows[0]!, row({ slug: "store", planId: null, phase: null }), ...rows.slice(2)];
    const after = build(new Set(), wt, first.groupNodes, new Set(["store"]), next);
    const store = after.composed.find((n) => n.id === "store")!;
    expect(store.parentId).toBeUndefined();
    expect(store.position).toEqual(after.positions.get("store"));
  });

  it("keeps a container's own position object across a collapse", () => {
    // The group card appears where the container's top-left already was, so
    // nothing on the canvas jumps and the viewport never moves.
    const first = build(new Set());
    const collapsed = build(new Set([P1]), first.wt, first.groupNodes);
    expect(collapsed.groupNodes.get(P1)!.position).toBe(first.groupNodes.get(P1)!.position);
  });

  it("swaps a container's size on collapse and restores it on expand", () => {
    const first = build(new Set());
    const expandedH = first.groupNodes.get(P1)!.height!;
    const collapsed = build(new Set([P1]), first.wt, first.groupNodes);
    expect(collapsed.groupNodes.get(P1)!.height).toBeLessThan(expandedH);
    expect(collapsed.groupNodes.get(P1)!.data.collapsed).toBe(true);
    const again = build(new Set(), first.wt, collapsed.groupNodes);
    expect(again.groupNodes.get(P1)!.height).toBe(expandedH);
    expect(again.groupNodes.get(P1)!.data.collapsed).toBe(false);
  });

  it("makes a container selectable only while collapsed", () => {
    // Expanded it is scenery: selecting it would put a whole phase in the
    // header's "N selected" count and let a box-select drag it away by
    // accident. Collapsed it stands in for its children, so it is a real node.
    const first = build(new Set());
    expect(first.groupNodes.get(P1)!.selectable).toBe(false);
    const collapsed = build(new Set([P1]), first.wt, first.groupNodes);
    expect(collapsed.groupNodes.get(P1)!.selectable).toBe(true);
  });

  it("re-parents a worktree that lost its plan instead of leaving it in a stale box", () => {
    const before = build(new Set());
    const wt = new Map(before.composed
      .filter((n) => n.type === "worktree")
      .map((n) => [n.id, n as WorktreeFlowNode]));
    // The daemon now reports `schema` with no plan at all.
    const next = [row({ slug: "schema", planId: null, phase: null }), ...rows.slice(1)];
    const positions = layoutWorktrees(next);
    const descriptors = computeGroups(next, positions);
    const composed = composeFlowNodes(
      mergeGroupNodes(before.groupNodes, descriptors, new Set()),
      mergeFlowNodes(wt, next, positions),
      descriptors,
      new Set(),
    );
    const orphaned = composed.find((n) => n.id === "schema")!;
    expect(orphaned.parentId).toBeUndefined();
    expect(orphaned.extent).toBeUndefined();
  });
});
