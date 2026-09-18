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
      node objects and allocates a position only for a genuinely new
      slug — and `fitView` is called exactly ONCE, guarded by a ref, so
      no refresh can move the viewport.
   2. A layout that is not deterministic. `layoutWorktrees` is pure and
      sorted throughout: no simulation, no clock, no dependence on the
      order the daemon happened to serve (it sorts by RISK, which moves
      whenever a worktree gets dirty).
   3. Colours frozen at first paint. Cards style themselves with
      `var(--…)` tokens; the one place a literal is needed — the
      minimap's SVG fill — goes through `useFlowTheme`, which re-reads
      on every theme change instead of once (flow/useFlowTheme.ts).
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background, BackgroundVariant, Controls, MiniMap, ReactFlow,
  applyNodeChanges, type Edge, type NodeChange, type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Icon } from "../components/Icon";
import { EmptyState, ErrorState } from "../components/primitives";
import { WorktreeNode } from "../components/flow/WorktreeNode";
import { HEALTH_META, healthColor, quietLabel } from "../components/flow/health";
import { resolveToken, useFlowTheme } from "../components/flow/useFlowTheme";
import {
  layoutWorktrees, mergeFlowNodes, worktreeEdges, type WorktreeFlowNode,
} from "../components/flow/layout";
import { usePoll } from "../hooks/usePoll";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { BatonAPI, ApiError, failureReason } from "../lib/api";
import { ScreenHeader } from "./shared";
import type { WorktreeRow } from "../types";

/** Defined once, at module scope: React Flow re-creates its internal node
 *  renderers whenever this object's identity changes, which on a polling
 *  screen would mean remounting every card several times a minute. */
const NODE_TYPES = { worktree: WorktreeNode };

/** Health values that want a person now — the header count and the list sort. */
const isUrgent = (r: WorktreeRow) => HEALTH_META[r.health]?.urgent ?? true;

