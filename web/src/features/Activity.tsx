/* ============================================================
   BATON — Activity dashboard (ported from activity.jsx)
   Real mode: everything is derived from /api/status + /api/signals.
   Demo mode keeps the illustrative token-usage showcase (labelled).
   ============================================================ */
import type { ReactNode } from "react";
import { Icon, type IconName } from "../components/Icon";
import { AgentBadge, EmptyState } from "../components/primitives";
import { ScreenHeader, isSettled } from "./shared";
import { AGENT_REGISTRY, getAgent } from "../lib/registry";
import { progressEstimate, timeAgo } from "../lib/format";
import { getUsage, fmtTokens, fmtUsd } from "../lib/preview";
import { BatonAPI } from "../lib/api";
import { usePoll, type PollState } from "../hooks/usePoll";
import type { StatusRow, EditSignal, PresenceSession, AgentId, RepoUsage } from "../types";

export function Sparkline({ data, color = "var(--accent)", w = 64, h = 22 }: { data: number[]; color?: string; w?: number; h?: number }) {
  const max = Math.max(1, ...data); const n = data.length;
  if (n === 0) return null;
  const y = (v: number) => h - (v / max) * (h - 3) - 1.5;
  // A single datapoint has no i/(n-1) slope — draw it as a flat line.
  const pts = n === 1 ? `0,${y(data[0])} ${w},${y(data[0])}` : data.map((v, i) => `${(i / (n - 1)) * w},${y(v)}`).join(" ");
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

function UsageBar({ inTok, outTok, max, color, tip }: { inTok: number; outTok: number; max: number; color: string; tip?: string }) {
  const pct = (n: number) => `${(n / Math.max(1, max)) * 100}%`;
  return (
    <div style={{ display: "flex", height: 8, borderRadius: 99, overflow: "hidden", background: "var(--bg-active)", width: "100%" }} data-tip={tip ?? `${fmtTokens(inTok)} in · ${fmtTokens(outTok)} out`}>
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

/**
 * ISS-16 — demo mode must not silently swallow a real daemon's signals. Demo
 * defaults ON on the Vite dev origin, and this screen deliberately shows no
 * fabricated signals (they'd be indistinguishable from real ones), so without
 * this note a developer running `baton serve` and viewing :5173 sees the panel
 * simply absent and reads it as "the daemon is broken / there's nothing there".
 * Say why, and how to see the real thing.
 */
function DemoSignalsNote() {
  return (
    <section className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 8 }}>
        <Icon name="zap" size={14} style={{ color: "var(--text-tertiary)" }} />
        <h2 style={{ margin: 0, fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)" }}>Live edit signals</h2>
        <span className="tag" style={{ marginLeft: "auto" }}>demo</span>
      </div>
      <div style={{ padding: "14px 16px", fontSize: "var(--fs-13)", color: "var(--text-tertiary)", textWrap: "pretty" }}>
        Demo data is on, so this panel isn't querying the daemon — live edits and connected agents are
        only ever shown from a real <span className="mono">baton serve</span>. Turn off <b style={{ color: "var(--text-secondary)", fontWeight: 600 }}>Demo data</b> in
        the ⌘K palette to see <span className="mono">/api/signals</span> for this repo.
      </div>
    </section>
  );
}

/** Real mode: files under live edit right now (from /api/signals). */
function LiveSignalsSection() {
  const signals = usePoll<EditSignal[]>(() => BatonAPI.getSignals(), { interval: 5000 });
  const rows = signals.data ?? [];
  const active = rows.filter((s) => !isSettled(s));
  return (
    <section className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 8 }}>
        <Icon name="zap" size={14} style={{ color: "var(--text-tertiary)" }} />
        <h2 style={{ margin: 0, fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)" }}>Live edit signals</h2>
        {signals.error != null && rows.length > 0 && (<span style={{ fontSize: "var(--fs-12)", color: "var(--dirty-text)" }} data-tip="The last refresh failed — this list may be stale">may be stale</span>)}
        <span style={{ marginLeft: "auto", fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>{active.length ? `${active.length} file${active.length === 1 ? "" : "s"}` : ""}</span>
      </div>
      <div style={{ padding: rows.length ? "4px 16px 10px" : 0 }}>
        {signals.error && !signals.data ? (
          <div style={{ padding: "14px 16px", fontSize: "var(--fs-13)", color: "var(--conflict-text)", display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="alertTriangle" size={13} style={{ flex: "none" }} />
            Couldn't load live signals.
            <button className="btn btn-sm fr" onClick={signals.refetch} style={{ marginLeft: "auto" }}>Retry</button>
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: "14px 16px", fontSize: "var(--fs-13)", color: "var(--text-tertiary)" }}>No files being edited right now.</div>
        ) : [...active, ...rows.filter(isSettled)].slice(0, 10).map((s) => (
          <div key={s.path} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--border-subtle)", background: "transparent", opacity: isSettled(s) ? 0.55 : 1 }}>
            {s.level === "warning"
              ? <Icon name="alertTriangle" size={13} style={{ color: "var(--conflict)", flex: "none" }} />
              : <span style={{ width: 7, height: 7, borderRadius: 99, background: isSettled(s) ? "var(--text-quaternary)" : "var(--accent)", flex: "none", margin: "0 3px" }} />}
            <span className="mono" style={{ fontSize: "var(--fs-12)", color: s.level === "warning" ? "var(--conflict-text)" : "var(--text-secondary)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.path}</span>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>
              {s.holders.slice(0, 3).map((h, i) => (
                <span key={`${h.slug}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 5 }} data-tip={h.settledAt ? `finished ${timeAgo(new Date(h.settledAt).getTime())}` : h.lastEditAt ? `last edit ${timeAgo(new Date(h.lastEditAt).getTime())}` : undefined}>
                  <AgentBadge id={(h.agent as AgentId) ?? null} size="sm" showLabel={false} />
                  <span className="mono" style={{ fontSize: 10, color: "var(--text-tertiary)", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.slug}</span>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Real mode: agents connected right now that have no task worktree — the plain
   terminal / MCP sessions the worktree-only board can't show (ISS-12/ISS-14). */
function ConnectedAgentsSection() {
  const presence = usePoll<PresenceSession[]>(() => BatonAPI.getSessions(), { interval: 5000 });
  const rows = presence.data ?? [];
  if (rows.length === 0) return null; // nothing connected outside worktrees — stay quiet
  const shortRoot = (p: string | null) => (p ? p.split("/").filter(Boolean).slice(-2).join("/") : "");
  return (
    <section className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 8 }}>
        <Icon name="bot" size={14} style={{ color: "var(--text-tertiary)" }} />
        <h2 style={{ margin: 0, fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)" }}>Connected agents</h2>
        {presence.error != null && rows.length > 0 && (<span style={{ fontSize: "var(--fs-12)", color: "var(--dirty-text)" }} data-tip="The last refresh failed — this list may be stale">may be stale</span>)}
        <span style={{ marginLeft: "auto", fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }} data-tip="Sessions connected via MCP or edit hooks, working outside a Baton task worktree">{rows.length} session{rows.length === 1 ? "" : "s"}</span>
      </div>
      <div>
        {rows.slice(0, 10).map((s) => (
          <div key={s.slug} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: "1px solid var(--border-subtle)" }}>
            <span style={{ position: "relative", width: 7, height: 7, flex: "none" }} data-tip={s.live ? "active recently" : `last seen ${timeAgo(new Date(s.lastSeen).getTime())}`}>
              <span style={{ position: "absolute", inset: 0, borderRadius: 99, background: s.live ? "var(--ready)" : "var(--idle)" }} />
              {s.live && <span style={{ position: "absolute", inset: 0, borderRadius: 99, background: "var(--ready)", animation: "ping 1.6s var(--ease-out) infinite" }} />}
            </span>
            <AgentBadge id={(s.agent as AgentId) ?? null} size="sm" showLabel={false} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.slug}</div>
              {s.root && <div className="mono" style={{ fontSize: 10, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shortRoot(s.root)}</div>}
            </div>
            <span style={{ flex: "none", fontSize: "var(--fs-11)", color: "var(--text-tertiary)" }}>{timeAgo(new Date(s.lastSeen).getTime())}</span>
          </div>
        ))}
      </div>
    </section>
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
  const demo = BatonAPI.demo;
  const sessions = status.data || [];
  const active = sessions.filter((s) => s.agent !== null);
  // Real usage from Claude session files (30s poll; null in demo / on error).
  const usage = usePoll<RepoUsage | null>(() => BatonAPI.getRealUsage(), { interval: 30000, enabled: !demo });
  const real = usage.data ?? null;
  const usageBySlug = new Map((real?.sessions ?? []).filter((s) => s.slug).map((s) => [s.slug!, s]));

  const agg = sessions.reduce((a, s) => {
    if (demo) { const u = getUsage(s.slug); a.in += u.input; a.out += u.output; a.req += u.requests; }
    a.commits += s.ahead; a.files += s.filesChanged; a.ins += s.insertions ?? 0; a.del += s.deletions ?? 0;
    return a;
  }, { in: 0, out: 0, req: 0, commits: 0, files: 0, ins: 0, del: 0 });
  const avgProgress = active.length ? Math.round((active.reduce((n, s) => n + progressEstimate(s.ahead), 0) / active.length) * 100) : 0;

  // Per-agent rollup. Demo: fake tokens; real: commits + files from /api/status.
  const byAgent: Record<string, { in: number; out: number; req: number; n: number; commits: number; files: number }> = {};
  active.forEach((s) => {
    const a = byAgent[s.agent!] || { in: 0, out: 0, req: 0, n: 0, commits: 0, files: 0 };
    if (demo) { const u = getUsage(s.slug); a.in += u.input; a.out += u.output; a.req += u.requests; }
    a.n++; a.commits += s.ahead; a.files += s.filesChanged;
    byAgent[s.agent!] = a;
  });
  const agentRows = AGENT_REGISTRY.map((a) => ({ a, u: byAgent[a.id!] })).filter((r) => r.u);
  const maxAgentTok = Math.max(1, ...agentRows.map((r) => r.u.in + r.u.out));
  const maxAgentWork = Math.max(1, ...agentRows.map((r) => r.u.commits + r.u.files));

  const rows = [...active].sort((a, b) => {
    if (demo) { const ua = getUsage(a.slug), ub = getUsage(b.slug); return (ub.input + ub.output) - (ua.input + ua.output); }
    return b.ahead - a.ahead || b.filesChanged - a.filesChanged;
  });

  const cards: { label: string; value: ReactNode; sub: string; icon: IconName; tone?: "accent" | "ready"; preview?: boolean }[] = demo
    ? [
        { label: "Tokens used", value: fmtTokens(agg.in + agg.out), sub: `${fmtTokens(agg.in)} in · ${fmtTokens(agg.out)} out`, icon: "zap", tone: "accent", preview: true },
        { label: "Model requests", value: agg.req, sub: `${active.length} active session${active.length === 1 ? "" : "s"}`, icon: "sparkle", preview: true },
        { label: "Commits ahead", value: agg.commits, sub: "across all branches", icon: "gitCommit" },
        { label: "Avg progress", value: avgProgress + "%", sub: "est. from commits", icon: "history", tone: "ready" },
      ]
    : [
        { label: "Active sessions", value: active.length, sub: `${sessions.length} total worktree${sessions.length === 1 ? "" : "s"}`, icon: "bot", tone: "accent" },
        ...(real && real.totals.sessions > 0
          ? [{
              label: "Tokens used (Claude)", value: fmtTokens(real.totals.inputTokens + real.totals.outputTokens),
              // "≈ $22846.13 est" reads as a bill. It is not one: this is what the
              // logged tokens would cost at API list prices, which a subscription
              // does not charge — say so, and group the digits so a five-figure
              // number is legible at a glance.
              sub: `${real.totals.sessions} session${real.totals.sessions === 1 ? "" : "s"} · cache-read ${fmtTokens(real.totals.cacheReadTokens)} · ≈ ${fmtUsd(real.totals.estCostUsd ?? 0)} at API rates`,
              icon: "zap" as IconName, tone: "accent" as const,
            }]
          : []),
        { label: "Commits ahead", value: agg.commits, sub: "across all branches", icon: "gitCommit" },
        { label: "Files changed", value: agg.files, sub: agg.ins || agg.del ? `+${agg.ins} −${agg.del}` : "uncommitted work", icon: "fileWarning" },
        { label: "Avg progress", value: avgProgress + "%", sub: "est. from commits", icon: "history", tone: "ready" },
      ];

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <ScreenHeader title="Activity" subtitle={demo ? "Progress, token usage & provenance across active sessions" : "Live progress & edit signals across active sessions"} />
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 20 }}>
        {/* No width cap: a centered 1600px column left both ultrawide margins
            empty AND sat right of the full-width ScreenHeader, so the title and
            the cards below it did not share a left edge. This content is
            instrument readings and file paths, not prose — it has no line-length
            ceiling to respect — so it fills the width and aligns left (20px) with
            the header. Stat labels wrap (see .stat-label); nothing ellipses. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {demo && (
            <PreviewBanner>
              <b style={{ color: "var(--text-primary)", fontWeight: 600 }}>Preview.</b> Token usage isn't reported by the Baton API yet — values here are illustrative. Commits &amp; progress are derived from real <span className="mono">/api/status</span> data.
            </PreviewBanner>
          )}

          {status.isLoading && !status.data ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px,1fr))", gap: 12 }}>{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 96, borderRadius: 12 }} />)}</div>
          ) : (
            <>
              <div className="stat-strip">
                {cards.map((c) => (
                  <div key={c.label} className="stat-seg">
                    <span className="stat-tick" style={{ "--seg-color": c.tone === "accent" ? "var(--accent)" : c.tone === "ready" ? "var(--ready)" : "var(--idle)" } as React.CSSProperties} />
                    <span style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                      <span className="stat-num" style={{ display: "inline-flex", alignItems: "baseline", gap: 6 }}>
                        {c.value}
                        {c.preview && <span data-tip="Illustrative — not from the API" style={{ fontSize: 9, fontWeight: 700, letterSpacing: "var(--ls-caps)", textTransform: "uppercase", color: "var(--text-quaternary)", border: "1px dashed var(--border-default)", borderRadius: 99, padding: "1px 5px" }}>est</span>}
                      </span>
                      <span className="stat-label">{c.label}<span style={{ color: "var(--text-quaternary)" }}> · {c.sub}</span></span>
                    </span>
                  </div>
                ))}
              </div>

              {demo ? <DemoSignalsNote /> : <LiveSignalsSection />}
              {!demo && <ConnectedAgentsSection />}

              {/* per-agent rollup: tokens in demo, real work counters otherwise */}
              <section className="card" style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 8 }}>
                  <Icon name="bot" size={14} style={{ color: "var(--text-tertiary)" }} />
                  <h2 style={{ margin: 0, fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)" }}>{demo ? "Token usage by agent" : "Per-agent activity"}</h2>
                  {demo && (
                    <span style={{ marginLeft: "auto", display: "flex", gap: 12, fontSize: "var(--fs-11)", color: "var(--text-tertiary)" }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 9, height: 9, borderRadius: 2, background: "var(--text-secondary)", opacity: 0.55 }} /> input</span>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 9, height: 9, borderRadius: 2, background: "var(--text-secondary)" }} /> output</span>
                    </span>
                  )}
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
                        <div style={{ flex: 1, minWidth: 0 }}>
                          {demo
                            ? <UsageBar inTok={u.in} outTok={u.out} max={maxAgentTok} color={a.color} />
                            : <UsageBar inTok={u.commits} outTok={u.files} max={maxAgentWork} color={a.color} tip={`${u.commits} commit${u.commits === 1 ? "" : "s"} · ${u.files} file${u.files === 1 ? "" : "s"} changed`} />}
                        </div>
                        {demo ? (
                          <>
                            <span className="mono" style={{ width: 84, flex: "none", textAlign: "right", fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}>{fmtTokens(u.in + u.out)}</span>
                            <span className="mono" style={{ width: 58, flex: "none", textAlign: "right", fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }} data-tip="model requests">{u.req} req</span>
                          </>
                        ) : (
                          <>
                            <span className="mono" style={{ width: 84, flex: "none", textAlign: "right", fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}>{u.commits} commit{u.commits === 1 ? "" : "s"}</span>
                            <span className="mono" style={{ width: 58, flex: "none", textAlign: "right", fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>{u.files} files</span>
                          </>
                        )}
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
                    const a = getAgent(s.agent); const prog = Math.round(progressEstimate(s.ahead) * 100);
                    const u = demo ? getUsage(s.slug) : null;
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
                        {u ? (
                          <>
                            <div style={{ flex: "none", width: 80, textAlign: "right" }} className="ar-hide-sm" data-tip={`${fmtTokens(u.input)} in · ${fmtTokens(u.output)} out · ${(u.contextPct * 100).toFixed(0)}% context`}>
                              <div className="mono" style={{ fontSize: "var(--fs-13)", color: "var(--text-primary)" }}>{fmtTokens(u.input + u.output)}</div>
                              <div style={{ fontSize: "var(--fs-11)", color: "var(--text-quaternary)" }}>tokens</div>
                            </div>
                            <div style={{ flex: "none" }} className="ar-hide-md"><Sparkline data={u.spark} color={a.color} /></div>
                          </>
                        ) : (() => {
                          const ru = usageBySlug.get(s.slug);
                          return (
                            <div style={{ flex: "none", width: 110, textAlign: "right" }} className="ar-hide-sm"
                              data-tip={ru ? `${fmtTokens(ru.inputTokens)} in · ${fmtTokens(ru.outputTokens)} out · cache-read ${fmtTokens(ru.cacheReadTokens)} · ≈ $${(ru.estCostUsd ?? 0).toFixed(2)} est` : undefined}>
                              {ru ? (
                                <>
                                  <div className="mono" style={{ fontSize: "var(--fs-13)", color: "var(--text-primary)" }}>{fmtTokens(ru.inputTokens + ru.outputTokens)}</div>
                                  <div style={{ fontSize: "var(--fs-11)", color: "var(--text-quaternary)" }}>tokens · real</div>
                                </>
                              ) : (
                                <>
                                  <div className="mono" style={{ fontSize: "var(--fs-13)", color: "var(--text-primary)" }}>{s.filesChanged} file{s.filesChanged === 1 ? "" : "s"}</div>
                                  <div className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-quaternary)" }}>{s.ahead}↑ {s.behind}↓</div>
                                </>
                              )}
                            </div>
                          );
                        })()}
                        <div style={{ flex: "none", display: "flex", gap: 6 }}>
                          <button className="btn btn-sm fr" onClick={() => onLive(s.slug)} data-tip="Watch live session" style={{ borderColor: "var(--conflict-border)" }}>
                            <span style={{ position: "relative", width: 7, height: 7 }}><span style={{ position: "absolute", inset: 0, borderRadius: 99, background: "var(--conflict-strong)" }} /><span style={{ position: "absolute", inset: 0, borderRadius: 99, background: "var(--conflict-strong)", animation: "ping 1.6s var(--ease-out) infinite" }} /></span>
                            <span className="ar-hide-sm">Live</span>
                          </button>
                          {demo && <button className="btn btn-sm fr" onClick={() => onOpenDiff(s.slug)} data-tip="See code changes (git diff)"><Icon name="terminal" size={13} /> <span className="ar-hide-sm">Diff</span></button>}
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
