// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — plan/phase grouping and collapse for the worktree flow

   *"easily they can collapse those worktree"* — this file.

   React Flow gives us parent/child nodes (`parentId` + `extent:
   'parent'`) and NOTHING ELSE. There is no collapse API, no
   `node.expanded`, no edge rerouting. All three of those are
   implemented here:

     1. GROUPING  — a container node per (planId, phase), with each
        member carrying `parentId` and a PARENT-RELATIVE position.
     2. COLLAPSE  — `hidden: true` on every descendant, and the group
        node shrinks to one card carrying a count and the WORST child
        health.
     3. REROUTING — every edge that crossed the collapsed boundary is
        re-pointed at the group node. An edge that vanishes silently
        turns a dependency into a surprise, so nothing is allowed to
        just disappear (see `routeEdges`).

   WHY NONE OF THIS TOUCHES layout.ts. `layoutWorktrees` is pinned by
   layout.test.ts on two properties the screen is unusable without —
   determinism, and merge-not-reseed — so it is reused verbatim rather
   than edited. The trick that makes that possible is in
   `computeGroups`: a group's local child grid is obtained by running
   the SAME `layoutWorktrees` over just that group's members, which
   yields the identical relative grid at origin (0,0). Proof is in the
   comment on `computeGroups`.

   WHAT planId === null DOES: it is NOT grouped. Those rows stay
   top-level nodes in their own band (layout.ts:37-42 already sorts
   that band last). Grouping them would build a container whose only
   shared property is the ABSENCE of a plan — a one-off bugfix, a
   worktree wedged mid-rebase and an orphan directory nobody owns have
   nothing to collapse *together*, and rolling them behind one health
   chip is exactly the "collapsing becomes a way to hide problems"
   failure this task is written to avoid. Their `phase` is null too, so
   "group by plan and phase" has no key to group them ON. They remain
   individually visible, always.
   ============================================================ */
import type { Node } from "@xyflow/react";
import type { WorktreeHealth, WorktreeRow } from "../../types";
import {
  NODE_H, NODE_W, layoutWorktrees, samePosition, type WorktreeFlowNode, type XY,
} from "./layout";

/* ------------------------------------------------- group box geometry */

/** Breathing room between the container edge and the outermost child.
 *  Sized against layout.ts's COL_GAP (92) and BAND_GAP (78) so two
 *  neighbouring groups never overlap: 92 - 2*16 = 60px clear horizontally,
 *  78 - 24 - 40 = 14px clear vertically. `groups.test.ts` pins that. */
export const GROUP_PAD_X = 16;
/** Taller than the others: the header row (label + count + health + the
 *  collapse toggle) lives in it, at the 11px legibility floor. */
export const GROUP_PAD_TOP = 40;
/** A little more than PAD_X: a worktree card is `minHeight: NODE_H`, not
 *  height — chips wrap on a busy row — so the bottom needs slack. */
export const GROUP_PAD_BOTTOM = 24;

/** A collapsed group is one card the width of a worktree card, so a band of
 *  collapsed phases lines up with the expanded ones around it. */
export const COLLAPSED_W = NODE_W;
export const COLLAPSED_H = 72;

/* ------------------------------------------- the worst-health ordering */

