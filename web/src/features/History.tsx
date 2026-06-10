/* ============================================================
   BATON — History / Provenance (ported from insights.jsx)
   ============================================================ */
import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { AgentBadge, EmptyState, ErrorState } from "../components/primitives";
import { ScreenHeader, SearchInput, AgentFilter } from "./shared";
import { getAgent } from "../lib/registry";
import { timeAgo } from "../lib/format";
import { BatonAPI } from "../lib/api";
import type { TaskHistory, AgentId, CompletionReport } from "../types";
import type { PollState } from "../hooks/usePoll";

/** Lazy completion-report details for an expanded merged task. */
function ReportBlock({ slug }: { slug: string }) {
  const [report, setReport] = useState<CompletionReport | null | "loading">("loading");
  useEffect(() => {
    let on = true;
    BatonAPI.getReport(slug).then((r) => { if (on) setReport(r); }).catch(() => { if (on) setReport(null); });
    return () => { on = false; };
  }, [slug]);
  if (report === "loading" || report === null) return null;
  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px dashed var(--border-subtle)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <Icon name="checkCircle" size={13} style={{ color: "var(--clean)" }} />
        <span style={{ fontSize: "var(--fs-12)", fontWeight: "var(--fw-semibold)" }}>Completion report</span>
        {report.overlappedWith.length > 0 && (
          <span className="tag" data-tip={`Overlapped with: ${report.overlappedWith.join(", ")}`}>
            notified {report.overlappedWith.length} waiting session{report.overlappedWith.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {report.files.slice(0, 16).map((f) => (
          <span key={f} className="mono" style={{ fontSize: 10.5, color: "var(--text-secondary)", background: "var(--bg-surface-2)", border: "1px solid var(--border-subtle)", borderRadius: 6, padding: "2px 7px" }}>{f}</span>
        ))}
        {report.files.length > 16 && <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>+{report.files.length - 16} more</span>}
      </div>
    </div>
  );
}

export function HistoryScreen({ history, onOpen }: { history: PollState<TaskHistory[]>; onOpen: (slug: string) => void }) {
  const [q, setQ] = useState("");
  const [agent, setAgent] = useState<AgentId | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const data = history.data || [];
  const agents = [...new Set(data.map((h) => h.agent).filter(Boolean))] as AgentId[];

  const rows = data.filter((h) => {
    if (agent && h.agent !== agent) return false;
    if (q) { const s = (h.task + " " + h.slug + " " + h.commits.map((c) => c.message).join(" ")).toLowerCase(); if (!s.includes(q.toLowerCase())) return false; }
    return true;
  }).sort((a, b) => {
    if (!a.mergedAt && b.mergedAt) return -1; if (a.mergedAt && !b.mergedAt) return 1;
    return new Date(b.mergedAt || 0).getTime() - new Date(a.mergedAt || 0).getTime();
  });

  const mergedCount = data.filter((h) => h.mergedAt).length;
  const totalCommits = data.reduce((n, h) => n + h.commits.length, 0);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <ScreenHeader title="History" subtitle={`${mergedCount} merged · ${totalCommits} commits across the timeline`}>
        <SearchInput value={q} onChange={setQ} placeholder="Search tasks, commits…" />
      </ScreenHeader>
      <div style={{ padding: "12px 20px 0" }}><AgentFilter agents={agents} value={agent} onChange={setAgent} /></div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 20px 24px" }}>
        {history.isLoading && !data.length ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 58, borderRadius: 12 }} />)}</div>
        ) : history.error && !data.length ? (
          <div className="card"><ErrorState onRetry={history.refetch} /></div>
        ) : rows.length === 0 ? (
          <EmptyState icon="history" title={data.length ? "No matches" : "No history yet"}
            desc={data.length ? "Try a different agent or search." : "Merged sessions and their commit lineage will appear here."}
            command={data.length ? undefined : "baton merge settings-dark-mode"} />
        ) : (
          <ol style={{ listStyle: "none", margin: 0, padding: 0, position: "relative" }}>
            <span aria-hidden="true" style={{ position: "absolute", left: 19, top: 10, bottom: 10, width: 1.5, background: "var(--border-subtle)" }} />
            {rows.map((h) => {
              const a = getAgent(h.agent); const open = expanded[h.slug]; const inProgress = !h.mergedAt;
              return (
                <li key={h.slug} style={{ position: "relative", paddingLeft: 44, marginBottom: 10 }}>
                  <span style={{ position: "absolute", left: 12, top: 16, width: 16, height: 16, borderRadius: 99, display: "grid", placeItems: "center", background: "var(--bg-base)", border: `2px solid ${inProgress ? "var(--dirty)" : a.color}`, zIndex: 1 }}>
                    {!inProgress && <span style={{ width: 5, height: 5, borderRadius: 99, background: a.color }} />}
                  </span>
                  <div className="card" style={{ overflow: "hidden" }}>
                    <button className="fr" onClick={() => setExpanded((e) => ({ ...e, [h.slug]: !e[h.slug] }))} aria-expanded={!!open} style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "11px 13px", background: "transparent", border: "none", cursor: "pointer", textAlign: "left" }}>
                      <AgentBadge id={h.agent} size="sm" showLabel={false} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: "var(--fs-14)", fontWeight: "var(--fw-medium)", color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.task}</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3 }}>
                          <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)" }}>{h.slug}</span>
                          <span style={{ fontSize: "var(--fs-11)", color: "var(--text-quaternary)" }}>·</span>
                          <span style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)" }}>{a.short}</span>
                        </div>
                      </div>
                      <span className="chip" style={{ height: 22 }}><Icon name="gitCommit" size={12} /> {h.commits.length}</span>
                      {inProgress ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: "var(--fs-12)", color: "var(--dirty-text)", background: "var(--dirty-soft)", border: "1px solid var(--dirty-border)", borderRadius: 99, padding: "2px 9px" }}>
                          <span style={{ width: 6, height: 6, borderRadius: 99, background: "var(--dirty)", animation: "pulse-dot 1.6s infinite" }} /> open
                        </span>
                      ) : (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: "var(--fs-12)", color: "var(--clean-text)" }}>
                          <Icon name="gitMerge" size={12} /> {timeAgo(h.mergedAt)}
                        </span>
                      )}
                      <Icon name="chevronDown" size={15} style={{ color: "var(--text-tertiary)", transform: open ? "rotate(180deg)" : "none", transition: "transform var(--dur-2)" }} />
                    </button>
                    {open && (
                      <div style={{ borderTop: "1px solid var(--border-subtle)", padding: "10px 13px 12px 16px", animation: "fade-in var(--dur-2)" }}>
                        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 9 }}>
                          {h.commits.map((c) => (
                            <li key={c.sha} style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                              <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--accent-text)", flex: "none", width: 56 }}>{c.sha.slice(0, 7)}</span>
                              <span style={{ flex: 1, fontSize: "var(--fs-13)", color: "var(--text-secondary)", textWrap: "pretty" }}>{c.message}</span>
                              <span style={{ fontSize: "var(--fs-11)", color: "var(--text-quaternary)", flex: "none" }}>{timeAgo(c.at)}</span>
                            </li>
                          ))}
                        </ol>
                        {!inProgress && <ReportBlock slug={h.slug} />}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
