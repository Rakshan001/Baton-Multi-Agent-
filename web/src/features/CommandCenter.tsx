/* ============================================================
   BATON — Command Center (home) (ported from command-center.jsx)
   At-a-glance summary + the Sessions workspace (board ⇄ canvas).
   ============================================================ */
import type { ReactNode } from "react";
import { Icon } from "../components/Icon";
import { AgentBadge, SegmentedControl } from "../components/primitives";
import { AGENT_REGISTRY, AgentGlyph } from "../lib/registry";
import { deriveColumn } from "../lib/derive";
import { Board } from "./Board";
import { HandoffInbox } from "./Handoff";
import { CanvasView } from "./Canvas";
import type { StatusRow } from "../types";
import type { Project } from "../lib/preview";
import type { PollState } from "../hooks/usePoll";
import type { View } from "../hooks/usePrefs";

type Tone = "conflict" | "ready" | "accent" | "clean" | "default";
type Filter = "conflict" | "ready" | null;

/** One reading on the instrument strip: colored tick, mono number, label. */
function StatSeg({ label, value, tone, sub, onClick, active }: {
  label: string; value: ReactNode; tone?: Tone; sub?: string; onClick?: () => void; active?: boolean;
}) {
  const color = ({ conflict: "var(--conflict)", ready: "var(--ready)", accent: "var(--accent)", clean: "var(--clean)" } as Record<string, string>)[tone || ""] || "var(--idle)";
  const hot = tone === "conflict" && typeof value === "number" && value > 0;
  return (
    <button className="stat-seg fr" onClick={onClick} aria-pressed={onClick ? active : undefined}
      data-clickable={onClick ? "true" : undefined} data-active={active ? "true" : undefined} tabIndex={onClick ? 0 : -1}>
      <span className="stat-tick" style={{ "--seg-color": color } as React.CSSProperties} />
      <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
        <span className="stat-num" style={hot ? { color: "var(--conflict-text)" } : undefined}>{value}</span>
        <span className="stat-label">{label}{sub ? <span style={{ color: "var(--text-quaternary)" }}> · {sub}</span> : null}</span>
      </span>
    </button>
  );
}

export function CommandCenter({
  status, rootAgents, view, setView, onOpen, writeEnabled, filter, setFilter, project, onNewSession,
}: {
  status: PollState<StatusRow[]>;
  /** Agents at the hub/repo root or a kb sub-project — no task worktree of their own. */
  rootAgents?: Array<{ agent: string; count: number }>;
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
  const rootAgentCount = (rootAgents ?? []).reduce((sum, r) => sum + r.count, 0);

  const byAgent: Record<string, number> = {};
  active.forEach((s) => { byAgent[s.agent!] = (byAgent[s.agent!] || 0) + 1; });
  (rootAgents ?? []).forEach((r) => { byAgent[r.agent] = (byAgent[r.agent] || 0) + r.count; });
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
        <div className="stat-strip">
          <StatSeg label="Active sessions" value={loading ? "—" : active.length + rootAgentCount} tone="accent" sub={rootAgentCount > 0 ? `${sessions.length} tracked + ${rootAgentCount} at root` : `of ${sessions.length}`} />
          <StatSeg label="In progress" value={loading ? "—" : dirty.length} tone="clean" />
          <StatSeg label="Conflicts" value={loading ? "—" : conflicts.length} tone="conflict" onClick={() => setFilter(filter === "conflict" ? null : "conflict")} active={filter === "conflict"} />
          <StatSeg label="Ready to merge" value={loading ? "—" : ready.length} tone="ready" onClick={() => setFilter(filter === "ready" ? null : "ready")} active={filter === "ready"} />
        </div>

        {/* attention + agents strip */}
        <div className="cc-strip" style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <HandoffInbox />
          {conflicts.length > 0 && (
            <div style={{ flex: "2 1 360px", minWidth: 280, background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderLeft: "3px solid var(--conflict)", borderRadius: "var(--r-lg)", padding: "11px 13px", display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)" }}>
                <Icon name="alertTriangle" size={14} strokeWidth={2} style={{ color: "var(--conflict-text)" }} /> <span style={{ whiteSpace: "nowrap" }}>Needs attention</span>
                <span className="mono" style={{ marginLeft: "auto", fontSize: "var(--fs-12)", fontWeight: "var(--fw-regular)", color: "var(--text-tertiary)", whiteSpace: "nowrap" }}>
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

          <div style={{ flex: "1 1 240px", minWidth: 220, background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderLeft: "3px solid var(--idle)", borderRadius: "var(--r-lg)", padding: "11px 13px", display: "flex", flexDirection: "column", gap: 9 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)" }}>
              <Icon name="bot" size={14} style={{ color: "var(--text-tertiary)" }} /> <span style={{ whiteSpace: "nowrap" }}>Active agents</span>
              {rootAgentCount > 0 && (
                <span className="mono" style={{ marginLeft: "auto", fontSize: "var(--fs-11)", fontWeight: "var(--fw-regular)", color: "var(--text-tertiary)", whiteSpace: "nowrap" }}>
                  {rootAgentCount} at repo root
                </span>
              )}
            </div>
            {agentRows.length === 0 ? (
              <span style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>No agents attached right now.</span>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {agentRows.map(({ a, n }) => (
                  <span key={a.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 9px 3px 6px", borderRadius: "var(--r-sm)", background: "var(--bg-surface-2)", border: "1px solid var(--border-subtle)" }}>
                    <AgentGlyph id={a.id} size={13} />
                    <span style={{ fontSize: "var(--fs-12)", fontWeight: "var(--fw-medium)" }}>{a.short}</span>
                    <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)" }}>{n}</span>
                  </span>
                ))}
              </div>
            )}
            {rootAgentCount > 0 && (
              <span style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)", lineHeight: 1.4 }}>
                Running in plain terminals at the repo root (not in a managed worktree). They still coordinate via the baton MCP tools.
              </span>
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
