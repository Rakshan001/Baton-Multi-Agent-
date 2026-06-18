/* ============================================================
   BATON — Command Center (home) (ported from command-center.jsx)
   At-a-glance summary + the Sessions workspace (board ⇄ canvas).
   ============================================================ */
import type { ReactNode } from "react";
import { Icon, type IconName } from "../components/Icon";
import { AgentBadge, SegmentedControl } from "../components/primitives";
import { AGENT_REGISTRY, AgentGlyph } from "../lib/registry";
import { deriveColumn } from "../lib/derive";
import { Board } from "./Board";
import { CanvasView } from "./Canvas";
import type { StatusRow } from "../types";
import type { Project } from "../lib/preview";
import type { PollState } from "../hooks/usePoll";
import type { View } from "../hooks/usePrefs";

type Tone = "conflict" | "ready" | "accent" | "clean" | "default";
type Filter = "conflict" | "ready" | null;

function MiniStat({ label, value, tone, icon, sub, onClick, active }: {
  label: string; value: ReactNode; tone?: Tone; icon: IconName; sub?: string; onClick?: () => void; active?: boolean;
}) {
  const color = ({ conflict: "var(--conflict)", ready: "var(--ready)", accent: "var(--accent)", clean: "var(--clean)" } as Record<string, string>)[tone || ""] || "var(--text-tertiary)";
  return (
    <button className="fr" onClick={onClick} aria-pressed={active} style={{
      flex: "1 1 0", minWidth: 130, textAlign: "left", cursor: onClick ? "pointer" : "default",
      background: "var(--bg-surface)", border: "1px solid", borderColor: active ? color : "var(--border-subtle)",
      borderRadius: "var(--r-lg)", padding: "13px 15px", display: "flex", flexDirection: "column", gap: 8,
      boxShadow: active ? `0 0 0 1px ${color} inset` : "none", transition: "border-color var(--dur-1), box-shadow var(--dur-1)",
    }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.borderColor = "var(--border-default)"; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.borderColor = "var(--border-subtle)"; }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, color: "var(--text-tertiary)" }}>
        <span style={{ color, display: "grid" }}><Icon name={icon} size={15} /></span>
        <span style={{ fontSize: "var(--fs-12)", fontWeight: "var(--fw-medium)" }}>{label}</span>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span className="mono" style={{ fontSize: "var(--fs-26)", fontWeight: "var(--fw-semibold)", letterSpacing: "-0.03em", color: tone === "conflict" && typeof value === "number" && value > 0 ? "var(--conflict-text)" : "var(--text-primary)", lineHeight: 1 }}>{value}</span>
        {sub && <span style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>{sub}</span>}
      </div>
    </button>
  );
}

