/* ============================================================
   BATON — Canvas / Orchestration view (ported from canvas.jsx)
   Draggable session nodes, merge-risk edges from shared conflict
   files, pan/zoom/snap/fit/minimap. Degrades to the board on
   small screens.
   ============================================================ */
import { useState, useRef, useMemo, useEffect, useCallback } from "react";
import { Icon } from "../components/Icon";
import { AgentBadge, SyncChips, ErrorState } from "../components/primitives";
import { getAgent } from "../lib/registry";
import { deriveColumn, COLUMN_DEFS } from "../lib/derive";
import { basename } from "../lib/format";
import { showToast } from "../lib/toast";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { Board } from "./Board";
import type { StatusRow } from "../types";

const CANVAS_KEY = "baton:canvas:v2";
const GRID = 24;
const NODE_W = 216;
const NODE_H = 96;

type Pos = { x: number; y: number };
type Layout = Record<string, Pos>;
interface ViewState { tx: number; ty: number; scale: number }
interface Edge { a: string; b: string; shared: string[] }

function loadLayout(): Layout { try { return JSON.parse(localStorage.getItem(CANVAS_KEY) || "") || {}; } catch { return {}; } }
function saveLayout(l: Layout) { try { localStorage.setItem(CANVAS_KEY, JSON.stringify(l)); } catch { /* ignore */ } }

function autoLayout(sessions: StatusRow[]): Layout {
  const lanes = COLUMN_DEFS.map((c) => c.id);
  const byCol: Record<string, StatusRow[]> = {};
  lanes.forEach((l) => (byCol[l] = []));
  sessions.forEach((s) => byCol[deriveColumn(s)].push(s));
  const pos: Layout = {};
  lanes.forEach((lane, li) => {
    byCol[lane].forEach((s, i) => { pos[s.slug] = { x: 60 + li * (NODE_W + 60), y: 60 + i * (NODE_H + 34) }; });
  });
  return pos;
}

