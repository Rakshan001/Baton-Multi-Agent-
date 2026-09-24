// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — Worktrees (the flow canvas)

   One node per worktree from GET /api/worktrees (src/worktrees.ts),
   laid out left to right along the plan DAG. Replaces the old
   features/Canvas.tsx, which was 415 lines of hand-rolled pan/zoom/drag
   with no edge routing, no handles, no selection model, no keyboard
   support and no layout engine — the reasons React Flow is here at all.
   The two were never meant to coexist: two canvases with different node
   vocabularies is the drift this repo has already paid for once.

   THE THREE THINGS THAT WOULD RUIN THIS SCREEN, and where each is
   handled:

   1. Re-seeding the graph on a poll. It polls every few seconds and
      every SSE frame wakes it (hooks/useEvents.ts:115 pokes the same
      bus usePoll listens on), so rebuilding the node array from scratch
      would throw away every drag and every selection several times a
      minute. `mergeFlowNodes` (flow/layout.ts) merges into the existing
      node objects and keeps a stored position only for a node the
      person dragged (`pinned`) — and `fitView` is called once per React Flow mount, never
      on a poll, so no refresh can move the viewport.
   2. A layout that is not deterministic. `layoutWorktrees` is pure and
      sorted throughout: no simulation, no clock, no dependence on the
      order the daemon happened to serve (it sorts by RISK, which moves
      whenever a worktree gets dirty).
   3. Colours frozen at first paint. Cards style themselves with
      `var(--…)` tokens; the one place a literal is needed — the
      minimap's SVG fill — goes through `useFlowTheme`, which re-reads
      on every theme change instead of once (flow/useFlowTheme.ts).

   GROUPING AND COLLAPSE (wt-flow-groups) is all in
   flow/groups.ts + flow/GroupNode.tsx + flow/collapseStore.ts; this
   screen only wires the three together. The four things it is
   responsible for here:

     · ONE NODE ARRAY, PARENTS FIRST. React Flow resolves a child's
       position against its parent, so a parent must appear before its
       children or the child lands in the wrong place.
       `composeFlowNodes` guarantees that ordering and is the only
       thing allowed to build the array.
     · COLLAPSE IS A REBUILD, NOT A RE-SEED. Toggling a group runs the
       exact same merge path a poll runs, so positions, drags and
       selections survive it — a collapse that moved the canvas would
       be worse than no collapse at all.
     · EDGES REROUTE, THEY DO NOT VANISH. `routeEdges` re-points every
       edge crossing a collapsed boundary at the group node. A
       dependency that disappeared when somebody tidied up is a
       dependency they would rediscover the hard way.
     · WORST, NEVER AVERAGE. A collapsed group carries its worst
       child's health (flow/groups.ts:HEALTH_SEVERITY) so collapsing
       can never be a way to hide a stalled worktree.
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background, BackgroundVariant, Controls, MiniMap, ReactFlow,
  applyNodeChanges, type Edge, type NodeChange, type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Icon } from "../components/Icon";
import { EmptyState, ErrorState, Sheet } from "../components/primitives";
import { WorktreeNode } from "../components/flow/WorktreeNode";
import { GroupNode } from "../components/flow/GroupNode";
import { HEALTH_META, healthColor, quietLabel } from "../components/flow/health";
import { resolveToken, useFlowTheme } from "../components/flow/useFlowTheme";
import {
  dropRemovals, layoutWorktrees, mergeFlowNodes, uniqueSlugs, worktreeEdges,
  type WorktreeFlowNode, type XY,
} from "../components/flow/layout";
import {
  composeFlowNodes, computeGroups, groupMembership, mergeGroupNodes, routeEdges,
  type FlowNode, type GroupDescriptor, type GroupFlowNode,
} from "../components/flow/groups";
import { GroupToggleContext, useCollapseStore } from "../components/flow/collapseStore";
import { WorktreePanel } from "./WorktreePanel";
import { usePoll } from "../hooks/usePoll";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { BatonAPI, ApiError, failureReason } from "../lib/api";
import { ScreenHeader } from "./shared";
import { DiffViewer } from "./Diff";
import { HandoffDialog } from "./Handoff";
import { LiveSession } from "./Live";
import type { HandoffBriefEntry, Meta, PipelineView, StatusRow, WorktreeRow } from "../types";