/**
 * A TOTAL ORDER OVER THE ELEVEN HEALTH VALUES. Higher is worse.
 *
 * This is the load-bearing decision of the whole task. A collapsed group
 * shows ONE health, and if that one were an average — or the commonest, or
 * the first child's — then collapsing a group would be a way to hide a
 * stalled worktree behind nine healthy ones, which inverts the entire point
 * of a screen built to tell a stopped agent from a working one. So it is the
 * worst child's, always (`worstHealth` below).
 *
 * Every severity is DISTINCT, which is what makes this a total order rather
 * than a ranking with ties: `worstHealth` therefore cannot depend on the
 * order the daemon served its rows, the same determinism promise layout.ts
 * makes about position.
 *
 * WHY EACH VALUE SITS WHERE IT DOES — worst first:
 *
 *   abandoned  no process, no session, work that exists nowhere else. The
 *              state the reporter is afraid of, and the widest mark on the
 *              canvas already (encoding.ts:130 gives it double/5px).
 *   missing    the directory is gone. Worse-sounding than `abandoned`, but
 *              ranked below it because a missing worktree has usually
 *              already lost what it held, whereas an abandoned one is work
 *              you can still walk over and rescue. Ordered to match
 *              encoding.ts's widths, so the canvas and the rollup agree.
 *   conflict   a person must resolve it before "is it moving" means anything.
 *   stalled    past period AND grace with nothing moving.
 *   rebasing   a rebase/merge/cherry-pick/revert is half-finished.
 *   ---------- everything above has POSITIVE evidence of harm ------------
 *   unknown    git did not answer. See the paragraph below.
 *   ---------- everything below is HEALTH_META.urgent === false ----------
 *   quiet      silent past the period but still inside grace. Deliberately
 *              not an alarm (src/worktrees.ts:38-45).
 *   dirty      uncommitted changes, nobody expected to be moving them.
 *   orphan-disk on disk, no task owns it. A housekeeping fact.
 *   working    the token advanced inside the period.
 *   ok         nothing uncommitted and nobody expected to move it.
 *
 * WHERE `unknown` SITS, AND WHY. It is the LEAST severe of the six values
 * `HEALTH_META.urgent` marks urgent, and more severe than every value it
 * does not. Both halves of that are deliberate:
 *
 *   · It must outrank every reassuring value, because "git did not answer"
 *     is the absence of evidence, not evidence of fine. A group holding one
 *     unreadable worktree and four clean ones must NOT collapse to "Clean" —
 *     that is the daemon's own doctrine (a row whose git calls fail reports
 *     `unknown` and never `working`, src/worktrees.ts) carried up one level.
 *   · It must NOT outrank the five values above it, because if it did, one
 *     worktree git could not read would mask a sibling the daemon knows is
 *     `stalled` — trading a real verdict for an absent one. Silencing a
 *     known problem is the more expensive mistake.
 *
 * `groups.test.ts` pins both halves, plus the invariant that this ordering
 * and `HEALTH_META.urgent` never disagree about which values are worse.
 */
export const HEALTH_SEVERITY: Record<WorktreeHealth, number> = {
  abandoned: 100,
  missing: 90,
  conflict: 80,
  stalled: 70,
  rebasing: 60,
  unknown: 50,
  quiet: 40,
  dirty: 30,
  "orphan-disk": 20,
  working: 10,
  ok: 0,
};

/** Severity of a value, defaulting UP rather than down. A health string this
 *  build has never heard of (a newer daemon) is treated as `unknown`, never as
 *  `ok`: an unrecognised value is exactly the case where guessing "fine" is
 *  the expensive guess. */
export function healthSeverity(health: WorktreeHealth): number {
  return HEALTH_SEVERITY[health] ?? HEALTH_SEVERITY.unknown;
}

/**
 * The worst health in a list — never an average, never the commonest.
 *
 * An EMPTY list answers `unknown`, not `ok`. A group with no members should
 * not be constructible (`computeGroups` only makes a group for rows it has),
 * but if one ever is, "we cannot say" is the honest answer and "clean" would
 * be a claim about nothing.
 */
export function worstHealth(healths: readonly WorktreeHealth[]): WorktreeHealth {
  let worst: WorktreeHealth = "unknown";
  let best = -1;
  for (const h of healths) {
    const s = healthSeverity(h);
    if (s > best) { best = s; worst = h; }
  }
  return best < 0 ? "unknown" : worst;
}

/* ----------------------------------------------------- group identity */

/**
 * The group a row belongs to, or `null` for a row that is not grouped.
 *
 * `planId === null` → null: see the header comment. A row WITH a plan but no
 * phase gets `:none` rather than being folded in with phase 0, because "the
 * plan did not say which phase" and "phase zero" are different facts and the
 * label has to be able to say which one it is.
 */
export function groupIdFor(row: WorktreeRow): string | null {
  if (row.planId === null) return null;
  return `grp:${row.planId}:${row.phase ?? "none"}`;
}

/** Header wording. Short enough to sit on one line at the 11px floor. */
export function groupLabel(planId: string, phase: number | null): string {
  return phase === null ? `${planId} · no phase` : `${planId} · phase ${phase}`;
}

/* --------------------------------------------------------- descriptors */

export interface GroupDescriptor {
  id: string;
  planId: string;
  phase: number | null;
  label: string;
  /** Member slugs, sorted — the one tiebreak that cannot move between polls. */
  members: string[];
  count: number;
  /** The WORST member's health. Never an average. */
  worstHealth: WorktreeHealth;
  /** How many members carry work that exists nowhere but this disk. */
  atRiskCount: number;
  /** Absolute position of the container node (top-level, so absolute is right). */
  position: XY;
  /** Size while EXPANDED. Collapsed uses COLLAPSED_W/H instead. */
  width: number;
  height: number;
  /** slug → position RELATIVE to the container, which is what React Flow wants
   *  from a node that carries `parentId`. */
  childPositions: Map<string, XY>;
}

