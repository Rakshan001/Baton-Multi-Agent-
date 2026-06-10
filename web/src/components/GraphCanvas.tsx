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

const nodeId = (v: string | GraphNode | undefined): string => (typeof v === "string" ? v : v?.id ?? "");

export function GraphCanvas({ data, communityColor, selectedId, highlightIds, onNodeClick }: GraphCanvasProps) {
  const elRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<FGInstance | null>(null);
  const degreeRef = useRef(new Map<string, number>());
  // Render-state lives in refs so paint callbacks see fresh values without re-init.
  const stateRef = useRef({ selectedId, highlightIds, communityColor });
  stateRef.current = { selectedId, highlightIds, communityColor };

  // init once
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const textPrimary = cssVar("--text-primary", "#e8e8ea");
    const linkColor = cssVar("--border-default", "#3a3a40");
    const degree = degreeRef.current;
    const radius = (id: string) => Math.min(3 + Math.sqrt(degree.get(id) ?? 1) * 1.4, 11);

    const fg = new ForceGraph<FGNode, GraphLink>(el)
      .backgroundColor("rgba(0,0,0,0)")
      .nodeId("id")
      .nodeLabel((n) =>
        `<div style="font: 12px ui-sans-serif; max-width: 280px"><b>${n.label}</b>${n.source_file ? `<br/><span style="opacity:.7">${n.source_file}${n.source_location ? ":" + n.source_location : ""}</span>` : ""}</div>`)
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

        ctx.globalAlpha = dimmed ? 0.14 : 1;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
        ctx.fillStyle = color(node.community);
        ctx.fill();
        if (isSel) {
          ctx.lineWidth = 2 / globalScale;
          ctx.strokeStyle = textPrimary;
          ctx.stroke();
        }
        // labels only when zoomed in enough to read them
        if ((globalScale > 1.6 && !dimmed) || isSel) {
          ctx.font = `${Math.max(10 / globalScale, 2.5)}px ui-sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillStyle = textPrimary;
          ctx.fillText(node.label, node.x, node.y + r + 2 / globalScale);
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
