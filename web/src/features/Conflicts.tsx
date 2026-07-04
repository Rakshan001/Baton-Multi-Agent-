/* ============================================================
   BATON — Conflicts matrix (ported from insights.jsx)
   The tabular twin of the canvas merge-risk graph.
   ============================================================ */
import { Icon } from "../components/Icon";
import { AgentBadge, EmptyState } from "../components/primitives";
import { ScreenHeader } from "./shared";
import { getAgent } from "../lib/registry";
import { basename, dirname, timeAgo } from "../lib/format";
import { BatonAPI } from "../lib/api";
import { usePoll, type PollState } from "../hooks/usePoll";
import type { StatusRow, EditSignal, AgentId } from "../types";

/** Live edit signals — uncommitted, real-time, from the worktree watcher. */
function LiveSignals({ onOpen }: { onOpen: (slug: string) => void }) {
  const signals = usePoll<EditSignal[]>(() => BatonAPI.getSignals(), { interval: 5000 });
  const rows = signals.data ?? [];
  if (!rows.length) {
    return (
      <div className="card" style={{ marginBottom: 16, padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>
        <Icon name="zap" size={13} style={{ color: signals.error ? "var(--idle)" : "var(--clean)", flex: "none" }} />
        {signals.error ? "Live signals unavailable right now." : "No files under live edit — all clear."}
      </div>
    );
  }
  const warnings = rows.filter((s) => s.level === "warning");
  return (
    <div className="card" style={{ marginBottom: 16, padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <Icon name="zap" size={14} style={{ color: warnings.length ? "var(--conflict)" : "var(--accent)" }} />
        <span style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)" }}>Editing right now</span>
        <span className="tag">{rows.length} file{rows.length === 1 ? "" : "s"}</span>
        {warnings.length > 0 && (
          <span style={{ fontSize: 11, fontWeight: "var(--fw-semibold)", color: "var(--conflict-text)", background: "var(--conflict-soft)", border: "1px solid var(--conflict-border)", borderRadius: 99, padding: "1px 8px" }}>
            {warnings.length} overlapping
          </span>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {rows.slice(0, 12).map((s) => (
          <div key={s.path} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", borderRadius: "var(--r-sm)", background: s.level === "warning" ? "var(--conflict-soft)" : "transparent" }}>
            {s.level === "warning"
              ? <Icon name="alertTriangle" size={13} style={{ color: "var(--conflict)", flex: "none" }} />
              : <span style={{ width: 7, height: 7, borderRadius: 99, background: "var(--accent)", flex: "none", margin: "0 3px" }} />}
            <span className="mono" style={{ fontSize: "var(--fs-12)", color: s.level === "warning" ? "var(--conflict-text)" : "var(--text-secondary)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.path}</span>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flex: "none" }}>
              {s.holders.slice(0, 4).map((h, i) => (
                <button key={`${h.slug}-${i}`} className="fr" onClick={() => onOpen(h.slug)} data-tip={`${h.slug}${h.lastEditAt ? `\nlast edit ${timeAgo(new Date(h.lastEditAt).getTime())}` : ""}`} style={{ display: "inline-flex", alignItems: "center", gap: 5, border: "none", background: "none", cursor: "pointer", padding: 0 }}>
                  <AgentBadge id={(h.agent as AgentId) ?? null} size="sm" showLabel={false} />
                  <span className="mono" style={{ fontSize: 10, color: "var(--text-tertiary)", maxWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.slug}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      {warnings.length > 0 && (
        <p style={{ margin: "10px 0 0", fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>
          Agents checking <span className="mono">check_files</span> before editing will be told to wait on the overlapping paths.
        </p>
      )}
    </div>
  );
}

export function ConflictsScreen({ status, onOpen }: { status: PollState<StatusRow[]>; onOpen: (slug: string) => void }) {
  const sessions = (status.data || []).filter((s) => (s.conflictFiles || []).length);
  const fileMap: Record<string, StatusRow[]> = {};
  sessions.forEach((s) => s.conflictFiles.forEach((f) => { (fileMap[f] = fileMap[f] || []).push(s); }));
  const files = Object.keys(fileMap).sort((a, b) => fileMap[b].length - fileMap[a].length || a.localeCompare(b));
  const cols = sessions;
  const sharedCount = files.filter((f) => fileMap[f].length > 1).length;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <ScreenHeader title="Conflicts" subtitle={files.length ? `${files.length} file${files.length === 1 ? "" : "s"} under edit · ${sharedCount} shared by 2+ sessions` : "Merge-risk matrix from live git status"} />
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 20 }}>
        <LiveSignals onOpen={onOpen} />
        {status.isLoading && !status.data ? (
          <div className="skeleton" style={{ height: 240, borderRadius: 12 }} />
        ) : files.length === 0 ? (
          <EmptyState icon="checkCircle" title="All clear — no overlapping edits"
            desc="When two or more sessions touch the same files, they'll show up here ranked by merge risk." />
        ) : (
          <>
            <div className="card" style={{ overflow: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 480 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: "12px 14px", position: "sticky", left: 0, background: "var(--bg-surface)", zIndex: 2, borderBottom: "1px solid var(--border-default)", minWidth: 220 }}>
                      <span className="tag">File</span>
                    </th>
                    {cols.map((s) => (
                      <th key={s.slug} style={{ padding: "10px 8px", borderBottom: "1px solid var(--border-default)", minWidth: 76 }}>
                        <button className="fr" onClick={() => onOpen(s.slug)} data-tip={`${s.task}\n${s.slug}`} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5, background: "none", border: "none", cursor: "pointer", width: "100%" }}>
                          <AgentBadge id={s.agent} size="sm" showLabel={false} />
                          <span className="mono" style={{ fontSize: 10, color: "var(--text-tertiary)", maxWidth: 70, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.slug}</span>
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {files.map((f) => {
                    const touched = fileMap[f]; const risk = touched.length > 1;
                    return (
                      <tr key={f} style={{ background: risk ? "var(--conflict-soft)" : "transparent" }}>
                        <td style={{ padding: "9px 14px", position: "sticky", left: 0, background: risk ? "color-mix(in srgb, var(--conflict) 9%, var(--bg-surface))" : "var(--bg-surface)", borderBottom: "1px solid var(--border-subtle)", zIndex: 1 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            {risk && <Icon name="alertTriangle" size={13} style={{ color: "var(--conflict)", flex: "none" }} />}
                            <div style={{ minWidth: 0 }}>
                              <div className="mono" style={{ fontSize: "var(--fs-12)", color: risk ? "var(--conflict-text)" : "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{basename(f)}</div>
                              <div className="mono" style={{ fontSize: 10, color: "var(--text-quaternary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dirname(f)}</div>
                            </div>
                            {risk && <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: "var(--fw-semibold)", color: "var(--conflict-text)", background: "color-mix(in srgb, var(--conflict) 16%, transparent)", padding: "1px 6px", borderRadius: 99 }}>×{touched.length}</span>}
                          </div>
                        </td>
                        {cols.map((s) => {
                          const on = touched.some((t) => t.slug === s.slug); const a = getAgent(s.agent);
                          return (
                            <td key={s.slug} style={{ textAlign: "center", padding: "9px 8px", borderBottom: "1px solid var(--border-subtle)" }}>
                              {on ? <button className="fr" onClick={() => onOpen(s.slug)} aria-label={`${basename(f)} in ${s.slug}`} data-tip="Open session" style={{ width: 18, height: 18, borderRadius: 6, border: "none", cursor: "pointer", margin: "0 auto", display: "grid", placeItems: "center", background: `color-mix(in srgb, ${a.color} 22%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${a.color} 50%, transparent)` }}>
                                <span style={{ width: 8, height: 8, borderRadius: 99, background: a.color }} /></button>
                                : <span style={{ color: "var(--text-quaternary)", fontSize: 12 }}>·</span>}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p style={{ marginTop: 12, fontSize: "var(--fs-12)", color: "var(--text-tertiary)", display: "flex", alignItems: "center", gap: 6 }}>
              <Icon name="alertTriangle" size={12} style={{ color: "var(--conflict)" }} /> Highlighted rows are edited by 2+ sessions — resolve or merge one before the other to avoid a collision.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
