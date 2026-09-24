// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
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
import { BatonAPI, failureReason } from "../lib/api";
import { usePoll, type PollState } from "../hooks/usePoll";
import { presenceLabel, SET_AGENT_HINT } from "../lib/presenceLabel";
import type { StatusRow, EditSignal, PresenceSession, AgentId, RepoUsage, SessionUsage, UsageTotals, Meta } from "../types";

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
        Demo data is on, so this panel isn't querying the daemon — live edits are
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
                  <span className="mono" style={{ fontSize: "var(--text-micro)", color: "var(--text-tertiary)", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.slug}</span>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Agents connected right now that have no task worktree — the plain
   terminal / MCP sessions the worktree-only board can't show (ISS-12/ISS-14).
   Each is named only as surely as Baton knows it (lib/presenceLabel). In demo
   mode the rows are fixtures and the header says so. */
export function ConnectedAgentsSection({ agentDetection }: { agentDetection?: Meta["agentDetection"] }) {
  const presence = usePoll<PresenceSession[]>(() => BatonAPI.getSessions(), { interval: 5000 });
  const rows = presence.data ?? [];
  // "Nothing connected" and "we could not find out" are different answers, and
  // only the first one earns silence. On a FIRST-load failure `data` is still
  // null, so returning null here hid the panel and swallowed the error the API
  // layer deliberately rethrows — the caller saw an empty board and read it as
  // a measured zero. Once a list has arrived the "may be stale" badge covers it.
  if (rows.length === 0 && presence.error != null) {
    return (
      <section className="card" style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 8 }}>
        <Icon name="bot" size={14} style={{ color: "var(--text-tertiary)" }} />
        <h2 style={{ margin: 0, fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)" }}>Connected agents</h2>
        <span style={{ fontSize: "var(--fs-12)", color: "var(--dirty-text)" }} data-tip="Could not reach the daemon — this is not the same as nobody being connected">
          couldn't load
        </span>
      </section>
    );
  }
  if (rows.length === 0) return null; // nothing connected outside worktrees — stay quiet
  const shortRoot = (p: string | null) => (p ? p.split("/").filter(Boolean).slice(-2).join("/") : "");
  return (
    <section className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 8 }}>
        <Icon name="bot" size={14} style={{ color: "var(--text-tertiary)" }} />
        <h2 style={{ margin: 0, fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)" }}>Connected agents</h2>
        {BatonAPI.demo && <span className="tag">demo</span>}
        {presence.error != null && rows.length > 0 && (<span style={{ fontSize: "var(--fs-12)", color: "var(--dirty-text)" }} data-tip="The last refresh failed — this list may be stale">may be stale</span>)}
        <span style={{ marginLeft: "auto", fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }} data-tip="Sessions connected via MCP or edit hooks, working outside a Baton task worktree">{rows.length} session{rows.length === 1 ? "" : "s"}</span>
      </div>
      {agentDetection === "unavailable" && (
        <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--border-subtle)", fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>
          Agent detection unavailable on this OS — {SET_AGENT_HINT} in each agent's environment.
        </div>
      )}
      <div>
        {rows.slice(0, 10).map((s) => { const label = presenceLabel(s); return (
          <div key={s.slug} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: "1px solid var(--border-subtle)" }}>
            <span style={{ position: "relative", width: 7, height: 7, flex: "none" }} data-tip={s.live ? "active recently" : `last seen ${timeAgo(new Date(s.lastSeen).getTime())}`}>
              <span style={{ position: "absolute", inset: 0, borderRadius: 99, background: s.live ? "var(--ready)" : "var(--idle)" }} />
              {s.live && <span style={{ position: "absolute", inset: 0, borderRadius: 99, background: "var(--ready)", animation: "ping 1.6s var(--ease-out) infinite" }} />}
            </span>
            <AgentBadge id={(s.agent as AgentId) ?? null} size="sm" showLabel={false} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: "var(--fs-12)", color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                <span data-tip={label.tip}>{label.text}</span>
                {label.hint && <span className="mono" style={{ marginLeft: 8, fontSize: "var(--text-micro)", color: "var(--text-tertiary)" }}>{label.hint}</span>}
              </div>
              <div className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.slug}</div>
              {s.root && <div className="mono" style={{ fontSize: "var(--text-micro)", color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shortRoot(s.root)}</div>}
            </div>
            <span style={{ flex: "none", fontSize: "var(--fs-11)", color: "var(--text-tertiary)" }}>{timeAgo(new Date(s.lastSeen).getTime())}</span>
          </div>
        ); })}
      </div>
    </section>
  );
}