/** Defined once, at module scope: React Flow re-creates its internal node
 *  renderers whenever this object's identity changes, which on a polling
 *  screen would mean remounting every card several times a minute. */
const NODE_TYPES = { worktree: WorktreeNode, worktreeGroup: GroupNode };

/** The panel's heading id. One constant, because the inline `aside` and the
 *  `Sheet` are the SAME panel body and the Sheet labels itself by it. */
const PANEL_HEADING_ID = "worktree-panel-verdict";

/** Split the one node map back into the two the merge functions each own.
 *  The screen keeps ONE map — the array React Flow hands back through
 *  `onNodesChange` contains both kinds — so this is where the kinds part. */
function splitNodes(all: Map<string, FlowNode>) {
  const worktrees = new Map<string, WorktreeFlowNode>();
  const groups = new Map<string, GroupFlowNode>();
  for (const [id, node] of all) {
    if (node.type === "worktreeGroup") groups.set(id, node);
    else worktrees.set(id, node);
  }
  return { worktrees, groups };
}

/** Health values that want a person now — the header count and the list sort. */
const isUrgent = (r: WorktreeRow) => HEALTH_META[r.health]?.urgent ?? true;

export function WorktreesScreen({
  live = false,
  // Defaulted from the client rather than required as a prop, because App.tsx
  // renders this screen with `live` alone and App.tsx is not in this change's
  // scope. `usePrefs` writes `BatonAPI.writeEnabled` on every change
  // (hooks/usePrefs.ts:77) and this screen re-renders on the 5 s poll, so the
  // gate follows the toggle. An explicit prop still wins when App is wired.
  writeEnabled = BatonAPI.writeEnabled,
}: { live?: boolean; writeEnabled?: boolean }) {
  // 5 s is the safety net, not the mechanism: any lifecycle event on the bus
  // refetches this immediately (useEvents → BatonAPI.notify → usePoll). When
  // the stream is live the net can be slack.
  const poll = usePoll<WorktreeRow[]>(() => BatonAPI.getWorktrees(), { interval: live ? 20000 : 5000 });
  // Once per poll result, so every consumer below sees one set of node ids.
  // `uniqueSlugs` hands back the same array when nothing collides.
  const rows = useMemo(() => poll.data && uniqueSlugs(poll.data), [poll.data]);
  const isNarrow = useMediaQuery("(max-width: 760px)");
  const { tokens, mode } = useFlowTheme();
  // Collapse state, persisted per project through the one local-preference
  // helper `web/` already has (flow/collapseStore.ts explains why not usePrefs).
  const { collapsed, toggle, setMany } = useCollapseStore(BatonAPI.project);

  /* ---- selection: ONE state, two presentations ----------------------
   * The plan's rule. Above 900px the panel is an inline `aside` beside the
   * canvas; below it, the shared `Sheet` — which is already a focus-trapped
   * bottom sheet on a small viewport, so there is nothing to re-solve. Both
   * render the SAME <WorktreePanel>, and only one of them is mounted at a
   * time, so the panel's ledger poll never runs twice.
   *
   * 900px rather than the 760px the canvas falls back at: between the two the
   * canvas still works but an inline panel would leave it narrower than one
   * node, so the sheet covers that band too.
   */
  const isWide = useMediaQuery("(min-width: 900px)");
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRow = useMemo(
    () => (rows ?? []).find((r) => r.slug === selected) ?? null,
    [rows, selected],
  );
  // A worktree that has left the read-model must not leave a panel describing
  // it behind: the row is the only thing the panel knows, and a stale one is
  // exactly the "work that is gone but still on screen" this screen exists to
  // prevent.
  useEffect(() => {
    if (selected && rows && !rows.some((r) => r.slug === selected)) setSelected(null);
  }, [rows, selected]);

  /*
   * Section 2's `blocker` and Copy prompt's brief live in two OTHER
   * read-models, and both are fetched only while something is selected —
   * `enabled` keeps the idle canvas at one request per tick rather than three.
   *
   * `blocker` is not on a worktree row on purpose: src/worktrees.ts answers
   * "what is on disk" and "why is this refused" is the pipeline's question
   * (src/pipeline-view.ts:51 takes it verbatim from `blockers()`), so the panel
   * joins the two by slug. Neither value is ever reworded here.
   */
  const pipeline = usePoll<PipelineView>(
    () => BatonAPI.getPipeline(),
    { interval: 20000, enabled: selected !== null },
  );
  const briefs = usePoll<HandoffBriefEntry[]>(
    () => BatonAPI.getHandoffs(),
    { interval: 30000, enabled: selected !== null },
  );
  /*
   * WHERE THE MERGE TARGET COMES FROM, and why it is a fetch rather than a
   * constant.
   *
   * `baton merge` lands the branch on `currentBranch(gitRepo)`
   * (src/commands/merge.ts:104) — the branch the DAEMON is sitting on, with no
   * reference to the task's own base. GET /api/meta is the one committed route
   * that reports it (`branch`, src/server.ts:2218, the same `currentBranch`
   * call), so the panel's Merge button reads it from there and refuses when it
   * is absent. features/Board.tsx writes the word "main" into its own merge
   * dialog; on a canvas of a dozen worktrees that guess would be a dialog
   * naming a branch the merge may not use.
   *
   * 60 s and selection-gated: a branch does not change often, and one more
   * request on an idle canvas is one this screen does not need.
   */
  const meta = usePoll<Meta>(
    () => BatonAPI.getMeta(),
    { interval: 60000, enabled: selected !== null },
  );

  /* ---- the three dialogs the panel hands off to ---------------------
   * Diff, Hand off and Open Live already exist as dialogs (features/Diff.tsx,
   * Handoff.tsx, Live.tsx) and App.tsx owns them for the session board. This
   * screen mounts them itself rather than taking three more props, because
   * App.tsx is not in this change's scope — and a button wired to an
   * `onOpenDiff` nobody passed is a button that silently does nothing.
   *
   * All three read a `StatusRow` for their metadata. Fetched ONCE, on demand,
   * rather than adding a third poll to a screen that already runs two: they
   * degrade honestly without it (the diff still loads from /api/tasks/:slug/diff),
   * so there is nothing to block on.
   */
  const [overlay, setOverlay] = useState<{ kind: "diff" | "handoff" | "live"; slug: string } | null>(null);
  const [statusRows, setStatusRows] = useState<StatusRow[]>([]);
  const openOverlay = useCallback((kind: "diff" | "handoff" | "live", slug: string) => {
    setOverlay({ kind, slug });
    BatonAPI.getStatus().then(setStatusRows).catch(() => { /* the dialogs degrade without it */ });
  }, []);

  /* ---- the graph ---------------------------------------------------- */

  // The authoritative node map — worktree nodes AND group containers, because
  // the array React Flow hands back through `onNodesChange` holds both. State
  // holds the array it renders; this ref holds identity, so a poll can merge
  // into it without a render ordering race (two polls can land between
  // renders; the ref is always current).
  const nodesRef = useRef(new Map<string, FlowNode>());
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  // The descriptors behind the current picture. Kept so "Collapse all" knows
  // which ids exist and `relayout` knows where each container belongs, without
  // either of them recomputing the layout a second time.
  const [groups, setGroups] = useState<GroupDescriptor[]>([]);
  // State, not a ref, so the fit below re-runs when React Flow mounts. It
  // remounts whenever the screen drops to the ranked list and comes back.
  const [rf, setRf] = useState<ReactFlowInstance<FlowNode, Edge> | null>(null);
  // The instance the one-time fit has already run for.
  const fittedFor = useRef<ReactFlowInstance<FlowNode, Edge> | null>(null);
  // Ids the person dragged. Only these keep a stored position across a
  // rebuild; everything else follows the layout (flow/layout.ts:mergeFlowNodes).
  const pinned = useRef(new Set<string>());

  /*
   * THE ONE REBUILD PATH. A poll and a collapse toggle both come through here,
   * which is what makes collapsing free of side effects: it runs the same two
   * merges, and both of those preserve the node objects they already had.
   *
   * Order matters and is not interchangeable:
   *   1. absolute layout    — deterministic, from the plan DAG (flow/layout.ts)
   *   2. group descriptors  — boxes + parent-relative child grids over that
   *   3. merge, both kinds  — keep every existing position object
   *   4. compose            — parents first, then `parentId`/`extent`/`hidden`
   *   5. route the edges    — reroute across every collapsed boundary
   */
  useEffect(() => {
    if (!rows) return;
    const positions = layoutWorktrees(rows);
    const descriptors = computeGroups(rows, positions);
    const prev = splitNodes(nodesRef.current);
    // A pin outlives its node only as a stale id a later slug could inherit.
    const present = new Set([...rows.map((r) => r.slug), ...descriptors.map((g) => g.id)]);
    for (const id of pinned.current) if (!present.has(id)) pinned.current.delete(id);
    const worktreeNodes = mergeFlowNodes(prev.worktrees, rows, positions, pinned.current);
    const groupNodes = mergeGroupNodes(prev.groups, descriptors, collapsed, pinned.current);
    const composed = composeFlowNodes(
      groupNodes, worktreeNodes, descriptors, collapsed, pinned.current, positions,
    );

    // Written straight back into the ref, not left to wait for React Flow's
    // first change event: `composeFlowNodes` is what turns an absolute position
    // into a parent-relative one, and the next rebuild has to see that.
    nodesRef.current = new Map(composed.map((n) => [n.id, n]));
    setGroups(descriptors);
    setNodes(composed);

    const membership = groupMembership(rows);
    setEdges(routeEdges(worktreeEdges(rows), membership, collapsed).map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: "smoothstep",
      // A rerouted edge is a SUMMARY of one or more dependencies, and a summary
      // that looked identical to a precise edge would be a small lie. Dashed
      // says "this points at a folded-up group", and the label says how many
      // dependencies it stands for when it stands for more than one.
      animated: false,
      label: e.count > 1 ? String(e.count) : undefined,
      labelStyle: e.count > 1
        ? { fill: "var(--text-tertiary)", fontSize: 11 }
        : undefined,
      labelBgStyle: e.count > 1 ? { fill: "var(--bg-base)" } : undefined,
      // A CSS variable, not a resolved literal: the browser re-resolves it on a
      // theme switch and no JS has to notice.
      style: {
        stroke: "var(--border-default)",
        strokeWidth: 1.4,
        strokeDasharray: e.rerouted ? "5 4" : undefined,
      },
    })));
  }, [rows, collapsed]);

  // Once per React Flow mount, as soon as there is something to fit. Keyed on
  // the INSTANCE, not a boolean: a first load that was empty, or that landed
  // on the narrow list, never mounted a canvas to fit, and a boolean set then
  // would never re-arm. A poll changes neither, so it never moves the viewport.
  const hasNodes = nodes.length > 0;
  useEffect(() => {
    if (!rf || !hasNodes || fittedFor.current === rf) return;
    fittedFor.current = rf;
    // One frame later: React Flow measures nodes after they paint, and fitting
    // against unmeasured nodes lands on the wrong zoom.
    const id = requestAnimationFrame(() => rf.fitView({ padding: 0.2, duration: 0 }));
    return () => cancelAnimationFrame(id);
  }, [rf, hasNodes]);

  // React Flow's own changes — drag, selection, measurement — are written back
  // into the ref so the next poll's merge preserves them. Never a `remove`:
  // a card is the only sign its directory is on disk (flow/layout.ts).
  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    for (const c of changes) if (c.type === "position") pinned.current.add(c.id);
    setNodes((cur) => {
      const next = applyNodeChanges(dropRemovals(changes), cur);
      nodesRef.current = new Map(next.map((n) => [n.id, n]));
      return next;
    });
  }, []);

  /*
   * React Flow's selection, reduced to the one slug the panel describes.
   *
   * A hidden node can still carry `selected` — that is how expanding a group
   * restores what you had — but it must not OPEN a panel, or somebody would
   * get a detail pane for a card they cannot see. Multi-select resolves to no
   * panel for the same reason: "these five" is not a thing this panel can
   * describe, and showing the first of them would be a quiet lie.
   */
  const onSelectionChange = useCallback(({ nodes: picked }: { nodes: FlowNode[] }) => {
    const visible = picked.filter((n) => n.type !== "worktreeGroup" && !n.hidden);
    setSelected(visible.length === 1 ? visible[0].id : null);
  }, []);

  /** Put every node back on its deterministic position. Explicit, because the
   *  merge deliberately never does this on its own.
   *
   *  A grouped worktree goes back to its position INSIDE its container (which
   *  is parent-relative), and the container itself goes back to its absolute
   *  one. Resetting a child against the absolute layout instead would throw it
   *  a whole band's worth of pixels down the canvas. */
  const relayout = useCallback(() => {
    if (!rows) return;
    const positions = layoutWorktrees(rows);
    const relative = new Map<string, XY>();
    for (const g of groups) {
      relative.set(g.id, g.position);
      for (const [slug, p] of g.childPositions) relative.set(slug, p);
    }
    const next = new Map<string, FlowNode>();
    for (const [id, n] of nodesRef.current) {
      next.set(id, { ...n, position: relative.get(id) ?? positions.get(id) ?? n.position });
    }
    pinned.current.clear();
    nodesRef.current = next;
    setNodes([...next.values()]);
    requestAnimationFrame(() => rf?.fitView({ padding: 0.2, duration: 200 }));
  }, [rows, groups, rf]);

  /** Health is the only thing the minimap can say at that size, so a container
   *  reports its ROLLED-UP health — the worst child's. A collapsed group that
   *  showed as neutral in the minimap would be a second place collapse hid a
   *  problem. An expanded container reports nothing (its children are drawn
   *  over it anyway) so the box does not swamp the dots inside it. */
  const minimapColor = useCallback((n: FlowNode) => {
    if (n.type === "worktreeGroup") {
      return n.data.collapsed
        ? resolveToken(tokens, healthColor(n.data.group.worstHealth))
        : "transparent";
    }
    return resolveToken(tokens, healthColor(n.data.row.health));
  }, [tokens]);

  /* ---- collapse ------------------------------------------------------ */

  const groupIds = useMemo(() => groups.map((g) => g.id), [groups]);
  const collapsedCount = useMemo(
    () => groupIds.filter((id) => collapsed.has(id)).length,
    [groupIds, collapsed],
  );
  const allCollapsed = groupIds.length > 0 && collapsedCount === groupIds.length;
  // How many worktrees are currently folded away. Said out loud in the header
  // because "13 worktrees" beside a canvas showing four is how somebody comes
  // to believe work has disappeared — the exact belief this screen exists to
  // prevent.
  const foldedAway = useMemo(
    () => groups.filter((g) => collapsed.has(g.id)).reduce((n, g) => n + g.count, 0),
    [groups, collapsed],
  );

  /* ---- header ------------------------------------------------------- */

  // A hidden node can still carry `selected` — that is deliberate, it is how
  // expanding a group restores the selection you had — but it must not be
  // COUNTED, or the header would claim a selection nobody can see.
  const selectedCount = nodes.filter((n) => n.selected && !n.hidden).length;
  const urgent = useMemo(() => (rows ?? []).filter(isUrgent).length, [rows]);
  const atRisk = useMemo(() => (rows ?? []).filter((r) => r.unprotected.atRisk).length, [rows]);

  const subtitle = !rows ? undefined
    : rows.length === 0 ? "No worktrees on disk."
      : `${rows.length} worktree${rows.length === 1 ? "" : "s"} · ${urgent} needing attention · ${atRisk} holding work that exists nowhere else`
        + (foldedAway > 0 ? ` · ${foldedAway} folded into ${collapsedCount} collapsed group${collapsedCount === 1 ? "" : "s"}` : "");

  /* ---- failure paths ------------------------------------------------ */

  if (poll.error && !rows) {
    // A daemon older than this route 404s. That is a different fact from "the
    // daemon is down", and saying the wrong one sends someone to restart a
    // process that is running fine.
    const missingRoute = poll.error instanceof ApiError && poll.error.code === "NOT_FOUND";
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
        <ScreenHeader title="Worktrees" />
        <ErrorState
          title={missingRoute ? "This daemon does not serve worktrees yet" : "Couldn't load worktrees"}
          desc={missingRoute
            ? <>The dashboard asked for <span className="mono">/api/worktrees</span> and the daemon returned 404. Update Baton and restart the daemon.</>
            : <>Couldn't read the worktrees — {failureReason(poll.error)}.</>}
          onRetry={poll.refetch}
          retrying={poll.isFetching}
        />
      </div>
    );
  }

  const header = (
    <ScreenHeader title="Worktrees" subtitle={subtitle}>
      {selectedCount > 1 && (
        <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)" }}>
          {selectedCount} selected
        </span>
      )}
      {!isNarrow && (
        <>
          <button className="btn fr" onClick={() => rf?.fitView({ padding: 0.2, duration: 200 })}
            data-tip="Fit every worktree in view">
            <Icon name="maximize" size={13} /> Fit
          </button>
          <button className="btn fr" onClick={relayout}
            data-tip="Put every node back where the plan DAG says it goes">
            <Icon name="grid" size={13} /> Re-layout
          </button>
          {groupIds.length > 0 && (
            <button className="btn fr" onClick={() => setMany(groupIds, !allCollapsed)}
              data-tip={allCollapsed
                ? "Expand every plan phase"
                : "Fold every plan phase into one node each — each one keeps its count and its worst health"}>
              <Icon name={allCollapsed ? "maximize" : "minimize"} size={13} />
              {allCollapsed ? "Expand all" : "Collapse all"}
            </button>
          )}
        </>
      )}
    </ScreenHeader>
  );

  /* ---- the panel, built once and presented twice ------------------- */

  const panelBody = selectedRow ? (
    <WorktreePanel
      row={selectedRow}
      pipeline={pipeline.data}
      briefs={briefs.data}
      meta={meta.data}
      writeEnabled={writeEnabled}
      onClose={() => setSelected(null)}
      // A write changed what the read-model says, so re-read it now rather
      // than leaving the canvas up to five seconds behind its own panel.
      onRefresh={poll.refetch}
      onOpenDiff={(slug) => openOverlay("diff", slug)}
      onLive={(slug) => openOverlay("live", slug)}
      onHandoff={(slug) => openOverlay("handoff", slug)}
      headingId={PANEL_HEADING_ID}
    />
  ) : null;

  const inlinePanel = isWide && panelBody && (
    <aside aria-label={`Worktree ${selected}`} style={{
      width: 372, flex: "none", marginLeft: 12, minHeight: 0, position: "relative",
      display: "flex", flexDirection: "column", background: "var(--bg-surface)",
      border: "1px solid var(--border-subtle)", borderRadius: "var(--r-lg)", overflow: "hidden",
    }}>{panelBody}</aside>
  );

  // `Sheet` renders nothing while closed, so the body is mounted in exactly one
  // of the two presentations — never both.
  const sheetPanel = !isWide && (
    <Sheet open={panelBody !== null} onClose={() => setSelected(null)}
      labelledBy={PANEL_HEADING_ID} side="bottom">
      {panelBody}
    </Sheet>
  );

  const overlaySession = overlay ? statusRows.find((r) => r.slug === overlay.slug) : undefined;
  const dialogs = overlay && (
    <>
      {overlay.kind === "diff" && (
        <DiffViewer slug={overlay.slug} session={overlaySession} writeEnabled={writeEnabled}
          branch={rows?.find((r) => r.slug === overlay.slug)?.branch ?? undefined}
          onClose={() => setOverlay(null)}
          onHandoff={(slug) => setOverlay({ kind: "handoff", slug })} />
      )}
      {overlay.kind === "handoff" && (
        <HandoffDialog slug={overlay.slug} session={overlaySession} writeEnabled={writeEnabled}
          onClose={() => setOverlay(null)} />
      )}
      {overlay.kind === "live" && (
        <LiveSession slug={overlay.slug} session={overlaySession} sessions={statusRows}
          demo={BatonAPI.demo} onClose={() => setOverlay(null)}
          setSlug={(slug) => setOverlay({ kind: "live", slug })}
          onOpenDiff={(slug) => setOverlay({ kind: "diff", slug })} />
      )}
    </>
  );

  if (rows && rows.length === 0) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
        {header}
        <EmptyState icon="network" title="No worktrees"
          desc="Nothing has been claimed yet, so there is nothing to lose. Create a task and an agent will cut a worktree for it."
          command="baton new 'fix the login redirect'" />
      </div>
    );
  }

  // A failed refresh must never render as fresh data — on either layout.
  const staleBadge = poll.error != null && rows != null && (
    <div className="mono" style={{
      position: "absolute", top: 10, right: 10, padding: "4px 8px", borderRadius: "var(--r-sm)",
      fontSize: "var(--fs-11)", color: "var(--dirty-text)", background: "var(--bg-elevated)",
      border: "1px solid var(--dirty-border)",
    }} data-tip={`The last refresh failed — ${failureReason(poll.error)}`}>may be stale</div>
  );

  /*
   * Below 760px a flow canvas is unusable — the node is wider than the
   * viewport. The plan's own fallback for "no canvas" is a RANKED LIST over
   * the same read-model, so that is what a phone gets: same data, same
   * vocabulary, sorted worst first.
   */
  if (isNarrow) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
        {header}
        {/* The badge is absolutely placed, so it needs a positioned box. */}
        {staleBadge && <div style={{ position: "relative", minHeight: 44, flex: "none" }}>{staleBadge}</div>}
        <RankedList rows={rows} loading={poll.isLoading} selected={selected} onSelect={setSelected} />
        {sheetPanel}
        {dialogs}
      </div>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      {header}
      <div style={{ flex: 1, minHeight: 0, margin: "0 16px 16px", display: "flex" }}>
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, borderRadius: "var(--r-lg)", border: "1px solid var(--border-subtle)", overflow: "hidden", position: "relative" }}>
        {/* The group nodes reach `toggle` through context rather than through
            `node.data`, because data is rebuilt from the descriptors on every
            poll and a callback living there would be a new identity several
            times a minute — defeating the `memo` on every card. */}
        <GroupToggleContext.Provider value={toggle}>
        <ReactFlow<FlowNode, Edge>
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onSelectionChange={onSelectionChange}
          onInit={setRf}
          // No keyboard delete: a card is a view of a directory on disk, and
          // removing the card would remove only the sign that it is there.
          deleteKeyCode={null}
          // React Flow's own colour mode, kept in step with the shell's theme
          // rather than left on "light" forever.
          colorMode={mode}
          // Multi-select: shift-drag draws a selection box, ⌘/ctrl-click adds
          // one at a time. Both are React Flow defaults, named here so a later
          // change cannot remove them by accident.
          selectionKeyCode="Shift"
          multiSelectionKeyCode={["Meta", "Control"]}
          elementsSelectable
          nodesConnectable={false}
          minZoom={0.15}
          maxZoom={2}
          // NOT `fitView` — that prop fits on mount, when the first poll has
          // usually not landed, and the one-time fit above is what replaces it.
          proOptions={{ hideAttribution: false }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--grid-dot)" />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor={minimapColor} nodeStrokeWidth={2}
            style={{ background: "var(--bg-base)", border: "1px solid var(--border-default)" }} />
        </ReactFlow>
        </GroupToggleContext.Provider>

        {poll.isLoading && !rows && (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "var(--bg-canvas)", color: "var(--text-tertiary)" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--fs-13)" }}>
              <Icon name="refresh" size={15} style={{ animation: "spin 0.9s linear infinite" }} /> Reading worktrees…
            </span>
          </div>
        )}
        {staleBadge}
      </div>
      {inlinePanel}
      </div>
      {sheetPanel}
      {dialogs}
    </div>
  );
}