/**
 * Rows + the absolute layout → one descriptor per (planId, phase).
 *
 * THE TRICK THAT KEEPS layout.ts UNTOUCHED: a group's local child grid is
 * `layoutWorktrees(members)` — the same pinned function, run over just that
 * group's rows. That is provably the full layout's grid shifted by a constant:
 *
 *   · x. In the full layout a member's column is `phaseBase + localDepth`
 *     (layout.ts:118-124) and `localDepths` is computed over exactly this
 *     member set (`inBand.filter(phase)`). Run alone, the member set is
 *     unchanged and `phaseBase` is 0, so x differs by `phaseBase * (NODE_W +
 *     COL_GAP)` for every member alike.
 *   · y. In the full layout it is `bandTop + i * (NODE_H + ROW_GAP)` where `i`
 *     is the slug-sorted index within the column. Cumulative phase bases mean
 *     no two phases of one band ever share a column (layout.ts:100-105), so
 *     the column buckets — and therefore every `i` — are identical. Run alone,
 *     `bandTop` is 0.
 *
 * So the offset is CONSTANT across a group's members, which is what makes the
 * group's origin well defined from any one of them. It also means a child's
 * relative position depends only on its own group's membership: when another
 * phase grows and pushes this group sideways, the container moves and every
 * child stays exactly where it was inside it.
 */
export function computeGroups(
  rows: WorktreeRow[],
  absolute: Map<string, XY>,
): GroupDescriptor[] {
  const buckets = new Map<string, WorktreeRow[]>();
  for (const row of rows) {
    const id = groupIdFor(row);
    if (id === null) continue;
    const list = buckets.get(id);
    if (list) list.push(row);
    else buckets.set(id, [row]);
  }

  const out: GroupDescriptor[] = [];
  // Sorted by id so the descriptor array — and therefore the node array React
  // Flow receives — is the same for the same rows however they arrived.
  for (const id of [...buckets.keys()].sort()) {
    const members = [...buckets.get(id)!].sort((a, b) => a.slug.localeCompare(b.slug));
    const local = layoutWorktrees(members);

    const head = members[0]!;
    const headAbs = absolute.get(head.slug) ?? { x: 0, y: 0 };
    const headLocal = local.get(head.slug) ?? { x: 0, y: 0 };
    const origin = { x: headAbs.x - headLocal.x, y: headAbs.y - headLocal.y };

    let maxX = 0;
    let maxY = 0;
    const childPositions = new Map<string, XY>();
    for (const m of members) {
      const p = local.get(m.slug) ?? { x: 0, y: 0 };
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
      childPositions.set(m.slug, { x: p.x + GROUP_PAD_X, y: p.y + GROUP_PAD_TOP });
    }

    out.push({
      id,
      planId: head.planId!,
      phase: head.phase,
      label: groupLabel(head.planId!, head.phase),
      members: members.map((m) => m.slug),
      count: members.length,
      worstHealth: worstHealth(members.map((m) => m.health)),
      atRiskCount: members.filter((m) => m.unprotected.atRisk).length,
      // The container sits PAD above and left of its first child, so the child
      // lands back on its absolute layout position: origin + local.
      position: { x: origin.x - GROUP_PAD_X, y: origin.y - GROUP_PAD_TOP },
      width: maxX + NODE_W + 2 * GROUP_PAD_X,
      height: maxY + NODE_H + GROUP_PAD_TOP + GROUP_PAD_BOTTOM,
      childPositions,
    });
  }
  return out;
}

/** slug → the id of the group holding it. Rows with no plan are absent. */
export function groupMembership(rows: WorktreeRow[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of rows) {
    const id = groupIdFor(row);
    if (id !== null) out.set(row.slug, id);
  }
  return out;
}

/* ------------------------------------------------------------ collapse */

/**
 * Which worktree nodes must carry `hidden: true`.
 *
 * React Flow has no notion of a collapsed parent, so this is the whole of
 * collapse as far as the CHILDREN are concerned: a hidden node is not
 * rendered, is not hit-testable, and — importantly — keeps its position and
 * its `selected` flag, so expanding puts everything back exactly as it was
 * rather than re-seeding it.
 *
 * `hidden` and not "remove from the array" for exactly that reason: dropping
 * the node would destroy the object React Flow tracks identity, position and
 * selection on, which is the third trap in this task.
 */