/* ---------- spend, per agent and per task ---------- */

/**
 * Where the money went — GET /api/usage (src/usage.ts + src/usage/*.ts).
 *
 * Every number that reaches this section is nullable, and that is the whole
 * design. `null` means the agent's log format never reported that figure;
 * `0` means it reported zero. A spend table that renders the first as `0` or
 * `$0.00` says "this agent spent nothing" about an agent nobody counted, which
 * is worse than showing nothing at all — so an absent measurement is rendered
 * in words, at the number, never as a digit.
 *
 * Three honest outcomes exist and all three are on this screen:
 *   · measured and priced   — Claude sessions
 *   · measured, not priced  — Codex: real tokens, but an OpenAI model billed at
 *                             Claude's rates would be fiction, so no cost
 *   · parsed, not measured  — Antigravity: the transcript format carries no
 *                             token accounting at all
 * and a fourth that is not an outcome but a gap: an agent working in this repo
 * whose logs Baton cannot read at all. That agent is named here too, because
 * someone comparing this total against their provider bill needs to know what
 * is missing from it.
 */

/*
 * There is no roster of readable agents here on purpose. Which agents Baton can
 * parse, and the path each is read from, arrive in the /api/usage payload
 * (`readable`) because the daemon is the one place that knows — a fourth parser
 * used to mean editing src/usage.ts, a new src/usage/<agent>.ts AND two
 * constants in this file, and the screen went quietly stale whenever someone
 * forgot the browser half.
 */

/** How much of a rollup was actually measured — decided from the nulls, not guessed. */
function coverageOf(t: UsageTotals): "full" | "partial" | "none" {
  if (t.totalTokens == null) return "none";
  const counts = [t.inputTokens, t.outputTokens, t.cacheReadTokens, t.cacheWriteTokens, t.estCostUsd];
  // A cost that leaves out unpriced sessions is partial even when it is a number.
  return counts.some((n) => n == null) || (t.unpricedSessions ?? 0) > 0 ? "partial" : "full";
}

/**
 * The spend card's headline: tokens actually consumed (input + output + cache
 * writes). Cache reads are re-reads of context — billed at a fraction and
 * usually 95%+ of the raw total — so they get their own line instead of
 * swamping the number. A daemon older than `consumedTokens` keeps the old label.
 */
export function tokenHeadline(t: UsageTotals): { label: string; n: number | null } {
  return t.consumedTokens !== undefined ? { label: "Tokens used", n: t.consumedTokens } : { label: "Tokens counted", n: t.totalTokens };
}

/** The headline number, or the words for one nobody measured — never a 0 or a dash. */
export function headlineValue(n: number | null): ReactNode {
  return n == null
    ? <NotCounted tip="None of the readable agents' logs reported token counts. Absent, not zero." />
    : fmtTokens(n);
}

/** The cost part of the card: where the prices come from, and "partial" when
 *  some sessions spent tokens on a model with no price. `asOf` is the daemon's
 *  price-table date; an older daemon sends none, so none is shown. */
export function costLine(t: UsageTotals, asOf?: string): string {
  if (t.estCostUsd == null) return "no priced model";
  const unpriced = t.unpricedSessions ?? 0;
  return `≈ ${fmtUsd(t.estCostUsd)} at API list prices${asOf ? ` (${asOf})` : ""}`
    + (unpriced > 0 ? ` · partial: excl. ${unpriced} unpriced session${unpriced === 1 ? "" : "s"}` : "");
}