/** The small-screen fallback: the same rows, worst first.
 *
 *  Each row is a BUTTON, not a div, so the panel is reachable on a phone and
 *  from the keyboard — this list is the only way in when there is no canvas,
 *  and it feeds the same one selection state the canvas does. */
function RankedList({ rows, loading, selected, onSelect }: {
  rows: WorktreeRow[] | null;
  loading: boolean;
  selected: string | null;
  onSelect: (slug: string) => void;
}) {
  const sorted = useMemo(() => [...(rows ?? [])].sort(
    (a, b) => Number(isUrgent(b)) - Number(isUrgent(a))
      || Number(b.unprotected.atRisk) - Number(a.unprotected.atRisk)
      || b.unprotected.lines - a.unprotected.lines
      || a.slug.localeCompare(b.slug),
  ), [rows]);

  if (!rows && loading) {
    return <div style={{ padding: 20, color: "var(--text-tertiary)", fontSize: "var(--fs-13)" }}>Reading worktrees…</div>;
  }

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px 28px", display: "flex", flexDirection: "column", gap: 8 }}>
      {sorted.map((r) => {
        const meta = HEALTH_META[r.health] ?? HEALTH_META.unknown;
        return (
          <button key={r.slug} type="button" className="fr"
            onClick={() => onSelect(r.slug)}
            aria-pressed={selected === r.slug}
            style={{
              display: "flex", flexDirection: "column", gap: 5, padding: "10px 12px",
              width: "100%", minWidth: 0, textAlign: "left", font: "inherit",
              color: "var(--text-primary)", cursor: "pointer",
              background: selected === r.slug ? "var(--bg-active)" : "var(--bg-surface)",
              border: `1px solid ${selected === r.slug ? "var(--border-strong)" : "var(--border-default)"}`,
              borderLeft: `3px solid ${meta.color}`, borderRadius: "var(--r-md)",
            }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="mono" style={{ flex: 1, minWidth: 0, fontSize: "var(--fs-12)", fontWeight: "var(--fw-semibold)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.slug}</span>
              <span style={{ fontSize: "var(--fs-11)", color: meta.color }} title={meta.blurb}>{meta.label}</span>
            </div>
            <div className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)" }}>
              {r.branch ?? "(no branch)"} · quiet {quietLabel(r.quietForMs)}
              {r.unprotected.atRisk
                ? (r.filesChanged === null ? " · at risk (uncounted)" : ` · ${r.unprotected.lines} lines at risk`)
                : ""}
            </div>
          </button>
        );
      })}
    </div>
  );
}
