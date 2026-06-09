/* ============================================================
   BATON — SessionCard (ported from card.jsx)
   Full content card used on board + canvas peek.
   ============================================================ */
import type { HTMLAttributes } from "react";
import { Icon } from "./Icon";
import { AgentBadge, StatusPill, SyncChips, ProgressBar } from "./primitives";
import { getAgent } from "../lib/registry";
import { deriveColumn } from "../lib/derive";
import { timeAgo, basename } from "../lib/format";
import type { StatusRow } from "../types";

export function SessionCard({
  s, onOpen, dragHandleProps, isOverlay = false, isGrabbed = false, compact = false,
}: {
  s: StatusRow;
  onOpen?: (slug: string) => void;
  dragHandleProps?: HTMLAttributes<HTMLButtonElement>;
  isOverlay?: boolean;
  isGrabbed?: boolean;
  compact?: boolean;
}) {
  const agent = getAgent(s.agent);
  const accent = s.agent ? agent.color : "var(--idle)";
  const conflicts = s.conflictFiles || [];
  const col = deriveColumn(s);
  return (
    <article data-card data-slug={s.slug} aria-roledescription="Session card"
      onClick={onOpen ? () => onOpen(s.slug) : undefined}
      className="session-card fr"
      tabIndex={onOpen ? 0 : -1}
      onKeyDown={onOpen ? (e) => { if (e.key === "Enter") onOpen(s.slug); } : undefined}
      style={{
        position: "relative", background: "var(--bg-surface)", borderRadius: "var(--r-lg)",
        border: "1px solid var(--border-subtle)", padding: "12px 13px 13px",
        display: "flex", flexDirection: "column", gap: 10, cursor: onOpen ? "pointer" : "default",
        boxShadow: isOverlay ? "var(--shadow-drag)" : "var(--shadow-xs)",
        borderColor: isOverlay ? "var(--border-strong)" : col === "conflict" ? "var(--conflict-border)" : "var(--border-subtle)",
        transition: "border-color var(--dur-1), box-shadow var(--dur-2), transform var(--dur-1)",
        outline: isGrabbed ? "2px solid var(--accent)" : "none", outlineOffset: 2, overflow: "hidden",
      }}>
      {/* agent accent rail */}
      <span aria-hidden="true" style={{ position: "absolute", left: 0, top: 12, bottom: 12, width: 3, borderRadius: 99, background: s.agent ? accent : "var(--idle)", opacity: s.agent ? 0.9 : 0.4 }} />

      {/* header row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: 4 }}>
        <AgentBadge id={s.agent} size="sm" showLabel={!compact} />
        <div style={{ flex: 1 }} />
        <StatusPill status={s.status} pulse />
        {dragHandleProps && (
          <button {...dragHandleProps} className="drag-handle fr" aria-label={`Reorder or merge ${s.task}. Press space to pick up.`}
            data-tip={"Drag to reorder · drop on\nReady to merge to merge"} style={{
              display: "grid", placeItems: "center", width: 24, height: 24, marginRight: -3, borderRadius: 6,
              background: "transparent", border: "none", cursor: "grab", color: "var(--text-quaternary)", touchAction: "none",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-secondary)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-quaternary)"; e.currentTarget.style.background = "transparent"; }}>
            <Icon name="grip" size={15} />
          </button>
        )}
      </div>

      {/* title + slug */}
      <div style={{ paddingLeft: 4 }}>
        <h3 style={{ margin: 0, fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)", lineHeight: "var(--lh-snug)", letterSpacing: "var(--ls-snug)", color: "var(--text-primary)", textWrap: "pretty", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{s.task}</h3>
        <div className="mono" style={{ marginTop: 4, fontSize: "var(--fs-12)", color: "var(--text-tertiary)", display: "flex", alignItems: "center", gap: 5 }}>
          <Icon name="gitBranch" size={12} style={{ color: "var(--text-quaternary)" }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.slug}</span>
        </div>
      </div>

      {/* sync + files */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: 4, flexWrap: "wrap" }}>
        <SyncChips ahead={s.ahead} behind={s.behind} size="sm" />
        {s.filesChanged > 0 && (
          <span className="chip" style={{ height: 20, padding: "0 7px", background: "transparent" }}>
            <Icon name="fileWarning" size={11} style={{ color: s.status === "dirty" ? "var(--dirty)" : "var(--text-quaternary)" }} />
            <span className="mono">{s.filesChanged}</span>
          </span>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: "var(--fs-11)", color: "var(--text-quaternary)", display: "inline-flex", alignItems: "center", gap: 3, whiteSpace: "nowrap" }}>
          <Icon name="clock" size={11} /> {timeAgo(s.createdAt)}
        </span>
      </div>

      {/* progress (est.) when there are commits */}
      {s.ahead > 0 && (
        <div style={{ paddingLeft: 4 }}><ProgressBar ahead={s.ahead} color={s.agent ? accent : "var(--accent)"} /></div>
      )}

      {/* conflict row */}
      {conflicts.length > 0 && (
        <div style={{ marginLeft: 4, padding: "8px 9px", borderRadius: "var(--r-sm)", background: "var(--conflict-soft)", border: "1px solid var(--conflict-border)", display: "flex", flexDirection: "column", gap: 5 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--conflict-text)", fontSize: "var(--fs-12)", fontWeight: "var(--fw-semibold)" }}>
            <Icon name="alertTriangle" size={12} strokeWidth={2} /> Overlapping edits
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {conflicts.slice(0, 3).map((f) => (
              <span key={f} className="mono" data-tip={f} style={{ fontSize: "var(--fs-11)", color: "var(--conflict-text)", background: "color-mix(in srgb, var(--conflict) 12%, transparent)", padding: "1px 6px", borderRadius: 5, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{basename(f)}</span>
            ))}
            {conflicts.length > 3 && <span style={{ fontSize: "var(--fs-11)", color: "var(--conflict-text)", padding: "1px 4px" }}>+{conflicts.length - 3}</span>}
          </div>
        </div>
      )}
    </article>
  );
}