/** One session per task slug — the FIRST in the list, which is the newest,
 *  because the daemon serves sessions newest first. */
export function newestBySlug(sessions: SessionUsage[]): Map<string, SessionUsage> {
  const m = new Map<string, SessionUsage>();
  for (const s of sessions) if (s.slug && !m.has(s.slug)) m.set(s.slug, s);
  return m;
}

/** A measurement nobody took. In words, in place of the number — never a 0. */
function NotCounted({ label = "not counted", tip }: { label?: string; tip: string }) {
  return (
    <span data-tip={tip} style={{ fontSize: "var(--fs-11)", color: "var(--text-quaternary)", whiteSpace: "nowrap", fontStyle: "italic" }}>
      {label}
    </span>
  );
}

/**
 * Placement that was DEDUCED, marked where it is displayed.
 *
 * Antigravity's transcripts record no working directory, so the daemon places
 * those sessions by the paths their own tool calls touched. That is evidence,
 * not measurement, and a deduced row sitting unmarked beside measured ones
 * reads as if someone had checked. See `attribution` in src/usage.ts.
 */
function InferredTag() {
  return (
    <span data-tip="Placed by inference: this agent's log records no working directory, so Baton attributed the session from the file paths it touched. The task is a deduction — the sessions and turns are real."
      style={{
        fontSize: "var(--text-micro)", fontWeight: 700, letterSpacing: "var(--ls-caps)", textTransform: "uppercase",
        color: "var(--text-quaternary)", border: "1px dashed var(--border-default)", borderRadius: 99,
        padding: "0 5px", whiteSpace: "nowrap",
      }}>inferred</span>
  );
}

/** The word "partial", AT the number it qualifies — not in a footnote nobody reads. */
function PartialTag({ tip }: { tip: string }) {
  return (
    <span data-tip={tip} style={{
      fontSize: "var(--text-micro)", fontWeight: 700, letterSpacing: "var(--ls-caps)", textTransform: "uppercase",
      color: "var(--dirty-text)", border: "1px solid var(--dirty-border)", borderRadius: 99, padding: "0 5px", whiteSpace: "nowrap",
    }}>partial</span>
  );
}

const NUM: React.CSSProperties = { fontVariantNumeric: "tabular-nums", fontSize: "var(--fs-12)", textAlign: "right", whiteSpace: "nowrap" };

function TokenCell({ n, missing = "not counted", tip }: { n: number | null; missing?: string; tip?: string }) {
  if (n == null) {
    return <span style={NUM}><NotCounted label={missing} tip={tip ?? "This agent's session format does not report this number. Absent, not zero."} /></span>;
  }
  return <span className="mono" style={{ ...NUM, color: "var(--text-secondary)" }} data-tip={`${n.toLocaleString("en-US")} tokens`}>{fmtTokens(n)}</span>;
}

function CostCell({ usd }: { usd: number | null }) {
  if (usd == null) {
    return (
      <span style={NUM}>
        <NotCounted label="no price"
          tip="Baton has no list price for this model, so it reports no cost. A non-Claude model billed at Claude's rates would be fiction." />
      </span>
    );
  }
  return <span className="mono" style={{ ...NUM, color: "var(--text-secondary)" }} data-tip="What these tokens would cost at API list prices — a subscription does not charge this">≈ {fmtUsd(usd)}</span>;
}

/** The per-session tooltip. Names what was NOT reported rather than quietly
 *  printing a zero for it. */
function sessionTip(u: SessionUsage): string {
  const part = (label: string, n: number | null) => `${label} ${n == null ? "not reported" : fmtTokens(n)}`;
  return [
    part("in", u.inputTokens), part("out", u.outputTokens), part("cache-read", u.cacheReadTokens),
    u.estCostUsd == null ? "no price for this model" : `≈ ${fmtUsd(u.estCostUsd)} at API rates`,
    // Which task this session belongs to is itself a claim for some formats.
    ...(u.attribution === "inferred" ? ["task inferred from the paths it touched, not a logged working directory"] : []),
  ].join(" · ");
}

