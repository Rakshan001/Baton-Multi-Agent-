/* ============================================================
   BATON — Sessions Board with accessible drag-and-drop
   Ported from board.jsx. Pointer + keyboard drag, merge-on-drop
   (write-gated, optimistic + rollback), localStorage priority.
   ============================================================ */
import { useState, useRef, useMemo, useEffect, Fragment, type ReactNode } from "react";
import { Icon } from "../components/Icon";
import { SessionCard } from "../components/SessionCard";
import { CardSkeleton, EmptyState, ErrorState, ConfirmDialog } from "../components/primitives";
import { getAgent } from "../lib/registry";
import { deriveColumn, COLUMN_DEFS, type ColumnDef } from "../lib/derive";
import { BatonAPI, branchFor } from "../lib/api";
import { showToast } from "../lib/toast";
import type { StatusRow, ColumnId } from "../types";

const PRIORITY_KEY = "baton:priority:v1";
function loadPriority(): Record<string, string[]> {
  try { return JSON.parse(localStorage.getItem(PRIORITY_KEY) || "") || {}; } catch { return {}; }
}
function savePriority(p: Record<string, string[]>) {
  try { localStorage.setItem(PRIORITY_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

function orderSessions(list: StatusRow[], savedOrder?: string[]): StatusRow[] {
  const order = savedOrder || [];
  const idx = (slug: string) => { const i = order.indexOf(slug); return i === -1 ? Infinity : i; };
  return [...list].sort((a, b) => {
    const ia = idx(a.slug), ib = idx(b.slug);
    if (ia !== ib) return ia - ib;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

interface DragState {
  slug: string; fromCol: ColumnId; session: StatusRow;
  x: number; y: number; offsetX: number; offsetY: number; w: number; h: number;
  overCol: ColumnId | null; overIndex: number; invalid: boolean;
}
interface KbdState { slug: string; col: ColumnId; index: number; target: ColumnId; session: StatusRow }
interface ConfirmState {
  slug: string; task: string; branch: string; agent: StatusRow["agent"];
  tone: "default" | "danger"; destructive: boolean; conflicts: number; behind: number; ahead: number; busy?: boolean;
}

export function Board({
  sessions, loading, error, onOpen, writeEnabled, onRetry,
}: {
  sessions: StatusRow[] | null;
  loading: boolean;
  error?: unknown;
  onOpen: (slug: string) => void;
  writeEnabled: boolean;
  onRetry?: () => void;
}) {
  const [priority, setPriority] = useState<Record<string, string[]>>(loadPriority);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [kbd, setKbd] = useState<KbdState | null>(null);
  const [merging, setMerging] = useState<Record<string, boolean>>({});
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [announce, setAnnounce] = useState("");
  const colRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const scrollerRef = useRef<HTMLDivElement>(null);

  const grouped = useMemo(() => {
    const g: Record<ColumnId, StatusRow[]> = { idle: [], active: [], dirty: [], conflict: [], ready: [] };
    (sessions || []).forEach((s) => { if (!merging[s.slug]) g[deriveColumn(s)].push(s); });
    (Object.keys(g) as ColumnId[]).forEach((k) => (g[k] = orderSessions(g[k], priority[k])));
    return g;
  }, [sessions, priority, merging]);

  const setColOrder = (col: ColumnId, slugs: string[]) => {
    setPriority((p) => { const next = { ...p, [col]: slugs }; savePriority(next); return next; });
  };

  /* ---------- merge flow ---------- */
  const requestMerge = (s: StatusRow) => {
    if (!writeEnabled) {
      showToast({ kind: "warn", title: "Read-only mode", desc: "Start `baton serve --write` to enable merges." });
      return;
    }
    const destructive = s.status === "conflict" || s.behind > 0;
    setConfirm({
      slug: s.slug, task: s.task, branch: branchFor(s.slug), agent: s.agent,
      tone: destructive ? "danger" : "default", destructive,
      conflicts: s.conflictFiles?.length || 0, behind: s.behind, ahead: s.ahead,
    });
  };
  const doMerge = async () => {
    const c = confirm; if (!c) return;
    setConfirm((x) => (x ? { ...x, busy: true } : x));
    setMerging((m) => ({ ...m, [c.slug]: true }));
    try {
      await BatonAPI.mergeTask(c.slug);
      setConfirm(null);
      showToast({ kind: "ok", title: "Merged into main", desc: c.branch, mono: true });
    } catch (err) {
      setMerging((m) => { const n = { ...m }; delete n[c.slug]; return n; });
      BatonAPI.rollback(c.slug);
      setConfirm(null);
      showToast({ kind: "error", title: "Merge failed — changes rolled back", desc: (err as Error).message });
    }
  };

  /* ---------- pointer drag ---------- */
  const startPointerDrag = (e: React.PointerEvent, s: StatusRow, col: ColumnId) => {
    if (e.button != null && e.button !== 0) return;
    const cardEl = (e.currentTarget as HTMLElement).closest("[data-card]") as HTMLElement;
    const rect = cardEl.getBoundingClientRect();
    e.preventDefault();
    setDrag({
      slug: s.slug, fromCol: col, session: s, x: e.clientX, y: e.clientY,
      offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top,
      w: rect.width, h: rect.height, overCol: col,
      overIndex: grouped[col].findIndex((c) => c.slug === s.slug), invalid: false,
    });
  };

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const x = e.clientX, y = e.clientY;
      let overCol: ColumnId | null = null;
      for (const c of COLUMN_DEFS) {
        const el = colRefs.current[c.id]; if (!el) continue;
        const r = el.getBoundingClientRect();
        if (x >= r.left - 6 && x <= r.right + 6) { overCol = c.id; break; }
      }
      if (!overCol) { setDrag((d) => (d ? { ...d, x, y } : d)); return; }
      const bodyEl = colRefs.current[overCol]!;
      const cards = Array.from(bodyEl.querySelectorAll<HTMLElement>("[data-card]")).filter((n) => n.getAttribute("data-slug") !== drag.slug);
      let overIndex = cards.length;
      for (let i = 0; i < cards.length; i++) {
        const r = cards[i].getBoundingClientRect();
        if (y < r.top + r.height / 2) { overIndex = i; break; }
      }
      const invalid = overCol !== drag.fromCol && !(overCol === "ready" && drag.fromCol !== "ready");
      setDrag((d) => (d ? { ...d, x, y, overCol, overIndex, invalid } : d));
      const sc = scrollerRef.current;
      if (sc) { const sr = sc.getBoundingClientRect(); if (x > sr.right - 60) sc.scrollLeft += 14; else if (x < sr.left + 60) sc.scrollLeft -= 14; }
    };
    const up = () => {
      const d = drag;
      if (d.overCol === d.fromCol) {
        const cur = grouped[d.fromCol].filter((c) => c.slug !== d.slug).map((c) => c.slug);
        cur.splice(d.overIndex, 0, d.slug);
        setColOrder(d.fromCol, cur);
      } else if (d.overCol === "ready" && d.fromCol !== "ready") {
        requestMerge(d.session);
      } else if (d.overCol && d.invalid) {
        showToast({ kind: "info", title: "Columns reflect git status", desc: "Reorder within a column, or drop on Ready to merge to merge." });
      }
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, grouped, writeEnabled]);

  /* ---------- keyboard drag ---------- */
  const onHandleKeyDown = (e: React.KeyboardEvent, s: StatusRow, col: ColumnId) => {
    const idxIn = (c: ColumnId) => grouped[c].findIndex((x) => x.slug === s.slug);
    const colLabel = (c: ColumnId) => COLUMN_DEFS.find((d) => d.id === c)!.label;
    if (!kbd || kbd.slug !== s.slug) {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        const index = idxIn(col);
        setKbd({ slug: s.slug, col, index, target: col, session: s });
        setAnnounce(`Picked up ${s.task}. Use arrow up and down to reorder. Arrow right to target Ready to merge. Space to drop, escape to cancel.`);
      }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); setKbd(null); setAnnounce(`Cancelled. ${s.task} returned to ${colLabel(col)}.`); return; }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      if (kbd.target !== kbd.col) { setAnnounce("Return to original column with arrow left before reordering."); return; }
      const slugs = grouped[col].map((x) => x.slug);
      const from = slugs.indexOf(s.slug);
      const to = Math.max(0, Math.min(slugs.length - 1, from + (e.key === "ArrowDown" ? 1 : -1)));
      if (to === from) { setAnnounce(`Already at ${e.key === "ArrowUp" ? "top" : "bottom"} of ${colLabel(col)}.`); return; }
      slugs.splice(from, 1); slugs.splice(to, 0, s.slug);
      setColOrder(col, slugs);
      setKbd((k) => (k ? { ...k, index: to } : k));
      setAnnounce(`${s.task}, position ${to + 1} of ${slugs.length}.`);
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      if (col !== "ready") { setKbd((k) => (k ? { ...k, target: "ready" } : k)); setAnnounce(`Target: Ready to merge. Press space to merge ${branchFor(s.slug)} into main, or arrow left to cancel.`); }
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setKbd((k) => (k ? { ...k, target: col } : k)); setAnnounce(`Target reset to ${colLabel(col)}.`);
    }
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (kbd.target === "ready" && col !== "ready") { setKbd(null); requestMerge(s); setAnnounce(`Merge requested for ${s.task}.`); }
      else { setKbd(null); setAnnounce(`Dropped ${s.task} in ${colLabel(col)}.`); }
    }
  };

  /* ---------- render ---------- */
  if (error) return <div className="card" style={{ margin: 16 }}><ErrorState onRetry={onRetry} /></div>;

  const isEmpty = !loading && sessions && sessions.length === 0;
  if (isEmpty) return (
    <div className="card" style={{ margin: 16 }}>
      <EmptyState icon="columns" title="No sessions yet"
        desc="Create an isolated worktree for an agent to start working. Each session gets its own branch."
        command='baton new "Refactor auth middleware"' />
    </div>
  );

  return (
    <div style={{ position: "relative", height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div className="sr-only" role="status" aria-live="assertive">{announce}</div>

      <div ref={scrollerRef} className="board-scroller" style={{ flex: 1, minHeight: 0, display: "flex", gap: 14, padding: "4px 16px 16px", overflowX: "auto", overflowY: "hidden", scrollSnapType: "x proximity" }}>
        {COLUMN_DEFS.map((c) => {
          const items = grouped[c.id];
          const isMergeTarget = (!!drag && drag.overCol === c.id && drag.fromCol !== c.id && c.id === "ready") ||
            (!!kbd && kbd.target === "ready" && c.id === "ready" && kbd.col !== "ready");
          const isActiveDropCol = !!drag && drag.overCol === c.id;
          return (
            <BoardColumn key={c.id} def={c} count={items.length}
              setRef={(el) => (colRefs.current[c.id] = el)}
              isMergeTarget={isMergeTarget} isActiveDropCol={isActiveDropCol}
              dragInvalid={isActiveDropCol && !!drag?.invalid} writeEnabled={writeEnabled}>
              {loading && !sessions ? (
                <>{[0, 1].map((i) => <CardSkeleton key={i} />)}</>
              ) : (
                <>
                  {items.map((s, i) => {
                    const showPlaceholderBefore = !!drag && drag.overCol === c.id && drag.overIndex === i && drag.slug !== s.slug;
                    const isDragged = !!drag && drag.slug === s.slug;
                    return (
                      <Fragment key={s.slug}>
                        {showPlaceholderBefore && <DropPlaceholder h={drag!.h} />}
                        <div style={{ display: isDragged ? "none" : "block" }}>
                          <SessionCard s={s} onOpen={onOpen}
                            isGrabbed={!!kbd && kbd.slug === s.slug}
                            dragHandleProps={{
                              onPointerDown: (e) => startPointerDrag(e as unknown as React.PointerEvent, s, c.id),
                              onKeyDown: (e) => onHandleKeyDown(e, s, c.id),
                              onClick: (e) => e.stopPropagation(),
                            }} />
                        </div>
                      </Fragment>
                    );
                  })}
                  {drag && drag.overCol === c.id && drag.overIndex >= items.filter((s) => s.slug !== drag.slug).length && <DropPlaceholder h={drag.h} />}
                  {items.length === 0 && !drag && <ColumnEmpty def={c} />}
                </>
              )}
            </BoardColumn>
          );
        })}
      </div>

      {/* drag overlay */}
      {drag && (
        <div style={{ position: "fixed", left: drag.x - drag.offsetX, top: drag.y - drag.offsetY, width: drag.w, zIndex: "var(--z-drag)" as unknown as number, pointerEvents: "none", transform: "rotate(1.4deg) scale(1.02)", opacity: drag.invalid ? 0.7 : 1, transition: "opacity var(--dur-1)" }}>
          <SessionCard s={drag.session} isOverlay />
          {drag.invalid && (
            <div style={{ position: "absolute", top: -10, right: -8, background: "var(--bg-overlay)", border: "1px solid var(--border-strong)", borderRadius: 99, padding: "3px 9px", fontSize: 11, color: "var(--text-tertiary)", boxShadow: "var(--shadow-md)" }}>not a drop target</div>
          )}
        </div>
      )}

      <ConfirmDialog open={!!confirm} busy={confirm?.busy} onClose={() => !confirm?.busy && setConfirm(null)} onConfirm={doMerge}
        tone={confirm?.tone} icon={confirm?.destructive ? "alertTriangle" : "gitMerge"}
        title={confirm?.destructive ? "Merge with conflicts?" : "Merge into main?"}
        confirmLabel={confirm?.destructive ? "Merge anyway" : "Merge branch"}
        body={confirm && (
          <span>
            Merge <span className="mono" style={{ color: "var(--text-primary)" }}>{confirm.branch}</span>
            {confirm.agent && <> ({getAgent(confirm.agent).short})</>} into <span className="mono" style={{ color: "var(--text-primary)" }}>main</span>.
            {confirm.destructive && (
              <span style={{ display: "block", marginTop: 8, color: "var(--conflict-text)" }}>
                {confirm.conflicts > 0
                  ? <>This branch has {confirm.conflicts} conflicting file{confirm.conflicts === 1 ? "" : "s"}. The merge may halt for manual resolution.</>
                  : <>This branch is {confirm.behind} commit{confirm.behind === 1 ? "" : "s"} behind main and may need rebasing.</>}
              </span>
            )}
          </span>
        )} />
    </div>
  );
}

/* ---------- BoardColumn ---------- */
function BoardColumn({
  def, count, children, setRef, isMergeTarget, isActiveDropCol, dragInvalid, writeEnabled,
}: {
  def: ColumnDef; count: number; children: ReactNode; setRef: (el: HTMLDivElement | null) => void;
  isMergeTarget: boolean; isActiveDropCol: boolean; dragInvalid: boolean; writeEnabled: boolean;
}) {
  return (
    <section aria-label={`${def.label} — ${count} session${count === 1 ? "" : "s"}`} style={{ width: 300, minWidth: 264, flex: "0 0 auto", display: "flex", flexDirection: "column", minHeight: 0, scrollSnapAlign: "start" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 6px 10px", position: "sticky", top: 0 }}>
        <span style={{ width: 8, height: 8, borderRadius: 3, background: def.color, flex: "none" }} />
        <h2 style={{ margin: 0, fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)", letterSpacing: "var(--ls-snug)", whiteSpace: "nowrap" }}>{def.label}</h2>
        <span className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)", background: "var(--bg-surface-2)", padding: "1px 7px", borderRadius: 99, border: "1px solid var(--border-subtle)" }}>{count}</span>
        <div style={{ flex: 1 }} />
        {def.id === "ready" && <span data-tip={def.hint} style={{ color: "var(--text-quaternary)", display: "grid" }}><Icon name="gitMerge" size={14} /></span>}
      </header>
      <div ref={setRef} data-col={def.id} style={{
        flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", display: "flex", flexDirection: "column", gap: 10,
        padding: 8, borderRadius: "var(--r-lg)",
        background: isMergeTarget ? "var(--ready-soft)" : isActiveDropCol && !dragInvalid ? "var(--bg-surface)" : "var(--bg-canvas)",
        border: "1px solid",
        borderColor: isMergeTarget ? "var(--ready-border)" : isActiveDropCol && dragInvalid ? "var(--border-default)" : "var(--border-subtle)",
        outline: isMergeTarget ? "2px dashed var(--ready)" : "none", outlineOffset: -4,
        transition: "background var(--dur-2), border-color var(--dur-2)",
      }}>
        {isMergeTarget && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7, padding: "10px", border: "1px dashed var(--ready-border)", borderRadius: "var(--r-sm)", color: "var(--ready-text)", fontSize: "var(--fs-13)", fontWeight: "var(--fw-medium)", background: "color-mix(in srgb, var(--ready) 8%, transparent)" }}>
            <Icon name={writeEnabled ? "gitMerge" : "alertTriangle"} size={15} />
            {writeEnabled ? "Drop to merge into main" : "Read-only — drop disabled"}
          </div>
        )}
        {children}
      </div>
    </section>
  );
}

function DropPlaceholder({ h }: { h: number }) {
  return <div aria-hidden="true" style={{ height: Math.min(h || 120, 140), borderRadius: "var(--r-lg)", border: "1.5px dashed var(--accent-border)", background: "var(--accent-soft)", animation: "fade-in var(--dur-1)" }} />;
}

function ColumnEmpty({ def }: { def: ColumnDef }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "26px 14px", color: "var(--text-quaternary)", textAlign: "center" }}>
      <span style={{ width: 30, height: 30, borderRadius: 8, display: "grid", placeItems: "center", background: "var(--bg-surface-2)", border: "1px solid var(--border-subtle)", color: def.color }}>
        <Icon name={def.id === "conflict" ? "alertTriangle" : def.id === "ready" ? "gitMerge" : def.id === "idle" ? "bot" : "dot"} size={15} />
      </span>
      <span style={{ fontSize: "var(--fs-12)" }}>No {def.label.toLowerCase()} sessions</span>
    </div>
  );
}