export function CanvasView({
  sessions, loading, onOpen, error = null, onRetry,
}: { sessions: StatusRow[] | null; loading: boolean; onOpen: (slug: string) => void; error?: unknown; onRetry?: () => void }) {
  const isMobile = useMediaQuery("(max-width: 760px)");
  const wrapRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ViewState>({ tx: 0, ty: 0, scale: 1 });
  const [snap, setSnap] = useState(true);
  const [layout, setLayout] = useState<Layout>(loadLayout);
  const [dragNode, setDragNode] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const panRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const dragInfo = useRef<{ slug: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);

  const positions = useMemo(() => {
    const auto = autoLayout(sessions || []);
    const merged: Layout = {};
    (sessions || []).forEach((s) => { merged[s.slug] = layout[s.slug] || auto[s.slug] || { x: 60, y: 60 }; });
    return merged;
  }, [sessions, layout]);

  const edges = useMemo<Edge[]>(() => {
    const list = (sessions || []).filter((s) => (s.conflictFiles || []).length);
    const out: Edge[] = [];
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const shared = list[i].conflictFiles.filter((f) => list[j].conflictFiles.includes(f));
        if (shared.length) out.push({ a: list[i].slug, b: list[j].slug, shared });
      }
    return out;
  }, [sessions]);

  const fitView = useCallback(() => {
    const wrap = wrapRef.current; if (!wrap || !(sessions || []).length) return;
    const xs = sessions!.map((s) => positions[s.slug].x);
    const ys = sessions!.map((s) => positions[s.slug].y);
    const minX = Math.min(...xs) - 30, maxX = Math.max(...xs) + NODE_W + 30;
    const minY = Math.min(...ys) - 30, maxY = Math.max(...ys) + NODE_H + 30;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    const scale = Math.min(1.1, Math.max(0.4, Math.min(w / (maxX - minX), h / (maxY - minY))));
    setView({ scale, tx: (w - (maxX - minX) * scale) / 2 - minX * scale, ty: (h - (maxY - minY) * scale) / 2 - minY * scale });
  }, [sessions, positions]);

  useEffect(() => { const t = setTimeout(fitView, 60); return () => clearTimeout(t); /* eslint-disable-next-line */ }, []);

  const onBgPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-node]")) return;
    panRef.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
    setPanning(true);
  };
  useEffect(() => {
    if (!panning) return;
    const move = (e: PointerEvent) => { const p = panRef.current!; setView((v) => ({ ...v, tx: p.tx + (e.clientX - p.x), ty: p.ty + (e.clientY - p.y) })); };
    const up = () => setPanning(false);
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up, { once: true });
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [panning]);

  const onNodePointerDown = (e: React.PointerEvent, slug: string) => {
    e.stopPropagation();
    const p = positions[slug];
    dragInfo.current = { slug, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, moved: false };
    setDragNode(slug);
  };
  useEffect(() => {
    if (!dragNode) return;
    const move = (e: PointerEvent) => {
      const d = dragInfo.current!;
      const nx = d.ox + (e.clientX - d.sx) / view.scale;
      const ny = d.oy + (e.clientY - d.sy) / view.scale;
      if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) d.moved = true;
      setLayout((l) => ({ ...l, [d.slug]: { x: nx, y: ny } }));
    };
    const up = () => {
      const d = dragInfo.current!;
      setLayout((l) => {
        let pos = l[d.slug]; if (snap && pos) pos = { x: Math.round(pos.x / GRID) * GRID, y: Math.round(pos.y / GRID) * GRID };
        const next = { ...l, [d.slug]: pos }; saveLayout(next); return next;
      });
      if (!d.moved) onOpen(d.slug);
      setDragNode(null);
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up, { once: true });
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [dragNode, view.scale, snap, onOpen]);

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) { setView((v) => ({ ...v, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY })); return; }
    const wrap = wrapRef.current!.getBoundingClientRect();
    const mx = e.clientX - wrap.left, my = e.clientY - wrap.top;
    setView((v) => {
      const ns = Math.min(1.8, Math.max(0.35, v.scale * (1 - e.deltaY * 0.0015)));
      const k = ns / v.scale;
      return { scale: ns, tx: mx - (mx - v.tx) * k, ty: my - (my - v.ty) * k };
    });
  };
  const zoomBy = (f: number) => setView((v) => {
    const wrap = wrapRef.current!; const w = wrap.clientWidth / 2, h = wrap.clientHeight / 2;
    const ns = Math.min(1.8, Math.max(0.35, v.scale * f)); const k = ns / v.scale;
    return { scale: ns, tx: w - (w - v.tx) * k, ty: h - (h - v.ty) * k };
  });
  const resetLayout = () => { setLayout({}); saveLayout({}); setTimeout(fitView, 30); showToast({ kind: "info", title: "Canvas layout reset" }); };

  if (isMobile) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", color: "var(--text-tertiary)", fontSize: "var(--fs-12)" }}>
          <Icon name="network" size={13} /> Canvas needs a wider screen — showing the board.
        </div>
        <div style={{ flex: 1, minHeight: 0 }}><Board sessions={sessions} loading={loading} error={error} onRetry={onRetry} onOpen={onOpen} writeEnabled={false} /></div>
      </div>
    );
  }

  return (
    <div ref={wrapRef} onPointerDown={onBgPointerDown} onWheel={onWheel} style={{
      position: "relative", height: "100%", margin: "0 16px 16px", borderRadius: "var(--r-lg)",
      border: "1px solid var(--border-subtle)", overflow: "hidden", cursor: panning ? "grabbing" : "grab",
      background: "var(--bg-canvas)", backgroundImage: `radial-gradient(var(--grid-dot) 1px, transparent 1px)`,
      backgroundSize: `${GRID * view.scale}px ${GRID * view.scale}px`, backgroundPosition: `${view.tx}px ${view.ty}px`,
    }}>
      <div style={{ position: "absolute", inset: 0, transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`, transformOrigin: "0 0", transition: dragNode || panning ? "none" : "transform var(--dur-2) var(--ease-out)" }}>
        <svg style={{ position: "absolute", overflow: "visible", left: 0, top: 0, pointerEvents: "none" }} width="1" height="1">
          {edges.map((e, i) => {
            const A = positions[e.a], B = positions[e.b]; if (!A || !B) return null;
            const ax = A.x + NODE_W / 2, ay = A.y + NODE_H / 2, bx = B.x + NODE_W / 2, by = B.y + NODE_H / 2;
            const mx = (ax + bx) / 2, my = (ay + by) / 2;
            return (
              <g key={i}>
                <line x1={ax} y1={ay} x2={bx} y2={by} stroke="var(--conflict)" strokeWidth={1.8} strokeOpacity={0.55} strokeDasharray="5 5" style={{ animation: "dash-flow 0.9s linear infinite" }} />
                <g transform={`translate(${mx},${my})`}>
                  <rect x={-46} y={-12} width={92} height={24} rx={12} fill="var(--bg-overlay)" stroke="var(--conflict-border)" />
                  <text x={0} y={4} textAnchor="middle" fontSize={11} fontFamily="var(--font-mono)" fill="var(--conflict-text)">
                    {e.shared.length === 1 ? basename(e.shared[0]) : `${e.shared.length} files`}
                  </text>
                </g>
              </g>
            );
          })}
        </svg>
        {(sessions || []).map((s) => {
          const p = positions[s.slug]; const a = getAgent(s.agent); const col = COLUMN_DEFS.find((c) => c.id === deriveColumn(s))!;
          const accent = s.agent ? a.color : "var(--idle)";
          return (
            <div key={s.slug} data-node tabIndex={0} role="button" aria-label={`${s.task}. ${col.label}. Open detail.`}
              onPointerDown={(e) => onNodePointerDown(e, s.slug)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(s.slug); } }}
              className="fr"
              style={{ position: "absolute", left: p.x, top: p.y, width: NODE_W, minHeight: NODE_H, cursor: dragNode === s.slug ? "grabbing" : "grab", background: "var(--bg-surface)", border: "1px solid", borderColor: s.status === "conflict" ? "var(--conflict-border)" : "var(--border-default)", borderRadius: "var(--r-lg)", boxShadow: dragNode === s.slug ? "var(--shadow-drag)" : "var(--shadow-sm)", padding: "10px 11px", display: "flex", flexDirection: "column", gap: 8, touchAction: "none", borderLeft: `3px solid ${accent}`, transition: dragNode === s.slug ? "none" : "box-shadow var(--dur-1)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <AgentBadge id={s.agent} size="sm" showLabel={false} />
                <span style={{ flex: 1, fontSize: "var(--fs-12)", fontWeight: "var(--fw-semibold)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.short}</span>
                <span style={{ width: 7, height: 7, borderRadius: 99, background: col.color, flex: "none" }} data-tip={col.label} />
              </div>
              <div style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)", lineHeight: 1.35, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{s.task}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{s.slug}</span>
                <SyncChips ahead={s.ahead} behind={s.behind} size="sm" />
              </div>
            </div>
          );
        })}
      </div>

      {/* toolbar */}
      <div style={{ position: "absolute", top: 12, left: 12, display: "flex", gap: 6, alignItems: "center" }}>
        <div style={{ display: "flex", background: "var(--bg-elevated)", border: "1px solid var(--border-default)", borderRadius: "var(--r-md)", boxShadow: "var(--shadow-md)", overflow: "hidden" }}>
          <button className="btn btn-ghost btn-icon fr" onClick={() => zoomBy(1.2)} data-tip="Zoom in" data-tip-side="bottom" style={{ borderRadius: 0 }}><Icon name="plus" size={15} /></button>
          <span className="vdivider" />
          <button className="btn btn-ghost btn-icon fr" onClick={() => zoomBy(0.83)} data-tip="Zoom out" data-tip-side="bottom" style={{ borderRadius: 0 }}><Icon name="minus" size={15} /></button>
          <span className="vdivider" />
          <button className="btn btn-ghost fr" onClick={fitView} data-tip="Fit view" data-tip-side="bottom" style={{ borderRadius: 0, gap: 6 }}><Icon name="maximize" size={14} /> Fit</button>
        </div>
        <span style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)", background: "var(--bg-elevated)", border: "1px solid var(--border-default)", borderRadius: "var(--r-sm)", padding: "5px 9px", boxShadow: "var(--shadow-md)" }} className="mono">{Math.round(view.scale * 100)}%</span>
        <button className="btn btn-sm fr" onClick={() => setSnap((s) => !s)} aria-pressed={snap} data-tip="Snap to grid" data-tip-side="bottom" style={{ boxShadow: "var(--shadow-md)", color: snap ? "var(--accent-text)" : "var(--text-secondary)", borderColor: snap ? "var(--accent-border)" : "var(--border-default)", background: snap ? "var(--accent-soft)" : "var(--bg-elevated)" }}>
          <Icon name="grid" size={13} /> Snap
        </button>
        <button className="btn btn-sm fr" onClick={resetLayout} data-tip="Reset layout" data-tip-side="bottom" style={{ boxShadow: "var(--shadow-md)", background: "var(--bg-elevated)" }}><Icon name="refresh" size={13} /></button>
      </div>

      {/* legend */}
      <div style={{ position: "absolute", top: 12, right: 12, background: "var(--bg-elevated)", border: "1px solid var(--border-default)", borderRadius: "var(--r-md)", padding: "8px 11px", boxShadow: "var(--shadow-md)", fontSize: "var(--fs-12)", color: "var(--text-secondary)", maxWidth: 200 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <svg width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" stroke="var(--conflict)" strokeWidth="1.8" strokeDasharray="4 4" /></svg>
          shared file — merge risk
        </div>
        {edges.length === 0 && error == null && <div style={{ marginTop: 4, color: "var(--text-tertiary)", fontSize: "var(--fs-11)" }}>No overlapping edits right now.</div>}
        {error != null && (sessions?.length ?? 0) > 0 && <div style={{ marginTop: 4, color: "var(--dirty-text)", fontSize: "var(--fs-11)" }} data-tip="The last refresh failed — this view may be stale">may be stale</div>}
      </div>

      <Minimap sessions={sessions} positions={positions} view={view} wrapRef={wrapRef} />

      {error != null && !sessions?.length ? (
        // A fetch failure must not render as an empty-but-fine canvas.
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "var(--bg-canvas)" }}>
          <ErrorState title="Couldn't load sessions" desc={(error as Error).message} command="baton serve" onRetry={onRetry} retrying={loading} />
        </div>
      ) : loading && !sessions?.length ? (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "var(--text-tertiary)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}><Icon name="refresh" size={15} style={{ animation: "spin 0.9s linear infinite" }} /> Loading graph…</div>
        </div>
      ) : null}
    </div>
  );
}

function Minimap({ sessions, positions, view, wrapRef }: { sessions: StatusRow[] | null; positions: Layout; view: ViewState; wrapRef: React.RefObject<HTMLDivElement> }) {
  if (!sessions?.length) return null;
  const xs = sessions.map((s) => positions[s.slug].x), ys = sessions.map((s) => positions[s.slug].y);
  const minX = Math.min(...xs) - 40, maxX = Math.max(...xs) + NODE_W + 40;
  const minY = Math.min(...ys) - 40, maxY = Math.max(...ys) + NODE_H + 40;
  const W = 168, H = 112; const sc = Math.min(W / (maxX - minX), H / (maxY - minY));
  const wrap = wrapRef.current; const vw = wrap ? wrap.clientWidth : 800, vh = wrap ? wrap.clientHeight : 500;
  const vx = -view.tx / view.scale, vy = -view.ty / view.scale, vW = vw / view.scale, vH = vh / view.scale;
  return (
    <div aria-hidden="true" style={{ position: "absolute", bottom: 12, right: 12, width: W, height: H, background: "var(--bg-base)", border: "1px solid var(--border-default)", borderRadius: "var(--r-sm)", boxShadow: "var(--shadow-md)", overflow: "hidden" }}>
      <svg width={W} height={H}>
        {sessions.map((s) => { const p = positions[s.slug]; const col = COLUMN_DEFS.find((c) => c.id === deriveColumn(s))!;
          return <rect key={s.slug} x={(p.x - minX) * sc} y={(p.y - minY) * sc} width={NODE_W * sc} height={NODE_H * sc} rx={2} fill={col.color} fillOpacity={0.5} />; })}
        <rect x={(vx - minX) * sc} y={(vy - minY) * sc} width={vW * sc} height={vH * sc} fill="none" stroke="var(--accent)" strokeWidth={1.4} />
      </svg>
    </div>
  );
}