/** One row of the spend grid: either a measured rollup, or a stated gap. */
interface SpendRow {
  id: string;
  totals: UsageTotals | null;
  /** Why there is no rollup. Rendered instead of numbers, never as zeros. */
  gap: string | null;
  gapTip?: string;
}

const SPEND_COLS = "minmax(120px, 1.6fr) 62px 62px 76px 76px 84px 88px 92px";

function SpendHeader() {
  return (
    <div style={{
      display: "grid", gridTemplateColumns: SPEND_COLS, gap: 10, alignItems: "center",
      padding: "7px 16px", borderBottom: "1px solid var(--border-subtle)",
      fontSize: "var(--fs-11)", color: "var(--text-quaternary)", textTransform: "uppercase", letterSpacing: "var(--ls-caps)",
    }}>
      <span>Agent</span>
      <span style={{ textAlign: "right" }}>Sess</span>
      <span style={{ textAlign: "right" }}>Turns</span>
      <span style={{ textAlign: "right" }}>Input</span>
      <span style={{ textAlign: "right" }}>Output</span>
      <span style={{ textAlign: "right" }} data-tip="Cache reads — billed at a fraction of input">Cache rd</span>
      <span style={{ textAlign: "right" }}>Total</span>
      <span style={{ textAlign: "right" }}>Est. cost</span>
    </div>
  );
}

function SpendRowView({ row }: { row: SpendRow }) {
  const a = getAgent(row.id as AgentId);
  const cover = row.totals ? coverageOf(row.totals) : "none";
  return (
    <div style={{
      display: "grid", gridTemplateColumns: SPEND_COLS, gap: 10, alignItems: "center",
      padding: "9px 16px", borderBottom: "1px solid var(--border-subtle)", opacity: row.totals ? 1 : 0.75,
    }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <AgentBadge id={a.id} size="sm" showLabel={false} />
        <span style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-medium)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.short}</span>
        {cover === "partial" && (
          <PartialTag tip="Some figures are missing from this agent's logs — the ones shown are real, the blanks were never reported." />
        )}
      </span>

      {row.totals ? (
        <>
          <span className="mono" style={{ ...NUM, color: "var(--text-tertiary)" }}>{row.totals.sessions}</span>
          <span className="mono" style={{ ...NUM, color: "var(--text-tertiary)" }}>{row.totals.turns}</span>
          {cover === "none" ? (
            // Nothing was counted at all. One sentence across the number
            // columns beats four repetitions of "not counted", and it is still
            // AT the numbers rather than in a footnote.
            <span style={{ gridColumn: "4 / -1", fontSize: "var(--fs-11)", color: "var(--text-quaternary)", textAlign: "right", fontStyle: "italic" }}
              data-tip="This session format carries no token accounting at all. The sessions and turns are real; the tokens were never reported, so there is no cost either.">
              no token counts in this format — sessions and turns are real
            </span>
          ) : (
            <>
              <TokenCell n={row.totals.inputTokens} />
              <TokenCell n={row.totals.outputTokens} />
              <TokenCell n={row.totals.cacheReadTokens} />
              <TokenCell n={row.totals.totalTokens} />
              <CostCell usd={row.totals.estCostUsd} />
            </>
          )}
        </>
      ) : (
        // The gap, spelled out where the numbers would have been.
        <span style={{ gridColumn: "2 / -1", fontSize: "var(--fs-11)", color: "var(--text-tertiary)", textAlign: "right" }} data-tip={row.gapTip}>
          {row.gap}
        </span>
      )}
    </div>
  );
}

/**
 * Spend by agent, then by task.
 *
 * `byAgent` only carries agents with at least one parsed session — an agent
 * whose logs could not be read has no row there, by design. Turning that into
 * a visible "not measured" line is this component's job: a silently missing
 * agent is exactly how a total starts looking like it covers the whole hub.
 */