export function hiddenSlugs(
  membership: Map<string, string>,
  collapsed: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  for (const [slug, groupId] of membership) {
    if (collapsed.has(groupId)) out.add(slug);
  }
  return out;
}

/* ------------------------------------------------------ edge rerouting */

export interface RoutedEdge {
  id: string;
  source: string;
  target: string;
  /** How many underlying `dependsOn` edges this one stands for. > 1 only
   *  happens when a collapse merged several into one. */
  count: number;
  /** True when at least one endpoint was re-pointed at a group node. Lets the
   *  canvas draw it differently — a rerouted edge is a summary, and a summary
   *  that looked identical to a precise edge would be a small lie. */
  rerouted: boolean;
}

/**
 * Edges → edges that still have both endpoints on screen.
 *
 * THE RULE THAT MATTERS: an edge crossing a collapsed boundary is RE-POINTED
 * at the group node, never dropped. A dependency that silently vanishes when
 * somebody tidies the canvas is a dependency they will rediscover the hard
 * way, and "collapse to hide the mess" must not also mean "collapse to hide
 * the wiring".
 *
 * AN EDGE WITH BOTH ENDS INSIDE ONE COLLAPSED GROUP is the single exception,
 * and it is dropped on purpose. Rerouting it would produce `groupId ->
 * groupId`, which React Flow draws as a self-loop on the collapsed card: a
 * mark that says "this depends on itself", which is false, and which would
 * appear on exactly the phases with the healthiest internal structure. The
 * information is not lost either — both endpoints are members of the one card
 * the loop would have been drawn on, and the group's own count already says
 * how many rows are in there. Nothing that crosses OUT of the group is ever
 * affected by this rule.
 *
 * Several child edges can reroute onto the same pair; they are merged into one
 * edge carrying `count`, because ten identical lines between two cards is
 * noise, not ten facts. The first id wins so the merged edge keeps a stable
 * React key across polls, and the iteration order is the caller's sorted one
 * (`worktreeEdges` sorts, layout.ts:160).
 */
export function routeEdges(
  edges: ReadonlyArray<{ id: string; source: string; target: string }>,
  membership: Map<string, string>,
  collapsed: ReadonlySet<string>,
): RoutedEdge[] {
  /** A slug resolves to its group only when that group is collapsed. */
  const resolve = (slug: string): string => {
    const groupId = membership.get(slug);
    return groupId !== undefined && collapsed.has(groupId) ? groupId : slug;
  };

  const merged = new Map<string, RoutedEdge>();
  for (const edge of edges) {
    const source = resolve(edge.source);
    const target = resolve(edge.target);
    // Both ends inside one collapsed group — see the comment above.
    if (source === target) continue;
    // NUL separates the pair because it is the one byte that cannot occur
    // in a slug or a group id, so no pair can forge another's key. Written
    // as an ESCAPE, not a raw byte: a literal NUL makes git treat this file
    // as binary and show no diff for it at review time.
    const key = `${source}\u0000${target}`;
    const seen = merged.get(key);
    if (seen) {
      seen.count += 1;
      continue;
    }
    merged.set(key, {
      // Keyed on the RESOLVED pair, not the original id: an id that changed
      // shape as edges merged would make React Flow remount the path.
      id: `${source}->${target}`,
      source,
      target,
      count: 1,
      rerouted: source !== edge.source || target !== edge.target,
    });
  }
  return [...merged.values()];
}

/* -------------------------------------------------------- group nodes */

export interface GroupNodeData extends Record<string, unknown> {
  group: GroupDescriptor;
  collapsed: boolean;
}
export type GroupFlowNode = Node<GroupNodeData, "worktreeGroup">;
export type FlowNode = WorktreeFlowNode | GroupFlowNode;

/**
 * MERGE, never re-seed — the same contract `mergeFlowNodes` (layout.ts) holds
 * for worktree nodes, and for the same reason: collapsing a group must not
 * move anything.
 *
 * A group id that was already here keeps its own node object and everything
 * React Flow wrote onto it. Its `position` is kept if it is PINNED (dragged);
 * otherwise it follows the layout, as the same object while that is unchanged,
 * so a container cannot sit on top of a band that has grown above it. Only `data` and the box `width`/`height` are refreshed —
 * `data` so the count and the rolled-up health redraw, the size because a
 * group that gained a member must grow or `extent: 'parent'` would clip the
 * new child inside a box that no longer fits it.
 *
 * Collapsing swaps the size to the collapsed card's, which IS a change of
 * size but not of origin: the card appears where the container's top-left
 * already was, so nothing on the canvas jumps and the viewport never moves.
 */