export function CommandCenter({
  status, view, setView, onOpen, writeEnabled, filter, setFilter, project, onNewSession,
}: {
  status: PollState<StatusRow[]>;
  view: View;
  setView: (v: View) => void;
  onOpen: (slug: string) => void;
  writeEnabled: boolean;
  filter: Filter;
  setFilter: (f: Filter) => void;
  project: Project;
  onNewSession?: () => void;
}) {
  const sessions = status.data || [];
  const loading = status.isLoading;
  const active = sessions.filter((s) => s.agent !== null);
  const conflicts = sessions.filter((s) => s.status === "conflict");
  const ready = sessions.filter((s) => deriveColumn(s) === "ready");
  const dirty = sessions.filter((s) => s.status === "dirty");

  const byAgent: Record<string, number> = {};
  active.forEach((s) => { byAgent[s.agent!] = (byAgent[s.agent!] || 0) + 1; });
  const agentRows = AGENT_REGISTRY.map((a) => ({ a, n: byAgent[a.id!] || 0 })).filter((r) => r.n > 0);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      {/* project identity band */}
      <div style={{ display: "flex", alignItems: "center", gap: 13, padding: "16px 16px 0" }}>
        <span style={{ width: 38, height: 38, borderRadius: 10, background: project.color, flex: "none", display: "grid", placeItems: "center", color: "#fff", fontSize: 17, fontWeight: 800, boxShadow: `0 4px 14px color-mix(in srgb, ${project.color} 40%, transparent)` }}>{project.name[0]}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
            <h1 style={{ margin: 0, fontSize: "var(--fs-21)", fontWeight: "var(--fw-semibold)", letterSpacing: "var(--ls-tight)" }}>{project.name}</h1>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: "var(--fs-12)", color: "var(--text-secondary)", background: "var(--bg-surface-2)", border: "1px solid var(--border-subtle)", borderRadius: 99, padding: "2px 9px" }}><Icon name="gitBranch" size={12} style={{ color: "var(--text-tertiary)" }} /> <span className="mono">{project.branch}</span></span>
            <span style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>{project.framework}</span>
          </div>
          <div className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--text-quaternary)", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{project.path}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}>
            <span style={{ position: "relative", width: 7, height: 7 }}>
              <span style={{ position: "absolute", inset: 0, borderRadius: 99, background: active.length ? "var(--clean)" : "var(--idle)" }} />
              {active.length > 0 && <span style={{ position: "absolute", inset: 0, borderRadius: 99, background: "var(--clean)", animation: "ping 1.8s var(--ease-out) infinite" }} />}
            </span>
            <span className="mono" style={{ color: "var(--text-primary)", fontWeight: "var(--fw-semibold)" }}>{active.length}</span> live
          </span>
        </div>
      </div>

      {/* summary band */}
      <div style={{ padding: "14px 16px 12px", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <MiniStat label="Active sessions" value={loading ? "—" : active.length} tone="accent" icon="bot" sub={`of ${sessions.length}`} />
          <MiniStat label="In progress" value={loading ? "—" : dirty.length} tone="clean" icon="terminal" />
          <MiniStat label="Conflicts" value={loading ? "—" : conflicts.length} tone="conflict" icon="alertTriangle" onClick={() => setFilter(filter === "conflict" ? null : "conflict")} active={filter === "conflict"} />
          <MiniStat label="Ready to merge" value={loading ? "—" : ready.length} tone="ready" icon="gitMerge" onClick={() => setFilter(filter === "ready" ? null : "ready")} active={filter === "ready"} />
        </div>

        {/* attention + agents strip */}
        <div className="cc-strip" style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {conflicts.length > 0 && (
            <div style={{ flex: "2 1 360px", minWidth: 280, background: "var(--conflict-soft)", border: "1px solid var(--conflict-border)", borderRadius: "var(--r-lg)", padding: "11px 13px", display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, color: "var(--conflict-text)", fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)" }}>
                <Icon name="alertTriangle" size={14} strokeWidth={2} /> <span style={{ whiteSpace: "nowrap" }}>Needs attention</span>
                <span style={{ marginLeft: "auto", fontSize: "var(--fs-12)", fontWeight: "var(--fw-regular)", color: "var(--conflict-text)", opacity: 0.85, whiteSpace: "nowrap" }}>
                  {conflicts.length} merge-risk session{conflicts.length === 1 ? "" : "s"}
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {conflicts.slice(0, 2).map((s) => (
                  <button key={s.slug} className="fr" onClick={() => onOpen(s.slug)} style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 8px", borderRadius: "var(--r-sm)", border: "none", background: "transparent", cursor: "pointer", textAlign: "left", width: "100%" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "color-mix(in srgb, var(--conflict) 10%, transparent)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                    <AgentBadge id={s.agent} size="sm" showLabel={false} />
                    <span style={{ flex: 1, fontSize: "var(--fs-13)", color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.task}</span>
                    <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--conflict-text)" }}>{s.conflictFiles.length} file{s.conflictFiles.length === 1 ? "" : "s"}</span>
                    <Icon name="chevronRight" size={14} style={{ color: "var(--text-quaternary)" }} />
                  </button>
                ))}
              </div>
            </div>
          )}

          <div style={{ flex: "1 1 240px", minWidth: 220, background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: "var(--r-lg)", padding: "11px 13px", display: "flex", flexDirection: "column", gap: 9 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)" }}>
              <Icon name="bot" size={14} style={{ color: "var(--text-tertiary)" }} /> <span style={{ whiteSpace: "nowrap" }}>Active agents</span>
            </div>
            {agentRows.length === 0 ? (
              <span style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>No agents attached right now.</span>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {agentRows.map(({ a, n }) => (
                  <span key={a.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 9px 3px 6px", borderRadius: 99, background: `color-mix(in srgb, ${a.color} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${a.color} 32%, transparent)` }}>
                    <AgentGlyph id={a.id} size={13} />
                    <span style={{ fontSize: "var(--fs-12)", fontWeight: "var(--fw-medium)" }}>{a.short}</span>
                    <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)" }}>{n}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* workspace header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 2 }}>
          <h2 style={{ margin: 0, fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)", letterSpacing: "var(--ls-snug)", display: "flex", alignItems: "center", gap: 8 }}>
            Sessions
            {filter && <button className="chip fr" onClick={() => setFilter(null)} style={{ cursor: "pointer" }}>
              <span style={{ width: 6, height: 6, borderRadius: 99, background: filter === "conflict" ? "var(--conflict)" : "var(--ready)" }} />
              {filter === "conflict" ? "Conflicts" : "Ready"} <Icon name="x" size={11} />
            </button>}
          </h2>
          <div style={{ flex: 1 }} />
          <SegmentedControl ariaLabel="Workspace view" value={view} onChange={setView}
            options={[{ value: "board", label: "Board", icon: "columns" }, { value: "canvas", label: "Canvas", icon: "network" }]} />
        </div>
      </div>

      {/* workspace */}
      <div style={{ flex: 1, minHeight: 0 }}>
        {view === "board"
          ? <Board sessions={filter ? sessions.filter((s) => (filter === "conflict" ? s.status === "conflict" : deriveColumn(s) === filter)) : sessions}
              loading={loading} error={status.error && !sessions.length ? status.error : null} onOpen={onOpen} writeEnabled={writeEnabled} onRetry={status.refetch} onNewSession={onNewSession} />
          : <CanvasView sessions={sessions} loading={loading} onOpen={onOpen} />}
      </div>
    </div>
  );
}