function SpendSection({ usage, boardAgents, demo, failure }: { usage: RepoUsage | null; boardAgents: string[]; demo: boolean; failure: string | null }) {
  /*
   * The read failed, so there is no payload — and every gap row below would be
   * a fabrication. With `usage` null this table used to name each board agent
   * "logs not readable" and tell the reader Baton had looked at that agent's
   * session files and could not parse them; when the request itself was
   * refused or never landed, nobody looked at anything. "Spend by task" told
   * the same kind of lie with "No sessions have been attributed to a task yet."
   *
   * D-009 is the rule being kept: absent, and said as absent — with the reason
   * we actually have rather than the reassuring one we don't.
   */
  if (failure) {
    return (
      <section className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 8 }}>
          <Icon name="zap" size={14} style={{ color: "var(--text-tertiary)" }} />
          <h2 style={{ margin: 0, fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)" }}>Token spend</h2>
        </div>
        <div style={{ padding: "14px 16px", fontSize: "var(--fs-13)", color: "var(--text-tertiary)", textWrap: "pretty" }}>
          Couldn't read token spend — {failure}. Nothing was measured, so nothing is shown: this is not a
          spend of zero, and it says nothing about whether any agent's logs are readable.
        </div>
      </section>
    );
  }
  const byAgent = usage?.byAgent ?? {};
  const measured = Object.keys(byAgent).sort(
    (x, y) => (byAgent[y].totalTokens ?? -1) - (byAgent[x].totalTokens ?? -1) || (x < y ? -1 : 1),
  );

  const rows: SpendRow[] = measured.map((id) => ({ id, totals: byAgent[id], gap: null }));

  // A readable agent that reported nothing: looked, found no sessions. The
  // roster and the path come from the payload — see the note at the top.
  const readable = usage?.readable ?? [];
  for (const { agent: id, readFrom } of readable) {
    if (byAgent[id]) continue;
    rows.push({
      id, totals: null, gap: "no sessions read",
      gapTip: `Baton found no readable sessions for this agent in ${readFrom}. Nothing was measured — this is not a spend of zero.`,
    });
  }

  // An agent working on the board whose logs Baton cannot parse at all. Named,
  // because a total that quietly omits it reads as if it covered everything.
  const readableIds = new Set(readable.map((r) => r.agent));
  const unreadable = boardAgents.filter((id) => !byAgent[id] && !readableIds.has(id)).sort();
  for (const id of unreadable) {
    rows.push({
      id, totals: null, gap: "logs not readable",
      gapTip: "This agent is working in this repo, but Baton cannot read its session logs — whatever it spends is NOT included in the totals above.",
    });
  }

  const totals = usage?.totals;
  const perTask = usage?.byTask ?? [];

  return (
    <>
      <section className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Icon name="zap" size={14} style={{ color: "var(--text-tertiary)" }} />
          <h2 style={{ margin: 0, fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)" }}>Token spend by agent</h2>
          {demo && <span className="tag">demo</span>}
          <span style={{ marginLeft: "auto", fontSize: "var(--fs-11)", color: "var(--text-tertiary)", fontVariantNumeric: "tabular-nums" }}>
            {totals ? `${totals.sessions} session${totals.sessions === 1 ? "" : "s"} parsed` : ""}
          </span>
        </div>
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 720 }}>
            <SpendHeader />
            {rows.map((r) => <SpendRowView key={r.id} row={r} />)}
            {totals && (
              <div style={{ display: "grid", gridTemplateColumns: SPEND_COLS, gap: 10, alignItems: "center", padding: "9px 16px", borderTop: "1px solid var(--border-default)" }}>
                <span style={{ fontSize: "var(--fs-12)", fontWeight: "var(--fw-semibold)" }}>All parsed agents</span>
                <span className="mono" style={{ ...NUM, color: "var(--text-tertiary)" }}>{totals.sessions}</span>
                <span className="mono" style={{ ...NUM, color: "var(--text-tertiary)" }}>{totals.turns}</span>
                <TokenCell n={totals.inputTokens} />
                <TokenCell n={totals.outputTokens} />
                <TokenCell n={totals.cacheReadTokens} />
                <TokenCell n={totals.totalTokens} />
                <CostCell usd={totals.estCostUsd} />
              </div>
            )}
          </div>
        </div>
        <div style={{ padding: "9px 16px", fontSize: "var(--fs-11)", color: "var(--text-quaternary)", textWrap: "pretty" }}>
          Totals cover only the agents listed with numbers. A blank is a measurement nobody took — never a
          spend of zero. Costs are what the logged tokens would cost at API list prices, which a subscription
          does not charge.
        </div>
      </section>

      <section className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 8 }}>
          <Icon name="layers" size={14} style={{ color: "var(--text-tertiary)" }} />
          <h2 style={{ margin: 0, fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)" }}>Spend by task</h2>
          {demo && <span className="tag">demo</span>}
          <span style={{ marginLeft: "auto", fontSize: "var(--fs-11)", color: "var(--text-tertiary)", fontVariantNumeric: "tabular-nums" }}>{perTask.length || ""}</span>
        </div>
        {perTask.length === 0 ? (
          <div style={{ padding: "14px 16px", fontSize: "var(--fs-13)", color: "var(--text-tertiary)" }}>
            No sessions have been attributed to a task yet.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 560 }}>
              {perTask.map((t) => (
                <div key={t.slug ?? "\u0000repo"} style={{
                  display: "grid", gridTemplateColumns: "minmax(140px, 2fr) minmax(90px, 1fr) 62px 92px 92px",
                  gap: 10, alignItems: "center", padding: "9px 16px", borderBottom: "1px solid var(--border-subtle)",
                }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <span className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {t.slug ?? "the repo itself"}
                    </span>
                    {t.inferred && <InferredTag />}
                  </span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    {t.agents.map((id) => (
                      <span key={id} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <AgentBadge id={id as AgentId} size="sm" showLabel={false} />
                        <span style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)" }}>{getAgent(id as AgentId).short}</span>
                      </span>
                    ))}
                  </span>
                  <span className="mono" style={{ ...NUM, color: "var(--text-tertiary)" }}
                    data-tip={`${t.totals.sessions} session${t.totals.sessions === 1 ? "" : "s"} · ${t.totals.turns} turn${t.totals.turns === 1 ? "" : "s"}`}>{t.totals.sessions}</span>
                  {coverageOf(t.totals) === "none"
                    ? <span style={NUM}><NotCounted label="no token data" tip="These sessions' format reports no token counts. Absent, not zero." /></span>
                    : <TokenCell n={t.totals.totalTokens} />}
                  <CostCell usd={t.totals.estCostUsd} />
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </>
  );
}

/*
 * The per-task rollup used to be recomputed here, in a loop that mirrored
 * `addTo` in src/usage.ts line for line. It is served now (`byTask`): that loop
 * is what enforces "a missing measurement is never a 0", and a safety rule with
 * two implementations only holds until they drift — at which point the
 * dashboard would print `0` where the daemon would print `null`.
 */

export function ActivityScreen({
  status, onOpen, onOpenDiff, onHandoff, onLive, agentDetection,
}: {
  status: PollState<StatusRow[]>;
  agentDetection?: Meta["agentDetection"];
  onOpen: (slug: string) => void;
  onOpenDiff: (slug: string) => void;
  onHandoff: (slug: string) => void;
  onLive: (slug: string) => void;
}) {
  const demo = BatonAPI.demo;
  const sessions = status.data || [];
  const active = sessions.filter((s) => s.agent !== null);
  /*
   * Token usage for every agent whose session logs are parseable (30s poll).
   * Enabled in demo too: there it resolves to a fixture inside BatonAPI and
   * still contacts no daemon, which is what lets one set of components render
   * both modes. One source for every token number on this screen — two would
   * eventually disagree with each other in front of the user.
   */
  const usage = usePoll<RepoUsage | null>(() => BatonAPI.getRealUsage(), { interval: 30000 });
  const real = usage.data ?? null;
  // A read that FAILED is not a repo with nothing to report. Only when there is
  // no payload at all: once one has arrived, keeping the last known numbers up
  // beats blanking the table over one missed refresh.
  const usageFailure = usage.error != null && usage.data == null ? failureReason(usage.error) : null;
  const usageBySlug = newestBySlug(real?.sessions ?? []);
  const boardAgents = [...new Set(active.map((s) => s.agent!))];

  const agg = sessions.reduce((a, s) => {
    a.commits += s.ahead; a.files += s.filesChanged; a.ins += s.insertions ?? 0; a.del += s.deletions ?? 0;
    return a;
  }, { commits: 0, files: 0, ins: 0, del: 0 });
  const avgProgress = active.length ? Math.round((active.reduce((n, s) => n + progressEstimate(s.ahead), 0) / active.length) * 100) : 0;

  // Per-agent WORK rollup — commits and files from /api/status, in both modes.
  // Tokens are not here any more: they have one home now, the spend table
  // below, which is the only place that can tell "measured zero" from "never
  // measured".
  const byAgent: Record<string, { n: number; commits: number; files: number }> = {};
  active.forEach((s) => {
    const a = byAgent[s.agent!] || { n: 0, commits: 0, files: 0 };
    a.n++; a.commits += s.ahead; a.files += s.filesChanged;
    byAgent[s.agent!] = a;
  });
  // Registry rows first, then custom-agent ids — `agg` above already counts
  // their commits and files, so omitting their rows would break the table's
  // arithmetic against its own totals.
  const inRegistry = new Set<string>(AGENT_REGISTRY.map((a) => a.id!));
  const agentRows = [
    ...AGENT_REGISTRY.map((a) => ({ a, u: byAgent[a.id!] })),
    ...Object.keys(byAgent).filter((id) => !inRegistry.has(id)).sort().map((id) => ({ a: getAgent(id), u: byAgent[id] })),
  ].filter((r) => r.u);
  const maxAgentWork = Math.max(1, ...agentRows.map((r) => r.u.commits + r.u.files));

  const rows = [...active].sort((a, b) => b.ahead - a.ahead || b.filesChanged - a.filesChanged);

  /*
   * The token card counts the agents it could READ, and says how many they
   * were. "Tokens used (Claude)" was the old label and it was honest about its
   * limit; now several agents are parsed, so the count of agents replaces the
   * name — and any figure that was never measured is left out of the sentence
   * rather than shown as a zero.
   */
  const measuredAgents = real ? Object.keys(real.byAgent).length : 0;
  const headline = real ? tokenHeadline(real.totals) : null;
  const cards: { label: string; value: ReactNode; sub: string; icon: IconName; tone?: "accent" | "ready"; preview?: boolean }[] = [
    { label: "Active sessions", value: active.length, sub: `${sessions.length} total worktree${sessions.length === 1 ? "" : "s"}`, icon: "bot", tone: "accent" },
    ...(real && headline && real.totals.sessions > 0
      ? [{
          label: `${headline.label} · ${measuredAgents} agent${measuredAgents === 1 ? "" : "s"}`,
          value: headlineValue(headline.n),
          // "≈ $22846.13 est" reads as a bill. It is not one: this is what the
          // logged tokens would cost at API list prices, which a subscription
          // does not charge — say so. And where there is no cost at all, say
          // THAT, rather than printing $0.00 over a missing measurement.
          sub: `${real.totals.sessions} session${real.totals.sessions === 1 ? "" : "s"} · `
            + (real.totals.cacheReadTokens == null ? "cache-read not reported" : `cache-read ${fmtTokens(real.totals.cacheReadTokens)}`)
            + " · " + costLine(real.totals, real.pricesAsOf),
          icon: "zap" as IconName, tone: "accent" as const,
          preview: demo,
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
              <b style={{ color: "var(--text-primary)", fontWeight: 600 }}>Demo data.</b> The spend tables below are a
              fixture, shaped like a real <span className="mono">/api/usage</span> answer — including the agents it
              cannot measure. Commits &amp; progress are derived from real <span className="mono">/api/status</span> data.
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
                        {c.preview && <span data-tip="Illustrative — not from the API" style={{ fontSize: "var(--text-micro)", fontWeight: 700, letterSpacing: "var(--ls-caps)", textTransform: "uppercase", color: "var(--text-quaternary)", border: "1px dashed var(--border-default)", borderRadius: 99, padding: "1px 5px" }}>est</span>}
                      </span>
                      <span className="stat-label">{c.label}<span style={{ color: "var(--text-quaternary)" }}> · {c.sub}</span></span>
                    </span>
                  </div>
                ))}
              </div>

              {demo ? <DemoSignalsNote /> : <LiveSignalsSection />}
              <ConnectedAgentsSection agentDetection={agentDetection} />

              {/* Where the money went, per agent and per task — the one place on
                  this screen that can tell "measured zero" from "never measured". */}
              <SpendSection usage={real} boardAgents={boardAgents} demo={demo} failure={usageFailure} />

              {/* per-agent WORK counters (commits + files from /api/status) */}
              <section className="card" style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 8 }}>
                  <Icon name="bot" size={14} style={{ color: "var(--text-tertiary)" }} />
                  <h2 style={{ margin: 0, fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)" }}>Per-agent activity</h2>
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
                          <UsageBar inTok={u.commits} outTok={u.files} max={maxAgentWork} color={a.color} tip={`${u.commits} commit${u.commits === 1 ? "" : "s"} · ${u.files} file${u.files === 1 ? "" : "s"} changed`} />
                        </div>
                        <span className="mono" style={{ width: 84, flex: "none", textAlign: "right", fontSize: "var(--fs-12)", color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>{u.commits} commit{u.commits === 1 ? "" : "s"}</span>
                        <span className="mono" style={{ width: 58, flex: "none", textAlign: "right", fontSize: "var(--fs-12)", color: "var(--text-tertiary)", fontVariantNumeric: "tabular-nums" }}>{u.files} files</span>
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
                    // The shape of recent activity is illustrative in demo mode; the
                    // NUMBERS beside it never are — they come from `usage`, or they
                    // are not shown.
                    const spark = demo ? getUsage(s.slug).spark : null;
                    const ru = usageBySlug.get(s.slug);
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
                        <div style={{ flex: "none", width: 110, textAlign: "right" }} className="ar-hide-sm"
                          data-tip={ru ? sessionTip(ru) : undefined}>
                          {ru ? (
                            <>
                              <div className="mono" style={{ fontSize: "var(--fs-13)", color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>
                                {/* No token accounting in this agent's format — say so
                                    where the number would be, rather than printing 0. */}
                                {ru.totalTokens == null
                                  ? <NotCounted label="no token data" tip="This agent's session format reports no token counts. Absent, not zero." />
                                  : fmtTokens(ru.totalTokens)}
                              </div>
                              <div style={{ fontSize: "var(--fs-11)", color: "var(--text-quaternary)" }}>
                                tokens{ru.inputTokens == null || ru.outputTokens == null ? " · partial" : ""}
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="mono" style={{ fontSize: "var(--fs-13)", color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>{s.filesChanged} file{s.filesChanged === 1 ? "" : "s"}</div>
                              <div className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-quaternary)", fontVariantNumeric: "tabular-nums" }}>{s.ahead}↑ {s.behind}↓</div>
                            </>
                          )}
                        </div>
                        {spark && <div style={{ flex: "none" }} className="ar-hide-md"><Sparkline data={spark} color={a.color} /></div>}
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
