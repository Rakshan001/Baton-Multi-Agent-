/* ============================================================
   BATON — Activity dashboard (ported from activity.jsx)
   Progress + token usage (PREVIEW — not from the API) + provenance,
   with per-session entry points to the diff viewer and handoff.
   ============================================================ */
import type { ReactNode } from "react";
import { Icon, type IconName } from "../components/Icon";
import { AgentBadge, EmptyState } from "../components/primitives";
import { ScreenHeader } from "./shared";
import { AGENT_REGISTRY, getAgent } from "../lib/registry";
import { progressEstimate } from "../lib/format";
import { getUsage, fmtTokens } from "../lib/preview";
import type { StatusRow } from "../types";
import type { PollState } from "../hooks/usePoll";

export function Sparkline({ data, color = "var(--accent)", w = 64, h = 22 }: { data: number[]; color?: string; w?: number; h?: number }) {
  const max = Math.max(1, ...data); const n = data.length;
  const pts = data.map((v, i) => `${(i / (n - 1)) * w},${h - (v / max) * (h - 3) - 1.5}`).join(" ");
  const area = `0,${h} ${pts} ${w},${h}`;
  const id = "sp" + Math.abs(data.reduce((a, b) => a * 31 + b, 7)).toString(36);
  return (
    <svg width={w} height={h} aria-hidden="true" style={{ display: "block" }}>
      <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity="0.28" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
      <polygon points={area} fill={`url(#${id})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function UsageBar({ inTok, outTok, max, color }: { inTok: number; outTok: number; max: number; color: string }) {
  const pct = (n: number) => `${(n / Math.max(1, max)) * 100}%`;
  return (
    <div style={{ display: "flex", height: 8, borderRadius: 99, overflow: "hidden", background: "var(--bg-active)", width: "100%" }} data-tip={`${fmtTokens(inTok)} in · ${fmtTokens(outTok)} out`}>
      <span style={{ width: pct(inTok), background: color, opacity: 0.55 }} />
      <span style={{ width: pct(outTok), background: color }} />
    </div>
  );
}

function PreviewBanner({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 13px", borderRadius: "var(--r-md)", background: "var(--accent-soft)", border: "1px dashed var(--accent-border)", color: "var(--accent-text)", fontSize: "var(--fs-12)" }}>
      <Icon name="sparkle" size={15} style={{ flex: "none" }} />
      <span style={{ color: "var(--text-secondary)", textWrap: "pretty" }}>{children}</span>
    </div>
  );
}

export function ActivityScreen({
  status, onOpen, onOpenDiff, onHandoff, onLive,
}: {
  status: PollState<StatusRow[]>;
  onOpen: (slug: string) => void;
  onOpenDiff: (slug: string) => void;
  onHandoff: (slug: string) => void;
  onLive: (slug: string) => void;
}) {
  const sessions = status.data || [];
  const active = sessions.filter((s) => s.agent !== null);

  const agg = sessions.reduce((a, s) => { const u = getUsage(s.slug); a.in += u.input; a.out += u.output; a.req += u.requests; a.commits += s.ahead; return a; }, { in: 0, out: 0, req: 0, commits: 0 });
  const avgProgress = active.length ? Math.round((active.reduce((n, s) => n + progressEstimate(s.ahead), 0) / active.length) * 100) : 0;

  const byAgent: Record<string, { in: number; out: number; req: number; n: number }> = {};
  active.forEach((s) => { const u = getUsage(s.slug); const a = byAgent[s.agent!] || { in: 0, out: 0, req: 0, n: 0 }; a.in += u.input; a.out += u.output; a.req += u.requests; a.n++; byAgent[s.agent!] = a; });
  const agentRows = AGENT_REGISTRY.map((a) => ({ a, u: byAgent[a.id!] })).filter((r) => r.u);
  const maxAgentTok = Math.max(1, ...agentRows.map((r) => r.u.in + r.u.out));

  const rows = [...active].sort((a, b) => { const ua = getUsage(a.slug), ub = getUsage(b.slug); return (ub.input + ub.output) - (ua.input + ua.output); });

  const cards: { label: string; value: ReactNode; sub: string; icon: IconName; tone?: "accent" | "ready"; preview?: boolean }[] = [
    { label: "Tokens used", value: fmtTokens(agg.in + agg.out), sub: `${fmtTokens(agg.in)} in · ${fmtTokens(agg.out)} out`, icon: "zap", tone: "accent", preview: true },
    { label: "Model requests", value: agg.req, sub: `${active.length} active session${active.length === 1 ? "" : "s"}`, icon: "sparkle", preview: true },
    { label: "Commits ahead", value: agg.commits, sub: "across all branches", icon: "gitCommit" },
    { label: "Avg progress", value: avgProgress + "%", sub: "est. from commits", icon: "history", tone: "ready" },
  ];

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <ScreenHeader title="Activity" subtitle="Progress, token usage & provenance across active sessions" />
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 20 }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
          <PreviewBanner>
            <b style={{ color: "var(--text-primary)", fontWeight: 600 }}>Preview.</b> Token usage isn't reported by the Baton API yet — values here are illustrative. Commits &amp; progress are derived from real <span className="mono">/api/status</span> data.
          </PreviewBanner>

          {status.isLoading && !status.data ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px,1fr))", gap: 12 }}>{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 96, borderRadius: 12 }} />)}</div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                {cards.map((c) => (
                  <div key={c.label} className="card" style={{ padding: "13px 15px", display: "flex", flexDirection: "column", gap: 9 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, color: "var(--text-tertiary)" }}>
                      <span style={{ color: c.tone === "accent" ? "var(--accent)" : c.tone === "ready" ? "var(--ready)" : "var(--text-tertiary)", display: "grid" }}><Icon name={c.icon} size={15} /></span>
                      <span style={{ flex: 1, minWidth: 0, fontSize: "var(--fs-12)", fontWeight: "var(--fw-medium)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.label}</span>
                      {c.preview && <span data-tip="Illustrative — not from the API" style={{ marginLeft: "auto", fontSize: 9, fontWeight: 700, letterSpacing: "var(--ls-caps)", textTransform: "uppercase", color: "var(--text-quaternary)", border: "1px dashed var(--border-default)", borderRadius: 99, padding: "1px 5px" }}>est</span>}
                    </div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                      <span className="mono" style={{ fontSize: "var(--fs-26)", fontWeight: "var(--fw-semibold)", letterSpacing: "-0.03em", lineHeight: 1 }}>{c.value}</span>
                    </div>
                    <span style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)" }}>{c.sub}</span>
                  </div>
                ))}
              </div>

              {/* per-agent usage */}
              <section className="card" style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 8 }}>
                  <Icon name="bot" size={14} style={{ color: "var(--text-tertiary)" }} />
                  <h2 style={{ margin: 0, fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)" }}>Token usage by agent</h2>
                  <span style={{ marginLeft: "auto", display: "flex", gap: 12, fontSize: "var(--fs-11)", color: "var(--text-tertiary)" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 9, height: 9, borderRadius: 2, background: "var(--text-secondary)", opacity: 0.55 }} /> input</span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 9, height: 9, borderRadius: 2, background: "var(--text-secondary)" }} /> output</span>
                  </span>
                </div>
                <div style={{ padding: "6px 16px 12px" }}>
                  {agentRows.length === 0 ? <div style={{ padding: "14px 0", fontSize: "var(--fs-13)", color: "var(--text-tertiary)" }}>No active agents.</div> :
                    agentRows.map(({ a, u }) => (
                      <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--border-subtle)" }}>
                        <div style={{ width: 130, flex: "none", display: "flex", alignItems: "center", gap: 8 }}>
                          <AgentBadge id={a.id} size="sm" showLabel={false} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-medium)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.short}</div>
                            <div style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)" }}>{u.n} session{u.n === 1 ? "" : "s"}</div>
                          </div>
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}><UsageBar inTok={u.in} outTok={u.out} max={maxAgentTok} color={a.color} /></div>
                        <span className="mono" style={{ width: 84, flex: "none", textAlign: "right", fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}>{fmtTokens(u.in + u.out)}</span>
                        <span className="mono" style={{ width: 58, flex: "none", textAlign: "right", fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }} data-tip="model requests">{u.req} req</span>
                      </div>
                    ))}
                </div>
              </section>

              {/* sessions table */}
              <section className="card" style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 8 }}>
                  <Icon name="columns" size={14} style={{ color: "var(--text-tertiary)" }} />
                  <h2 style={{ margin: 0, fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)" }}>Active sessions</h2>
                  <span style={{ marginLeft: "auto", fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>{rows.length}</span>
                </div>
                <div>
                  {rows.map((s) => {
                    const u = getUsage(s.slug); const a = getAgent(s.agent); const prog = Math.round(progressEstimate(s.ahead) * 100);
                    return (
                      <div key={s.slug} className="activity-row" style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 16px", borderBottom: "1px solid var(--border-subtle)" }}>
                        <button className="fr" onClick={() => onOpen(s.slug)} style={{ flex: "2 1 220px", minWidth: 0, display: "flex", alignItems: "center", gap: 10, background: "none", border: "none", cursor: "pointer", textAlign: "left", padding: 0 }}>
                          <AgentBadge id={s.agent} size="sm" showLabel={false} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-medium)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.task}</div>
                            <div className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.slug}</div>
                          </div>
                        </button>
                        <div style={{ flex: "1 1 110px", minWidth: 90, display: "flex", flexDirection: "column", gap: 4 }} className="ar-hide-sm">
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--fs-11)", color: "var(--text-tertiary)" }}><span>progress <i style={{ fontStyle: "normal", color: "var(--text-quaternary)" }}>est.</i></span><span className="mono">{prog}%</span></div>
                          <div style={{ height: 4, borderRadius: 99, background: "var(--bg-active)", overflow: "hidden" }}><div style={{ height: "100%", width: `${Math.max(s.ahead > 0 ? 8 : 0, prog)}%`, background: a.color, borderRadius: 99 }} /></div>
                        </div>
                        <div style={{ flex: "none", width: 80, textAlign: "right" }} className="ar-hide-sm" data-tip={`${fmtTokens(u.input)} in · ${fmtTokens(u.output)} out · ${(u.contextPct * 100).toFixed(0)}% context`}>
                          <div className="mono" style={{ fontSize: "var(--fs-13)", color: "var(--text-primary)" }}>{fmtTokens(u.input + u.output)}</div>
                          <div style={{ fontSize: "var(--fs-11)", color: "var(--text-quaternary)" }}>tokens</div>
                        </div>
                        <div style={{ flex: "none" }} className="ar-hide-md"><Sparkline data={u.spark} color={a.color} /></div>
                        <div style={{ flex: "none", display: "flex", gap: 6 }}>
                          <button className="btn btn-sm fr" onClick={() => onLive(s.slug)} data-tip="Watch live session" style={{ borderColor: "var(--conflict-border)" }}>
                            <span style={{ position: "relative", width: 7, height: 7 }}><span style={{ position: "absolute", inset: 0, borderRadius: 99, background: "var(--conflict-strong)" }} /><span style={{ position: "absolute", inset: 0, borderRadius: 99, background: "var(--conflict-strong)", animation: "ping 1.6s var(--ease-out) infinite" }} /></span>
                            <span className="ar-hide-sm">Live</span>
                          </button>
                          <button className="btn btn-sm fr" onClick={() => onOpenDiff(s.slug)} data-tip="See code changes (git diff)"><Icon name="terminal" size={13} /> <span className="ar-hide-sm">Diff</span></button>
                          <button className="btn btn-sm btn-icon fr" onClick={() => onHandoff(s.slug)} data-tip="Hand off to another agent" aria-label="Hand off"><Icon name="share" size={13} /></button>
                        </div>
                      </div>
                    );
                  })}
                  {rows.length === 0 && <div style={{ padding: 28 }}><EmptyState icon="bot" title="No active sessions" desc="Attach an agent to a worktree to see live usage and progress." /></div>}
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