export function WorktreesScreen({ live = false }: { live?: boolean }) {
  // 5 s is the safety net, not the mechanism: any lifecycle event on the bus
  // refetches this immediately (useEvents → BatonAPI.notify → usePoll). When
  // the stream is live the net can be slack.
  const poll = usePoll<WorktreeRow[]>(() => BatonAPI.getWorktrees(), { interval: live ? 20000 : 5000 });
  const rows = poll.data;
  const isNarrow = useMediaQuery("(max-width: 760px)");
  const { tokens, mode } = useFlowTheme();

  /* ---- the graph ---------------------------------------------------- */

  // The authoritative node map. State holds the array React Flow renders; this
  // ref holds identity, so a poll can merge into it without a render ordering
  // race (two polls can land between renders; the ref is always current).
  const nodesRef = useRef(new Map<string, WorktreeFlowNode>());
  const [nodes, setNodes] = useState<WorktreeFlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const rfRef = useRef<ReactFlowInstance<WorktreeFlowNode, Edge> | null>(null);
  const didFit = useRef(false);

  useEffect(() => {
    if (!rows) return;
    const positions = layoutWorktrees(rows);
    nodesRef.current = mergeFlowNodes(nodesRef.current, rows, positions);
    setNodes([...nodesRef.current.values()]);
    setEdges(worktreeEdges(rows).map((e) => ({
      ...e,
      type: "smoothstep",
      // A CSS variable, not a resolved literal: the browser re-resolves it on a
      // theme switch and no JS has to notice.
      style: { stroke: "var(--border-default)", strokeWidth: 1.4 },
    })));
  }, [rows]);

  // Exactly once, on first load. `didFit` is a ref rather than state because a
  // re-render must not be able to re-arm it — every later refresh has to leave
  // the viewport exactly where the person put it.
  useEffect(() => {
    if (didFit.current || nodes.length === 0 || !rfRef.current) return;
    didFit.current = true;
    const inst = rfRef.current;
    // One frame later: React Flow measures nodes after they paint, and fitting
    // against unmeasured nodes lands on the wrong zoom.
    const id = requestAnimationFrame(() => inst.fitView({ padding: 0.2, duration: 0 }));
    return () => cancelAnimationFrame(id);
  }, [nodes.length]);

  // React Flow's own changes — drag, selection, measurement — are written back
  // into the ref so the next poll's merge preserves them.
  const onNodesChange = useCallback((changes: NodeChange<WorktreeFlowNode>[]) => {
    setNodes((cur) => {
      const next = applyNodeChanges(changes, cur);
      nodesRef.current = new Map(next.map((n) => [n.id, n]));
      return next;
    });
  }, []);

  /** Put every node back on its deterministic position. Explicit, because the
   *  merge deliberately never does this on its own. */
  const relayout = useCallback(() => {
    if (!rows) return;
    const positions = layoutWorktrees(rows);
    const next = new Map<string, WorktreeFlowNode>();
    for (const [slug, n] of nodesRef.current) {
      next.set(slug, { ...n, position: positions.get(slug) ?? n.position });
    }
    nodesRef.current = next;
    setNodes([...next.values()]);
    requestAnimationFrame(() => rfRef.current?.fitView({ padding: 0.2, duration: 200 }));
  }, [rows]);

  const minimapColor = useCallback(
    (n: WorktreeFlowNode) => resolveToken(tokens, healthColor(n.data.row.health)),
    [tokens],
  );

  /* ---- header ------------------------------------------------------- */

  const selectedCount = nodes.filter((n) => n.selected).length;
  const urgent = useMemo(() => (rows ?? []).filter(isUrgent).length, [rows]);
  const atRisk = useMemo(() => (rows ?? []).filter((r) => r.unprotected.atRisk).length, [rows]);

  const subtitle = !rows ? undefined
    : rows.length === 0 ? "No worktrees on disk."
      : `${rows.length} worktree${rows.length === 1 ? "" : "s"} · ${urgent} needing attention · ${atRisk} holding work that exists nowhere else`;

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
          <button className="btn fr" onClick={() => rfRef.current?.fitView({ padding: 0.2, duration: 200 })}
            data-tip="Fit every worktree in view">
            <Icon name="maximize" size={13} /> Fit
          </button>
          <button className="btn fr" onClick={relayout}
            data-tip="Put every node back where the plan DAG says it goes">
            <Icon name="grid" size={13} /> Re-layout
          </button>
        </>
      )}
    </ScreenHeader>
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
        <RankedList rows={rows} loading={poll.isLoading} />
      </div>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      {header}
      <div style={{ flex: 1, minHeight: 0, margin: "0 16px 16px", borderRadius: "var(--r-lg)", border: "1px solid var(--border-subtle)", overflow: "hidden", position: "relative" }}>
        <ReactFlow<WorktreeFlowNode, Edge>
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onInit={(inst) => { rfRef.current = inst; }}
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

        {poll.isLoading && !rows && (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "var(--bg-canvas)", color: "var(--text-tertiary)" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--fs-13)" }}>
              <Icon name="refresh" size={15} style={{ animation: "spin 0.9s linear infinite" }} /> Reading worktrees…
            </span>
          </div>
        )}
        {poll.error != null && rows != null && (
          // A failed refresh must never render as fresh data.
          <div className="mono" style={{
            position: "absolute", top: 10, right: 10, padding: "4px 8px", borderRadius: "var(--r-sm)",
            fontSize: "var(--fs-11)", color: "var(--dirty-text)", background: "var(--bg-elevated)",
            border: "1px solid var(--dirty-border)",
          }} data-tip={`The last refresh failed — ${failureReason(poll.error)}`}>may be stale</div>
        )}
      </div>
    </div>
  );
}

/** The small-screen fallback: the same rows, worst first. */
function RankedList({ rows, loading }: { rows: WorktreeRow[] | null; loading: boolean }) {
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
          <div key={r.slug} style={{
            display: "flex", flexDirection: "column", gap: 5, padding: "10px 12px",
            background: "var(--bg-surface)", border: "1px solid var(--border-default)",
            borderLeft: `3px solid ${meta.color}`, borderRadius: "var(--r-md)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="mono" style={{ flex: 1, minWidth: 0, fontSize: "var(--fs-12)", fontWeight: "var(--fw-semibold)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.slug}</span>
              <span style={{ fontSize: "var(--fs-11)", color: meta.color }} title={meta.blurb}>{meta.label}</span>
            </div>
            <div className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)" }}>
              {r.branch ?? "(no branch)"} · quiet {quietLabel(r.quietForMs)}
              {r.unprotected.atRisk ? ` · ${r.unprotected.lines} lines at risk` : ""}
            </div>
          </div>
        );
      })}
    </div>
  );
}
