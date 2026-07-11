/* ============================================================
   BATON — GraphCanvas
   Imperative wrapper around `force-graph` (canvas 2D force layout).
   Colors come from the live CSS variables so light/dark just works.
   force-graph mutates the data it's given (x/y, link source→object),
   so callers must hand over a fresh copy per dataset.
   ============================================================ */
import { useEffect, useRef } from "react";
import ForceGraph from "force-graph";
import type { GraphData, GraphNode, GraphLink } from "../types";

type FGNode = GraphNode & { x?: number; y?: number };
type FGInstance = ForceGraph<FGNode, GraphLink>;

export interface GraphCanvasProps {
  data: GraphData;
  /** Stable community → color mapping; computed by the parent. */
  communityColor: (community: number | undefined) => string;
  selectedId: string | null;
  /** Node ids to emphasize (search hits / neighbors). Null = no filter. */
  highlightIds: Set<string> | null;
  onNodeClick: (node: GraphNode | null) => void;
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// force-graph renders nodeLabel HTML via innerHTML. Node fields (label,
// source_file, source_location) come from graph.json, which can arrive from an
// imported KB pack (untrusted) — escape them so a crafted label can't inject
// script into the same-origin dashboard (which has full access to the daemon API).
const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function esc(s: string | undefined | null): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

const nodeId = (v: string | GraphNode | undefined): string => (typeof v === "string" ? v : v?.id ?? "");

export function GraphCanvas({ data, communityColor, selectedId, highlightIds, onNodeClick }: GraphCanvasProps) {
  const elRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<FGInstance | null>(null);
  const degreeRef = useRef(new Map<string, number>());
  // Render-state lives in refs so paint callbacks see fresh values without re-init.
  const stateRef = useRef({ selectedId, highlightIds, communityColor });
  stateRef.current = { selectedId, highlightIds, communityColor };

  // Hub nodes (top of the degree distribution) keep their labels at any zoom —
  // the graph stays legible without labeling every node into a collision mess.
  const hubCutoffRef = useRef(Infinity);

  // init once
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const textPrimary = cssVar("--text-primary", "#e8e8ea");
    const textSecondary = cssVar("--text-secondary", "#9ba1a6");
    const halo = cssVar("--bg-base", "#08090a");
    const surface = cssVar("--bg-elevated", "#1b1e22");
    const linkColor = cssVar("--border-subtle", "rgba(255,255,255,0.06)");
    const MONO = "'JetBrains Mono', ui-monospace, Menlo, monospace";
    const degree = degreeRef.current;
    const radius = (id: string) => Math.min(2.5 + Math.sqrt(degree.get(id) ?? 1) * 1.25, 9);

    const fg = new ForceGraph<FGNode, GraphLink>(el)
      .backgroundColor("rgba(0,0,0,0)")
      .nodeId("id")
      .nodeLabel((n) =>
        `<div style="font: 12px ui-sans-serif; max-width: 280px"><b>${esc(n.label)}</b>${n.source_file ? `<br/><span style="opacity:.7">${esc(n.source_file)}${n.source_location ? ":" + esc(n.source_location) : ""}</span>` : ""}</div>`)
      .linkColor(() => linkColor)
      .linkDirectionalArrowLength(3)
      .linkDirectionalArrowRelPos(1)
      .linkWidth((l) => {
        const sel = stateRef.current.selectedId;
        return sel && (nodeId(l.source) === sel || nodeId(l.target) === sel) ? 2 : 1;
      })
      .nodeCanvasObject((node, ctx, globalScale) => {
        const { selectedId: sel, highlightIds: hl, communityColor: color } = stateRef.current;
        if (node.x === undefined || node.y === undefined) return;
        const r = radius(node.id);
        const isSel = node.id === sel;
        const dimmed = hl !== null && !hl.has(node.id) && !isSel;
        const hue = color(node.community);

        // Ring, not balloon: neutral fill with a community-hued stroke keeps
        // dozens of hues from shouting at once.
        ctx.globalAlpha = dimmed ? 0.12 : 1;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
        ctx.fillStyle = surface;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
        ctx.fillStyle = hue;
        ctx.globalAlpha = dimmed ? 0.06 : 0.28;
        ctx.fill();
        ctx.globalAlpha = dimmed ? 0.12 : 0.95;
        ctx.lineWidth = Math.max(1.2 / globalScale, 0.6);
        ctx.strokeStyle = isSel ? textPrimary : hue;
        if (isSel) ctx.lineWidth = Math.max(2.2 / globalScale, 1.2);
        ctx.stroke();

        // Labels: hubs always, everything else once zoomed in. Mono with a
        // background halo so text survives edge crossings.
        const isHub = (degree.get(node.id) ?? 0) >= hubCutoffRef.current;
        if (isSel || (!dimmed && (isHub || globalScale > 2.2))) {
          const fs = Math.max(11 / globalScale, 3);
          ctx.font = `500 ${fs}px ${MONO}`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.globalAlpha = dimmed ? 0.12 : 1;
          ctx.lineWidth = Math.max(3 / globalScale, 1.5);
          ctx.strokeStyle = halo;
          ctx.strokeText(node.label, node.x, node.y + r + 3 / globalScale);
          ctx.fillStyle = isSel || isHub ? textPrimary : textSecondary;
          ctx.fillText(node.label, node.x, node.y + r + 3 / globalScale);
        }
        ctx.globalAlpha = 1;
      })
      .nodePointerAreaPaint((node, paintColor, ctx) => {
        if (node.x === undefined || node.y === undefined) return;
        ctx.fillStyle = paintColor;
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius(node.id) + 3, 0, 2 * Math.PI);
        ctx.fill();
      })
      .onNodeClick((n) => onNodeClick(n))
      .onBackgroundClick(() => onNodeClick(null));

    graphRef.current = fg;

    const resize = () => fg.width(el.clientWidth).height(el.clientHeight);
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    return () => {
      ro.disconnect();
      fg._destructor();
      graphRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // data swaps (project change / refetch)
  useEffect(() => {
    const fg = graphRef.current;
    if (!fg) return;
    const degree = degreeRef.current;
    degree.clear();
    for (const l of data.links) {
      degree.set(nodeId(l.source), (degree.get(nodeId(l.source)) ?? 0) + 1);
      degree.set(nodeId(l.target), (degree.get(nodeId(l.target)) ?? 0) + 1);
    }
    // Label the ~8 best-connected nodes at any zoom (the hubs orient the map);
    // everything else labels on zoom, so labels never pile into a collision mess.
    const sorted = [...degree.values()].sort((a, b) => b - a);
    hubCutoffRef.current = sorted.length ? Math.max(sorted[Math.min(7, sorted.length - 1)], 3) : Infinity;
    // Big graphs: cap simulation time so the page stays responsive.
    fg.cooldownTicks(data.nodes.length > 3000 ? 100 : Infinity);
    fg.graphData({ nodes: data.nodes as FGNode[], links: data.links });
    setTimeout(() => fg.zoomToFit(400, 40), 600);
  }, [data]);

  // repaint + recenter on selection/highlight changes (no relayout)
  useEffect(() => {
    const fg = graphRef.current;
    if (!fg) return;
    if (selectedId) {
      const node = (data.nodes as FGNode[]).find((n) => n.id === selectedId);
      if (node?.x !== undefined && node.y !== undefined) fg.centerAt(node.x, node.y, 300);
    }
    // poke the renderer so dim/highlight changes paint immediately
    fg.nodeRelSize(fg.nodeRelSize());
  }, [selectedId, highlightIds, data]);

  return <div ref={elRef} style={{ position: "absolute", inset: 0 }} />;
}
