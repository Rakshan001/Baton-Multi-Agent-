/* ============================================================
   BATON — Agents registry screen (ported from admin.jsx, v2)
   ============================================================ */
import { Icon } from "../components/Icon";
import { AgentGlyph, AGENT_REGISTRY } from "../lib/registry";
import { ScreenHeader } from "./shared";
import { progressEstimate } from "../lib/format";
import { deriveColumn, COLUMN_DEFS } from "../lib/derive";
import type { StatusRow, TaskHistory, AgentId } from "../types";
import type { PollState } from "../hooks/usePoll";

export function AgentsScreen({
  status, history, onOpen, onLaunch,
}: {
  status: PollState<StatusRow[]>;
  history: PollState<TaskHistory[]>;
  onOpen: (slug: string) => void;
  onLaunch: (agent: AgentId | null) => void;
}) {
  const sessions = status.data || [];
  const hist = history.data || [];
  const totalActive = sessions.filter((s) => s.agent !== null).length;
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <ScreenHeader title="Agents" subtitle={`${AGENT_REGISTRY.length} agents in the registry · ${totalActive} active session${totalActive === 1 ? "" : "s"}`}>
        <button className="btn btn-primary fr" onClick={() => onLaunch(null)}><Icon name="plus" size={14} /> Launch session</button>
      </ScreenHeader>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 20 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(296px, 1fr))", gap: 14, alignItems: "start" }}>
          {AGENT_REGISTRY.map((a) => {
            const active = sessions.filter((s) => s.agent === a.id);
            const merged = hist.filter((h) => h.agent === a.id && h.mergedAt);
            const commits = merged.reduce((n, h) => n + h.commits.length, 0) + active.reduce((n, s) => n + s.ahead, 0);
            const conflicts = active.filter((s) => s.status === "conflict").length;
            const avgProg = active.length ? Math.round((active.reduce((n, s) => n + progressEstimate(s.ahead), 0) / active.length) * 100) : 0;
            const stats: { k: string; v: number; danger?: boolean }[] = [
              { k: "Active", v: active.length }, { k: "Merged", v: merged.length },
              { k: "Commits", v: commits }, { k: "Conflicts", v: conflicts, danger: conflicts > 0 },
            ];
            return (
              <div key={a.id} className="card" style={{ padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
                {/* header */}
                <div style={{ padding: "14px 15px", display: "flex", alignItems: "center", gap: 12, borderBottom: "1px solid var(--border-subtle)", background: `linear-gradient(180deg, color-mix(in srgb, ${a.color} 8%, transparent), transparent)` }}>
                  <span style={{ width: 40, height: 40, borderRadius: 11, display: "grid", placeItems: "center", flex: "none", background: `color-mix(in srgb, ${a.color} 15%, transparent)`, border: `1px solid color-mix(in srgb, ${a.color} 36%, transparent)`, boxShadow: `inset 0 0 16px color-mix(in srgb, ${a.color} 10%, transparent)` }}>
                    <AgentGlyph id={a.id} size={20} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "var(--fs-15)", fontWeight: "var(--fw-semibold)" }}>{a.label}</div>
                    <div className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)", display: "flex", alignItems: "center", gap: 5 }}>
                      <span style={{ width: 9, height: 9, borderRadius: 3, background: a.color }} /> {a.color}
                    </div>
                  </div>
                  {active.length > 0 ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: "var(--fs-12)", fontWeight: "var(--fw-semibold)", color: a.color, background: `color-mix(in srgb, ${a.color} 14%, transparent)`, borderRadius: 99, padding: "3px 9px", flex: "none" }}>
                      <span style={{ width: 6, height: 6, borderRadius: 99, background: a.color, animation: "pulse-dot 2s var(--ease-in-out) infinite" }} /> {active.length} active
                    </span>
                  ) : (
                    <span style={{ fontSize: "var(--fs-12)", color: "var(--text-quaternary)", background: "var(--bg-surface-2)", border: "1px solid var(--border-subtle)", borderRadius: 99, padding: "3px 9px", flex: "none" }}>idle</span>
                  )}
                </div>

                {/* aggregate progress */}
                {active.length > 0 && (
                  <div style={{ padding: "11px 15px 4px", display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)" }}>Overall progress <span style={{ color: "var(--text-quaternary)", fontStyle: "italic" }}>est.</span></span>
                      <span className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)", fontWeight: "var(--fw-medium)" }}>{avgProg}%</span>
                    </div>
                    <div style={{ height: 5, borderRadius: 99, background: "var(--bg-active)", overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${Math.max(avgProg > 0 ? 6 : 0, avgProg)}%`, borderRadius: 99, transition: "width var(--dur-3) var(--ease-out)", background: `linear-gradient(90deg, color-mix(in srgb, ${a.color} 55%, transparent), ${a.color})` }} />
                    </div>
                  </div>
                )}

                {/* stats */}
                <div style={{ display: "flex", padding: "12px 15px", gap: 0 }}>
                  {stats.map((m, i) => (
                    <div key={m.k} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2, borderLeft: i ? "1px solid var(--border-subtle)" : "none", paddingLeft: i ? 12 : 0 }}>
                      <span className="mono" style={{ fontSize: "var(--fs-18)", fontWeight: "var(--fw-semibold)", color: m.danger ? "var(--conflict-text)" : "var(--text-primary)", letterSpacing: "-0.02em" }}>{m.v}</span>
                      <span style={{ fontSize: 10, color: "var(--text-tertiary)", letterSpacing: "var(--ls-caps)", textTransform: "uppercase" }}>{m.k}</span>
                    </div>
                  ))}
                </div>

                {/* active sessions */}
                {active.length > 0 && (
                  <div style={{ padding: "0 9px 9px", display: "flex", flexDirection: "column", gap: 3, maxHeight: 156, overflowY: "auto" }}>
                    {active.map((s) => {
                      const cd = COLUMN_DEFS.find((c) => c.id === deriveColumn(s))!; const prog = Math.round(progressEstimate(s.ahead) * 100);
                      return (
                        <button key={s.slug} className="fr" onClick={() => onOpen(s.slug)} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 8px", borderRadius: "var(--r-sm)", border: "none", background: "var(--bg-surface-2)", cursor: "pointer", textAlign: "left" }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-elevated)")} onMouseLeave={(e) => (e.currentTarget.style.background = "var(--bg-surface-2)")}>
                          <span style={{ width: 7, height: 7, borderRadius: 99, background: cd.color, flex: "none" }} data-tip={cd.label} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.task}</div>
                            <div style={{ height: 3, borderRadius: 99, background: "var(--bg-active)", overflow: "hidden", marginTop: 4 }}><div style={{ height: "100%", width: `${Math.max(s.ahead > 0 ? 6 : 0, prog)}%`, background: a.color, borderRadius: 99 }} /></div>
                          </div>
                          <span className="mono" style={{ fontSize: 10, color: "var(--text-quaternary)", flex: "none" }}>↑{s.ahead}</span>
                          <Icon name="chevronRight" size={13} style={{ color: "var(--text-quaternary)", flex: "none" }} />
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* launch */}
                <div style={{ marginTop: "auto", padding: "10px 12px", borderTop: "1px solid var(--border-subtle)" }}>
                  <button className="btn btn-sm fr" onClick={() => onLaunch(a.id)} style={{ width: "100%" }}>
                    <Icon name="zap" size={13} /> Launch {a.short} session
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