export function mergeGroupNodes(
  prev: Map<string, GroupFlowNode>,
  groups: GroupDescriptor[],
  collapsed: ReadonlySet<string>,
  pinned: ReadonlySet<string> = new Set(),
): Map<string, GroupFlowNode> {
  const next = new Map<string, GroupFlowNode>();
  for (const group of groups) {
    const isCollapsed = collapsed.has(group.id);
    const width = isCollapsed ? COLLAPSED_W : group.width;
    const height = isCollapsed ? COLLAPSED_H : group.height;
    const existing = prev.get(group.id);
    const shared = {
      data: { group, collapsed: isCollapsed },
      width,
      height,
      style: { width, height },
      // An expanded container is scenery: selecting it would put it in the
      // header's "N selected" count and let a box-select drag whole phases
      // around by accident. Collapsed it is a real node standing in for its
      // children, so it becomes selectable then.
      selectable: isCollapsed,
      // Dragging is by the header bar only (see GroupNode.tsx), so a drag
      // started over the container's empty background pans the canvas the way
      // it would anywhere else.
      dragHandle: ".baton-group-handle",
    };
    if (existing) {
      const position = pinned.has(group.id) ? existing.position : samePosition(existing.position, group.position);
      next.set(group.id, { ...existing, ...shared, position });
    } else {
      next.set(group.id, {
        id: group.id,
        type: "worktreeGroup",
        position: group.position,
        ...shared,
      });
    }
  }
  return next;
}

/**
 * Group nodes + worktree nodes → the single array React Flow renders.
 *
 * ORDER IS NOT COSMETIC. React Flow requires a parent to appear BEFORE its
 * children in the array, or the child's relative position is resolved against
 * a parent it has not seen and the node lands at the wrong place (or is
 * dropped with a console warning). So: every container first, then every
 * worktree.
 *
 * This is also where `parentId` / `extent` / `hidden` are stamped on. They are
 * applied here rather than inside `mergeFlowNodes` so that layout.ts stays
 * exactly what its tests describe, and so the decoration is derived fresh from
 * the current collapse set every render — the one thing that MUST NOT be
 * sticky, since it is what collapse changes.
 *
 * And it is where a child's PARENT-RELATIVE position is decided: its own only
 * if it is pinned and still in the same box, else its slot in the box's grid.
 * `absolute` (the full layout) is for a row that just LEFT a box: whatever it
 * held was relative to that box and would read as absolute.
 */
export function composeFlowNodes(
  groupNodes: Map<string, GroupFlowNode>,
  worktreeNodes: Map<string, WorktreeFlowNode>,
  groups: GroupDescriptor[],
  collapsed: ReadonlySet<string>,
  pinned: ReadonlySet<string> = new Set(),
  absolute: Map<string, XY> = new Map(),
): FlowNode[] {
  const membership = new Map<string, string>();
  const childPos = new Map<string, XY>();
  for (const g of groups) {
    for (const slug of g.members) {
      membership.set(slug, g.id);
      const p = g.childPositions.get(slug);
      if (p) childPos.set(slug, p);
    }
  }
  const hidden = hiddenSlugs(membership, collapsed);

  const out: FlowNode[] = [];
  for (const g of groups) {
    const node = groupNodes.get(g.id);
    if (node) out.push(node);
  }
  for (const [slug, node] of worktreeNodes) {
    const groupId = membership.get(slug);
    if (groupId === undefined) {
      // A planId === null worktree. Top-level, never hidden, and any stale
      // parenting is stripped so a row that LOST its plan cannot keep
      // rendering inside a container it no longer belongs to.
      const position = node.parentId === undefined
        ? node.position
        : (absolute.get(slug) ?? node.position);
      out.push({ ...node, position, parentId: undefined, extent: undefined, hidden: false });
      continue;
    }
    const slot = childPos.get(slug);
    out.push({
      ...node,
      parentId: groupId,
      // Keeps a dragged child inside its own phase. A worktree dragged into a
      // neighbouring plan's box would assert a grouping the daemon never made.
      extent: "parent",
      hidden: hidden.has(slug),
      // A dragged child in the box it was dragged in keeps where it was put.
      // Anything else takes its grid slot: a node that has just acquired a
      // parent still holds an absolute position, which as a child would read
      // as relative and put it far off to the right.
      position: pinned.has(slug) && node.parentId === groupId
        ? node.position
        : (slot ? samePosition(node.position, slot) : node.position),
    });
  }
  return out;
}
