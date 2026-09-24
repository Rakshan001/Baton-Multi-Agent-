// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — Settings screen (ported from admin.jsx)
   Appearance · Connection · Agent registry
   ============================================================ */
import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "../components/Icon";
import { AgentBadge, SegmentedControl, Switch, ComingSoon, ConfirmDialog } from "../components/primitives";
import { BatonMark } from "../components/BatonMark";
import { ScreenHeader } from "./shared";
import { AGENT_REGISTRY, ACCENTS } from "../lib/registry";
import { showToast } from "../lib/toast";
import { BatonAPI, failureReason } from "../lib/api";
import { fetchMeta, loadConnections, updateConnectionUrl } from "../lib/connections";
import type { Prefs } from "../hooks/usePrefs";
import type { AgentId, FleetDaemon, Meta, MemoryConsolidation, MemoryDelegateSpend, MemoryMechanicalPass, MemoryProducedFact, RoutingConfig, RoutingInfo, RoutingMode, TierEntry } from "../types";
import { auth } from "../lib/auth";
import { usePoll } from "../hooks/usePoll";
import { fleetOrder, folderName, middleTruncate, uptimeLabel } from "../lib/fleet";
import { timeAgo } from "../lib/format";

const MODE_HINTS: Record<RoutingMode, string> = {
  auto: "Rules first, then severity picks a tier automatically.",
  manual: "Suggestions are advisory only — you always pick the agent.",
  single: "Every task routes to one agent.",
};

/** "agent(:model) → agent(:model)" rendering of a tier's fallback chain. */
const chainLabel = (chain: TierEntry[]) => chain.map((e) => (e.model ? `${e.agent}:${e.model}` : e.agent)).join(" → ");

/** Read-only view of baton.config.json routing rules (edit the file to change them). */
function RoutingSettings() {
  const [info, setInfo] = useState<RoutingInfo | null>(null);
  useEffect(() => {
    let on = true;
    BatonAPI.getRouting().then((r) => { if (on) setInfo(r); }).catch(() => undefined);
    return () => { on = false; };
  }, []);
  if (!info) return null;
  const mode: RoutingMode = info.config.mode ?? "auto";
  return (
    <SettingsBlock title="Task routing" desc="Which agent gets a handoff, by task keywords. Used when you pass without --to.">
      {info.errors.length > 0 && (
        <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border-subtle)", background: "var(--conflict-soft)", fontSize: "var(--fs-12)", color: "var(--conflict-text)" }}>
          {info.errors.map((e, i) => <div key={i}>! {e}</div>)}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 16px", borderBottom: "1px solid var(--border-subtle)" }}>
        <span className="mono" style={{ flex: "none", fontSize: 11, fontWeight: "var(--fw-semibold)", textTransform: "uppercase", letterSpacing: "var(--ls-caps)", color: "var(--accent-text)", background: "var(--accent-soft)", border: "1px solid var(--accent-border)", borderRadius: 99, padding: "2px 9px" }}>{mode}</span>
        <span style={{ flex: 1, fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>{MODE_HINTS[mode]}</span>
        {mode === "single" && info.config.single && (
          <span style={{ flex: "none", display: "inline-flex", alignItems: "center", gap: 6 }}>
            <AgentBadge id={info.config.single.agent as AgentId} size="sm" />
            {info.config.single.model && <span className="tag" data-tip="Suggested model for the receiving CLI">{info.config.single.model}</span>}
          </span>
        )}
      </div>
      {info.config.tiers && Object.entries(info.config.tiers).map(([tier, chain]) => (
        <div key={tier} style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 16px", borderBottom: "1px solid var(--border-subtle)" }}>
          <span className="mono" style={{ flex: "none", width: 72, fontSize: 11, color: "var(--text-secondary)" }}>{tier}</span>
          <span className="mono" style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} data-tip="Fallback chain — first available agent wins">{chainLabel(chain)}</span>
        </div>
      ))}
      {info.config.rules.map((r, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 16px", borderBottom: "1px solid var(--border-subtle)" }}>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexWrap: "wrap", gap: 4 }}>
            {r.match.map((kw) => <span key={kw} className="mono" style={{ fontSize: 11, color: "var(--text-secondary)", background: "var(--bg-surface-2)", border: "1px solid var(--border-subtle)", borderRadius: 6, padding: "1px 7px" }}>{kw}</span>)}
          </div>
          <Icon name="arrowRight" size={13} style={{ color: "var(--text-quaternary)", flex: "none" }} />
          <span style={{ flex: "none", display: "inline-flex", alignItems: "center", gap: 6 }}>
            {r.tier
              ? <span className="mono" style={{ fontSize: 11, color: "var(--text-secondary)", background: "var(--bg-surface-2)", border: "1px solid var(--border-subtle)", borderRadius: 6, padding: "1px 7px" }} data-tip="Routes to this tier's fallback chain">tier:{r.tier}</span>
              : <AgentBadge id={r.agent as AgentId} size="sm" />}
            {r.model && <span className="tag" data-tip="Suggested model for the receiving CLI">{r.model}</span>}
          </span>
        </div>
      ))}
      <NoMatchRow config={info.config} mode={mode} />
      <div style={{ padding: "10px 16px", fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>
        {info.path
          ? <>Rules from <span className="mono" style={{ color: "var(--text-secondary)" }}>baton.config.json</span> — edit it in your editor; it's committed and shared with your team.</>
          : <>Built-in defaults — create <span className="mono" style={{ color: "var(--text-secondary)" }}>baton.config.json</span> at the repo root to customize (committed, team-shared).</>}
      </div>
    </SettingsBlock>
  );
}

/**
 * What ACTUALLY happens to a task no rule matches — which is not what this row
 * used to claim. It rendered `config.default` unconditionally ("No keyword match
 * → Cursor"), but suggestRoute only consults `default` in manual mode or when no
 * tier resolves: in auto mode (the default) an unmatched task is scored by
 * severity and routed into a tier, so `baton route "update the readme wording"`
 * answers aider/local while this row promised cursor. `default` is also a TIER
 * name when tiers exist, which AgentBadge would render as a bogus agent.
 */
function NoMatchRow({ config, mode }: { config: RoutingConfig; mode: RoutingMode }) {
  const row = { display: "flex", alignItems: "center", gap: 12, padding: "11px 16px", borderBottom: "1px solid var(--border-subtle)" } as const;
  const label = { flex: 1, fontSize: "var(--fs-12)", color: "var(--text-tertiary)" } as const;
  const token = { fontSize: 11, color: "var(--text-secondary)", background: "var(--bg-surface-2)", border: "1px solid var(--border-subtle)", borderRadius: 6, padding: "1px 7px" } as const;

  // Rules aren't consulted at all in single mode — the mode row above already
  // shows the one agent everything goes to, so there is no fallback to describe.
  if (mode === "single") return null;

  const hasTiers = !!config.tiers && Object.values(config.tiers).some((c) => c?.length);
  if (mode === "auto" && hasTiers) {
    return (
      <div style={row}>
        <span style={label}>No keyword match → scored by severity, routed to the matching tier</span>
        <span className="mono" style={{ ...token, flex: "none" }} data-tip="Task text is scored 0–100; the score picks a tier above, then that tier's chain picks the agent.">severity → tier</span>
      </div>
    );
  }
  // manual mode, or no tiers defined → `default` genuinely is the answer.
  const defaultIsTier = !!config.tiers?.[config.default]?.length;
  return (
    <div style={row}>
      <span style={label}>No keyword match → default</span>
      {defaultIsTier
        ? <span className="mono" style={{ ...token, flex: "none" }} data-tip="Routes to this tier's fallback chain">tier:{config.default}</span>
        : <AgentBadge id={config.default as AgentId} size="sm" />}
    </div>
  );
}

function SettingsBlock({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <section className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ padding: "13px 16px", borderBottom: "1px solid var(--border-subtle)" }}>
        <h2 style={{ margin: 0, fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)" }}>{title}</h2>
        {desc && <p style={{ margin: "2px 0 0", fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>{desc}</p>}
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>{children}</div>
    </section>
  );
}
function SettingRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    /* flexWrap + a 200px basis on the text column: the control is flex:none,
       so without these the label absorbed every pixel of a narrow viewport and
       collapsed into a 52px-wide, 134px-tall ribbon of single words. Now the
       control drops to its own line instead of crushing the text. */
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "var(--gap-md)", padding: "var(--pad-row) var(--pad-card)", borderBottom: "1px solid var(--border-subtle)" }}>
      <div style={{ flex: "1 1 200px", minWidth: 0 }}>
        <div style={{ fontSize: "var(--text-sm)", fontWeight: "var(--fw-medium)" }}>{label}</div>
        {hint && <div style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", marginTop: 2, textWrap: "pretty" }}>{hint}</div>}
      </div>
      <div style={{ flex: "none", marginLeft: "auto" }}>{children}</div>
    </div>
  );
}

function ConnectionSettings({ prefs }: { prefs: Prefs }) {
  const [savedBase, setSavedBase] = useState(BatonAPI.baseUrl);
  const [apiDraft, setApiDraft] = useState(savedBase);
  const [testing, setTesting] = useState(false);
  const online = !prefs.offline;
  const dirty = apiDraft.trim() !== savedBase;
  const sColor = online ? "var(--clean)" : "var(--conflict)";
  const test = async () => {
    setTesting(true);
    try {
      const meta = await fetchMeta({ id: "probe", name: "probe", baseUrl: apiDraft.trim().replace(/\/+$/, "") });
      showToast({ kind: "ok", title: "Connection healthy", desc: `${meta.repo} (${meta.branch})`, mono: true });
    } catch {
      showToast({ kind: "error", title: "Can't reach Baton", desc: `${apiDraft.trim() || "this origin"} — is \`baton serve\` running?` });
    } finally {
      setTesting(false);
    }
  };
  const save = () => {
    const v = apiDraft.trim().replace(/\/+$/, "");
    try {
      const conn = updateConnectionUrl(BatonAPI.connectionId, v);
      BatonAPI.setConnection(conn);
      setSavedBase(conn.baseUrl);
      setApiDraft(conn.baseUrl);
      showToast({ kind: "ok", title: "Endpoint saved", desc: v || "same-origin", mono: true });
    } catch (e) {
      showToast({ kind: "error", title: "Invalid URL", desc: (e as Error).message });
    }
  };
  const gated = [{ icon: "gitMerge" as const, label: "Merge" }, { icon: "trash" as const, label: "Remove" }, { icon: "grip" as const, label: "Drag-to-merge" }];
  const activeName = loadConnections().find((c) => c.id === BatonAPI.connectionId)?.name ?? "This daemon";
  const displayBase = `${activeName} · ${(savedBase || "same-origin").replace(/^https?:\/\//, "")}`;

  return (
    <section className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ padding: "13px 16px", borderBottom: "1px solid var(--border-subtle)" }}>
        <h2 style={{ margin: 0, fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)" }}>Connection</h2>
        <p style={{ margin: "2px 0 0", fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>The local Baton daemon this UI talks to.</p>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 13, padding: "14px 16px", borderBottom: "1px solid var(--border-subtle)", background: online ? "color-mix(in srgb, var(--clean) 6%, transparent)" : "var(--conflict-soft)" }}>
        <span style={{ position: "relative", width: 34, height: 34, borderRadius: 10, flex: "none", display: "grid", placeItems: "center", background: `color-mix(in srgb, ${sColor} 15%, transparent)`, border: `1px solid color-mix(in srgb, ${sColor} 36%, transparent)`, color: sColor }}>
          <Icon name={online ? "link" : "wifiOff"} size={17} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ width: 7, height: 7, borderRadius: 99, background: sColor, animation: online ? "pulse-dot 2s var(--ease-in-out) infinite" : "none" }} />
            <span style={{ fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)", color: online ? "var(--clean-text)" : "var(--conflict-text)" }}>{online ? "Connected" : "Offline"}</span>
          </div>
          <div className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayBase}</div>
        </div>
        <button className="btn btn-sm fr" onClick={test} disabled={testing} style={{ flex: "none" }}>
          <Icon name="refresh" size={13} style={{ animation: testing ? "spin 0.8s linear infinite" : "none" }} /> {testing ? "Testing…" : "Test"}
        </button>
      </div>

      <div style={{ padding: "13px 16px", borderBottom: "1px solid var(--border-subtle)", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <span style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-medium)" }}>API endpoint <span style={{ color: "var(--text-quaternary)", fontWeight: 400 }}>· active connection</span></span>
          <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-quaternary)" }}>{activeName}</span>
        </div>
        <div style={{ display: "flex", gap: 7 }}>
          <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, height: 34, padding: "0 11px", background: "var(--bg-input)", border: "1px solid var(--border-default)", borderRadius: "var(--r-sm)" }}>
            <Icon name="terminal" size={14} style={{ color: "var(--text-quaternary)", flex: "none" }} />
            <input value={apiDraft} onChange={(e) => setApiDraft(e.target.value)} aria-label="API endpoint" className="mono" spellCheck={false} placeholder="http://localhost:7077"
              style={{ flex: 1, minWidth: 0, height: "100%", border: "none", background: "transparent", color: "var(--text-primary)", fontSize: "var(--fs-13)", outline: "none" }} />
          </div>
          <button className="btn btn-sm fr" style={{ height: 34 }} disabled={!dirty} onClick={save}>Save</button>
          {dirty && <button className="btn btn-sm btn-ghost fr" style={{ height: 34 }} onClick={() => setApiDraft(savedBase)} aria-label="Reset"><Icon name="x" size={13} /></button>}
        </div>
      </div>

      <div style={{ padding: "13px 16px", borderBottom: "1px solid var(--border-subtle)", display: "flex", flexDirection: "column", gap: 11 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-medium)" }}>Write actions</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: "var(--text-micro)", fontWeight: "var(--fw-semibold)", letterSpacing: "var(--ls-caps)", textTransform: "uppercase", color: prefs.writeEnabled ? "var(--clean-text)" : "var(--text-tertiary)", background: prefs.writeEnabled ? "var(--clean-soft)" : "var(--bg-surface-2)", border: `1px solid ${prefs.writeEnabled ? "var(--clean-border)" : "var(--border-default)"}`, borderRadius: 99, padding: "2px 7px" }}>
                {prefs.writeEnabled ? "Live" : "Read-only"}
              </span>
            </div>
            <div style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)", marginTop: 3, textWrap: "pretty" }}>
              Enables Merge &amp; Remove. These run for real against the daemon — start it with <span className="mono" style={{ color: "var(--text-secondary)" }}>baton serve --write</span> to allow them server-side.
            </div>
          </div>
          <Switch checked={prefs.writeEnabled} onChange={prefs.setWriteEnabled} label="Write actions" />
        </div>
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
          {gated.map((g) => (
            <span key={g.label} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "var(--fs-12)", padding: "4px 9px", borderRadius: "var(--r-sm)", background: "var(--bg-surface-2)", border: "1px solid var(--border-subtle)", color: prefs.writeEnabled ? "var(--text-secondary)" : "var(--text-quaternary)" }}>
              <Icon name={prefs.writeEnabled ? "check" : g.icon} size={12} style={{ color: prefs.writeEnabled ? "var(--clean-text)" : "var(--text-quaternary)" }} /> {g.label}
            </span>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "13px 16px", borderBottom: "1px solid var(--border-subtle)" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-medium)" }}>Polling</div>
          <div style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)", marginTop: 2 }}>Paused automatically when the tab is hidden.</div>
        </div>
        <div style={{ display: "flex", gap: 7, flex: "none" }}>
          <span className="chip" data-tip="GET /api/status"><span style={{ width: 6, height: 6, borderRadius: 99, background: "var(--accent)" }} /> status <span className="mono" style={{ color: "var(--text-primary)" }}>2s</span></span>
          <span className="chip" data-tip="GET /api/history"><span style={{ width: 6, height: 6, borderRadius: 99, background: "var(--accent)" }} /> history <span className="mono" style={{ color: "var(--text-primary)" }}>10s</span></span>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "13px 16px", background: "var(--bg-surface-2)" }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-medium)" }}>Simulate offline</span>
            <span className="tag" style={{ color: "var(--text-quaternary)" }}>Diagnostics</span>
          </div>
          <div style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)", marginTop: 2 }}>Force the connection error + onboarding flow.</div>
        </div>
        <Switch checked={prefs.offline} onChange={prefs.setOffline} label="Simulate offline" />
      </div>
    </section>
  );
}


/**
 * Who this browser is to the daemon, and the only way out.
 *
 * A member who signed in over `--host` otherwise has no way to sign out short
 * of clearing site data — and on a shared or borrowed machine that is the
 * difference between a credential that ends with the session and one that does
 * not. Local viewers see the same block saying why they were never asked.
 */
function SessionSettings({ viewer }: { viewer?: Meta["viewer"] }) {
  const [confirm, setConfirm] = useState(false);
  const hasToken = !!BatonAPI.token;
  const remembered = auth.remembered(BatonAPI.baseUrl);
  const local = viewer ? viewer.local : !hasToken;

  return (
    <>
      <SettingsBlock title="Your session" desc="How this browser identifies itself to the daemon.">
        {local ? (
          <SettingRow
            label="Local connection"
            hint="This browser is on the same machine as the daemon, so Baton asks for no credential — the same rule that lets the CLI work without one."
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>
              <Icon name="monitor" size={13} /> No sign-in needed
            </span>
          </SettingRow>
        ) : (
          <SettingRow
            label={`Signed in as ${viewer?.name || "a member"}`}
            hint={
              remembered
                ? "Stored in this browser until you sign out."
                : "Kept for this tab only — closing it signs you out."
            }
          >
            <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>
              {viewer?.memberId}
              {viewer?.role === "owner" && (
                <span style={{ padding: "1px 6px", borderRadius: 99, background: "var(--accent-soft)", border: "1px solid var(--accent-border)", color: "var(--accent-text)", fontSize: "var(--fs-11)", fontWeight: "var(--fw-semibold)" }}>owner</span>
              )}
            </span>
          </SettingRow>
        )}
        {hasToken && (
          <SettingRow
            label="Sign out"
            hint="Removes the token from this browser. It stays valid on the hub — ask the owner to revoke it if it has leaked."
          >
            <button className="btn btn-sm btn-danger fr" onClick={() => setConfirm(true)}>
              <Icon name="lock" size={13} /> Sign out
            </button>
          </SettingRow>
        )}
      </SettingsBlock>

      <ConfirmDialog
        open={confirm}
        title="Sign out of this hub?"
        /* The honest warning: for most members the pasted token was the only
           copy, and Baton cannot show it again — only the owner can reissue. */
        body="You'll need your member token to sign back in. If you don't still have it, the hub owner has to reissue one from the Team screen."
        confirmLabel="Sign out"
        tone="danger"
        icon="lock"
        onClose={() => setConfirm(false)}
        onConfirm={() => { setConfirm(false); BatonAPI.signOut(); }}
      />
    </>
  );
}

/**
 * Every Baton daemon on this machine — and the button that stops the one you
 * started by mistake. Loopback-only: `getDaemons` returns null for a remote
 * viewer (or an older daemon), and null unmounts the card rather than drawing
 * a panel that can only error. The server is the authority on live vs stale;
 * this card only decides how to draw it — a stale row gets *Clean up*, never
 * Stop, because the pid behind it is one nobody can vouch for.
 */
function DaemonsCard({ writeEnabled }: { writeEnabled: boolean }) {
  const fleet = usePoll<FleetDaemon[] | null>(() => BatonAPI.getDaemons(), { interval: 5000 });
  const [confirm, setConfirm] = useState<FleetDaemon | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState<string[]>([]);
  const rows = fleetOrder(fleet.data ?? []);
  const staleCount = rows.filter((d) => d.status === "stale").length;
  // A "stopping…" row un-greys the moment the poll stops listing it — and if
  // its record SURVIVES a stop attempt (refused/failed), the key must not pin
  // the row at half-opacity with a dead button forever.
  useEffect(() => {
    setStopping((s) => s.filter((k) => (fleet.data ?? []).some((d) => `${d.pid}-${d.port}` === k)));
  }, [fleet.data]);
  if (!fleet.data || rows.length === 0) return null;

  const act = async (d: FleetDaemon) => {
    setBusy(true);
    try {
      if (d.self) {
        await BatonAPI.shutdownSelf();
        // No toast for success: the staleness banner is about to own the
        // screen, and that banner is the honest report.
      } else {
        // pid + port, not port alone — a crash leftover and a live daemon can
        // share a port, and this row is exactly one of them. `expect` carries
        // what this screen SHOWED, so a record that flipped live since the
        // last poll gets a 409 instead of a surprise stop behind a dialog
        // that promised only a file deletion.
        const r = await BatonAPI.stopFleetDaemon(d.port, d.pid, d.status);
        if (r.outcome === "refused-stale") {
          // Nothing was stopped: the daemon went away on its own (or another
          // daemon owns the port now). Saying "stopped" would be a lie.
          showToast({ kind: "ok", title: "Already gone", desc: `${folderName(d.root)} — that daemon was no longer running; nothing needed stopping.` });
        } else {
          setStopping((s) => [...s, `${d.pid}-${d.port}`]);
          showToast(r.outcome === "cleaned"
            ? { kind: "ok", title: "Cleaned up", desc: `${folderName(d.root)} — the daemon was already gone; only its record remained.` }
            : { kind: "ok", title: `Stopped ${folderName(d.root)}`, desc: r.outcome === "signal" ? "Stopped by signal — that daemon predates graceful shutdown." : `Port ${d.port} is free again.` });
        }
      }
      setConfirm(null);
    } catch (e) {
      showToast({ kind: "error", title: "Could not stop it", desc: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const cleanAll = async () => {
    setBusy(true);
    try {
      // The server buries only records whose pid is provably dead, so the
      // count it reports can be smaller than the stale rows on screen — the
      // toast repeats what actually happened, not what the screen promised.
      const r = await BatonAPI.cleanFleet();
      // Grey the rows we asked to remove, same as a per-row clean-up: the
      // poll is up to 5s away, and leaving them at full opacity reads as
      // "nothing happened". The effect above un-greys any that survive.
      if (r.removed > 0) setStopping((s) => [...s, ...rows.filter((d) => d.status === "stale").map((d) => `${d.pid}-${d.port}`)]);
      showToast(r.removed > 0
        ? { kind: "ok", title: "Cleaned up", desc: `${r.removed} stale record${r.removed === 1 ? "" : "s"} removed — the daemons behind them were already gone.` }
        : { kind: "ok", title: "Nothing to clean", desc: "Every remaining record names a process that is still alive." });
      setConfirmAll(false);
    } catch (e) {
      showToast({ kind: "error", title: "Could not clean up", desc: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsBlock title="Daemons on this machine" desc="Every project running `baton serve`, across all folders. Stopping one never touches its code or its git state.">
      {rows.map((d) => {
        const live = d.status === "live";
        const pending = stopping.includes(`${d.pid}-${d.port}`);
        const color = live ? "var(--clean)" : "var(--text-quaternary)";
        return (
          <div key={`${d.pid}-${d.port}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 16px", borderBottom: "1px solid var(--border-subtle)", opacity: pending ? 0.5 : 1 }}>
            <span data-tip={live ? "Verified: the process is alive and answering as this repo" : "Crash leftover — the daemon behind this record is gone"}
              style={{ width: 8, height: 8, borderRadius: 99, flex: "none", background: color, boxShadow: live ? `0 0 0 3px color-mix(in srgb, ${color} 22%, transparent)` : "none" }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <span style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)", whiteSpace: "nowrap" }}>{folderName(d.root)}</span>
                {d.self && <span className="tag" style={{ flex: "none" }}>this dashboard</span>}
                {!live && <span className="tag" style={{ flex: "none", color: "var(--text-tertiary)" }}>stale record</span>}
                {d.host && live && <span className="tag" style={{ flex: "none", color: "var(--warn, #b58900)" }} data-tip="Exposed beyond this machine with --host">shared</span>}
              </div>
              <div className="mono" data-tip={d.root} style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {middleTruncate(d.root, 58)}
              </div>
            </div>
            <span className="mono" style={{ flex: "none", fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}>:{d.port}</span>
            <span style={{ flex: "none", fontSize: "var(--fs-12)", color: "var(--text-tertiary)", width: 74, textAlign: "right" }}>{live ? uptimeLabel(d.startedAt) : "—"}</span>
            <div style={{ flex: "none", display: "flex", gap: 6 }}>
              {/* Icon-only, so it needs a name of its own: the glyph is
                  aria-hidden and a screen reader would otherwise read out the
                  bare URL. `data-tip` is a tooltip, not an accessible name. */}
              {live && !d.self && (
                <a className="btn btn-sm btn-ghost fr" href={`http://127.0.0.1:${d.port}`} target="_blank" rel="noreferrer"
                  aria-label={`Open the ${folderName(d.root)} dashboard on port ${d.port}`} data-tip="Open that project's dashboard">
                  <Icon name="externalLink" size={13} />
                </a>
              )}
              {/* Same contract as every other mutating control: greyed out in
                  read-only mode, never a danger dialog that ends in an error. */}
              <span data-tip={writeEnabled ? undefined : "Read-only — enable Write actions (the daemon needs baton serve --write)"}>
                <button className={`btn btn-sm fr ${live ? "btn-danger" : "btn-ghost"}`} disabled={pending || !writeEnabled} onClick={() => setConfirm(d)}>
                  {live ? "Stop" : "Clean up"}
                </button>
              </span>
            </div>
          </div>
        );
      })}
      {/* One click for a pile of corpses — but only when there IS a pile;
          a single stale row's own button is already one click. */}
      {staleCount > 1 && (
        <div style={{ display: "flex", justifyContent: "flex-end", padding: "9px 16px" }}>
          <span data-tip={writeEnabled ? undefined : "Read-only — enable Write actions (the daemon needs baton serve --write)"}>
            <button className="btn btn-sm btn-ghost fr" disabled={busy || !writeEnabled} onClick={() => setConfirmAll(true)}>
              Clean up all {staleCount} stale records
            </button>
          </span>
        </div>
      )}
      <ConfirmDialog
        open={confirmAll}
        onClose={() => setConfirmAll(false)}
        onConfirm={() => void cleanAll()}
        busy={busy}
        icon="trash"
        title="Clean up all stale records?"
        confirmLabel="Clean up all"
        body={<span>Removes every record whose daemon is provably gone. Only leftover files are deleted — nothing running is touched, and a record whose process turns out to be alive is kept.</span>}
      />
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => { if (confirm) void act(confirm); }}
        busy={busy}
        tone={confirm?.status === "live" ? "danger" : "default"}
        icon={confirm?.status === "live" ? "wifiOff" : "trash"}
        title={confirm?.status !== "live" ? "Clean up stale record?" : confirm?.self ? "Stop this dashboard's daemon?" : `Stop ${confirm ? folderName(confirm.root) : ""}?`}
        confirmLabel={confirm?.status !== "live" ? "Clean up" : confirm?.self ? "Stop it anyway" : "Stop daemon"}
        body={confirm && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)", wordBreak: "break-all" }}>{confirm.root} · port {confirm.port}</span>
            {confirm.status !== "live"
              ? <span>The daemon behind this record is already gone — this only deletes the leftover file.</span>
              : confirm.self
                ? <span><b>This stops the daemon serving the dashboard you are looking at.</b> The screen will go stale until you run <span className="mono">baton serve</span> in that folder again.</span>
                : <span>Agents, worktrees and git state in that project are untouched — only the daemon and its dashboard stop.</span>}
          </div>
        )}
      />
    </SettingsBlock>
  );
}

/** Upstream, used only until the daemon answers with its own. A fork that edits
 *  package.json is offered here instead — see SOURCE_URL in src/version.ts. */
const UPSTREAM_SOURCE = "https://github.com/Rakshan001/Baton-Multi-Agent-";

/**
 * Version, licence, and a link to the source of the build being served.
 *
 * Not an "About" flourish — AGPL-3.0 §13 requires a network-interactive
 * program to offer its users the source of the running version, and the
 * dashboard is exactly that. The URL comes from the daemon rather than this
 * bundle so that a modified deployment points at its own code; the constant
 * above is only the fallback for a daemon too old to send one.
 */
function AboutSettings({ meta }: { meta?: Meta | null }) {
  const source = meta?.source || UPSTREAM_SOURCE;

  return (
    <SettingsBlock title="About Baton" desc="What this daemon is running, and where its source lives.">
      <SettingRow label="Version" hint="The daemon serving this dashboard.">
        <span className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}>
          {meta?.version ? `v${meta.version}` : "—"}
        </span>
      </SettingRow>
      <SettingRow
        label="License"
        hint="Free to use, change, and run commercially. If you distribute Baton or host a modified version for others, they get the source under the same terms."
      >
        <a className="mono fr" href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener noreferrer"
          style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}>
          {meta?.license || "AGPL-3.0-or-later"}
        </a>
      </SettingRow>
      <SettingRow label="Source code" hint="The complete source of this build, as the license requires it be offered to you.">
        <a className="btn btn-sm fr" href={source} target="_blank" rel="noopener noreferrer">
          <Icon name="gitBranch" size={13} /> Get the source
        </a>
      </SettingRow>
    </SettingsBlock>
  );
}

/* ============================================================
   Memory consolidation — the free pass, and the one that costs money
   ============================================================ */

/** Read-only mode says the same sentence everywhere it appears, for the reason
 *  quarantine.ts gives about copies of a security explanation drifting apart. */
const READ_ONLY_TIP = "Read-only — enable Write actions (the daemon needs baton serve --write)";

/**
 * What the switch is actually asking for. One constant, because this is the
 * sentence the whole feature turns on: someone flipping it is agreeing to let
 * Baton start a coding agent on their account, under their own credentials,
 * spending their tokens, while they are not watching. It belongs AT the switch
 * — a person who has to open the docs to learn what a setting costs has already
 * been charged by the time they find out.
 */
const DELEGATE_CONSENT =
  "Turning this on lets Baton launch a coding agent under your own credentials and spend your tokens — it starts on your account while you are not watching, and you pay for what it uses.";

/** Why it is still safe to point a model at the knowledge base. Enforced in
 *  code (`validateDelegateResponse`), which is the only reason it can be said. */
const DELEGATE_LIMIT =
  "The agent may only merge, supersede and re-anchor facts that already exist. A produced fact that cites nothing, or that introduces a claim no input fact made, is rejected by Baton — not by asking the model nicely. Nothing is ever deleted: the older fact is superseded and kept.";

/** Mechanical consolidation is not a fallback for the switch being off — it is
 *  the default product, and it runs for everyone regardless. */
const MECHANICAL_ALWAYS =
  "Mechanical consolidation still runs. It merges duplicate facts with no model, no agent and no tokens — on idle, and whenever you run `baton memory consolidate`.";

/** A dollar amount, or the same dash the token counts use when nothing was
 *  reported. `$0.000` is reserved for a run that really did cost nothing —
 *  "we were not told" and "it was free" are different facts. */
const usd = (n: number | null | undefined) =>
  typeof n === "number" && Number.isFinite(n) ? (n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`) : "—";
const tokens = (n: number | null) => (typeof n === "number" ? n.toLocaleString() : "—");
/** A counted thing, or the same dash. `lastDelegateRun` validates only `at` and
 *  hands the rest of a ledger line straight through, so a line an older build
 *  wrote arrives with fields simply missing — and `{run.produced}` then put the
 *  word "undefined" where a number goes, beside token counts that were honest
 *  about the same gap. */
const count = (n: number | null | undefined) =>
  typeof n === "number" && Number.isFinite(n) ? n.toLocaleString() : "—";
/** How long it took, or the dash. `(undefined / 1000).toFixed(1)` is the string
 *  "NaN": the screen read "Took NaNs" for a run whose duration nobody wrote
 *  down. Same rule as the cost beside it — an absent measurement is not a
 *  measurement of zero, and it is not a number at all. */
const seconds = (ms: number | null | undefined) =>
  typeof ms === "number" && Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : "—";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A quiet full-width row under a setting — used for the "last pass" receipts
 *  and for the read-only explanation. Never a control. */
function NoteRow({ children, tone = "quiet" }: { children: ReactNode; tone?: "quiet" | "warn" }) {
  return (
    <div style={{
      padding: "10px 16px", borderBottom: "1px solid var(--border-subtle)",
      fontSize: "var(--fs-12)", color: tone === "warn" ? "var(--conflict-text)" : "var(--text-tertiary)",
      background: tone === "warn" ? "var(--conflict-soft)" : "transparent", textWrap: "pretty",
    }}>{children}</div>
  );
}

/** One machine-written fact from the last agent pass.
 *
 *  SECURITY: `fact` was produced by a model out of text other agents wrote, so
 *  it is the least trustworthy string on this screen. It goes through React
 *  children into a <div>, which escapes it — no dangerouslySetInnerHTML, no
 *  markdown renderer, no innerHTML, not now and not when someone adds "just
 *  bold the fact ids". The `machine` badge is beside it for the same reason:
 *  a reader must be able to tell this sentence from one an agent wrote. */
function ProducedFactRow({ f }: { f: MemoryProducedFact }) {
  return (
    <div style={{ padding: "9px 16px", borderBottom: "1px solid var(--border-subtle)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
        <span className="tag" data-tip="Written by a model, not by an agent doing the work">machine</span>
        <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)" }}>{f.id}</span>
        {/* `cites` empty means NOT RECORDED, never "derived from nothing" — a
            fact file carries no cites, so this route serves [] for every fact
            that reached disk. Rendering "from " with nothing after it claimed
            provenance had been shown and then showed none; the same rule the
            token counts follow, applied to attribution. */}
        {f.cites.length > 0 ? (
          <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-quaternary)" }} data-tip="The existing facts this text was derived from">
            from {f.cites.join(", ")}
          </span>
        ) : (
          <span style={{ fontSize: "var(--fs-11)", color: "var(--text-quaternary)", fontStyle: "italic" }}
            data-tip="A saved fact records no citation list, so which facts this was derived from was never written down. Not recorded — not 'derived from nothing'.">
            provenance not recorded
          </span>
        )}
        {/* Who wrote it, when that was recorded. `null` today on every fact, so
            this is silent rather than inventing a byline. */}
        {f.generator && (
          <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-quaternary)" }} data-tip="The agent and model that produced this sentence">
            by {f.generator}
          </span>
        )}
      </div>
      <div style={{ marginTop: 4, fontSize: "var(--fs-12)", color: "var(--text-secondary)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {f.fact}
      </div>
    </div>
  );
}

/** The receipt for the last agent pass: what it changed, and what it cost. */
function DelegateReceipt({ run, runsInWindow, usdInWindow, maxRuns, maxUsd, windowMs }: {
  run: MemoryDelegateSpend; runsInWindow: number; usdInWindow: number; maxRuns: number; maxUsd: number; windowMs: number;
}) {
  const hours = Math.round(windowMs / 3_600_000);
  const cell = { display: "flex", justifyContent: "space-between", gap: 12 } as const;
  return (
    <div style={{ padding: "11px 16px", borderBottom: "1px solid var(--border-subtle)", fontSize: "var(--fs-12)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
        <span style={{ fontWeight: "var(--fw-semibold)", fontSize: "var(--fs-13)" }}>Last agent pass</span>
        <span style={{ color: "var(--text-tertiary)" }}>{timeAgo(run.at)}</span>
        {!run.ok && <span className="tag" style={{ color: "var(--conflict-text)" }}>failed</span>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "4px 20px", color: "var(--text-tertiary)" }}>
        <span style={cell}>Agent<span className="mono" style={{ color: "var(--text-secondary)" }}>{run.model ? `${run.agent}:${run.model}` : run.agent}</span></span>
        <span style={cell}>Facts read<span className="mono" style={{ color: "var(--text-secondary)" }}>{count(run.inputFacts)}</span></span>
        <span style={cell} data-tip="Produced facts kept, and produced facts the validator threw away">
          Changed<span className="mono" style={{ color: "var(--text-secondary)" }}>{count(run.produced)} kept · {count(run.rejected)} rejected</span>
        </span>
        <span style={cell}>Tokens<span className="mono" style={{ color: "var(--text-secondary)" }}>{tokens(run.inputTokens)} in · {tokens(run.outputTokens)} out</span></span>
        <span style={cell}>Cost<span className="mono" style={{ color: "var(--text-secondary)" }}>{usd(run.costUsd)}</span></span>
        <span style={cell}>Took<span className="mono" style={{ color: "var(--text-secondary)" }}>{seconds(run.durationMs)}</span></span>
      </div>
      {/* The agent's own error text — rendered as characters, same rule as a
          produced fact: it came out of a process Baton does not control. */}
      {run.error && (
        <div style={{ marginTop: 6, color: "var(--conflict-text)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{run.error}</div>
      )}
      <div style={{ marginTop: 7, color: "var(--text-quaternary)" }}>
        {plural(runsInWindow, "run")} and {usd(usdInWindow)} spent in the last {hours}h — the cap is {maxRuns} and {usd(maxUsd)}.
      </div>
    </div>
  );
}

/** What the free pass did last time. Its cost line is not decoration: it is the
 *  contrast that makes the paid switch below a decision rather than a habit. */
function MechanicalReceipt({ pass }: { pass: MemoryMechanicalPass }) {
  const changed = pass.status === "ran" && pass.superseded.length > 0
    ? `retired ${plural(pass.superseded.length, "duplicate")}`
    : pass.status === "failed" ? "failed" : "nothing to merge";
  return (
    <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border-subtle)", fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>
      <span style={{ color: "var(--text-secondary)" }}>Last mechanical pass</span> · {pass.at ? timeAgo(pass.at) : "not yet run"} · {changed}
      {pass.contradictions.length > 0 && <> · {plural(pass.contradictions.length, "contradiction")} left for you to read</>}
      {" · "}<span data-tip="No model was involved, so there is nothing to charge">no tokens, no cost</span>
      {pass.error && <div style={{ marginTop: 4, color: "var(--conflict-text)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{pass.error}</div>}
    </div>
  );
}

/**
 * The switch, and the honest label on it.
 *
 * Three things this card must never do, each of which it got wrong in an
 * earlier draft of the same idea: hide the price behind a link; grey the switch
 * out in read-only mode without saying why; or imply that turning the switch
 * off stops memory maintenance. Mechanical consolidation runs either way, and
 * a user who concludes otherwise turns it back on to buy something they were
 * already getting free.
 */
function MemoryConsolidationCard({ writeEnabled }: { writeEnabled: boolean }) {
  // undefined = still loading · null = this daemon does not report it (404)
  const [state, setState] = useState<MemoryConsolidation | null | undefined>(undefined);
  // Why the read failed, when it failed for any reason OTHER than a 404. Kept
  // apart from `state` on purpose: folding it back into null would re-collapse
  // the distinction the API layer now draws, and this card would go back to
  // blaming an old daemon for a refused token.
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let on = true;
    BatonAPI.getMemoryConsolidation()
      .then((s) => { if (on) { setState(s); setFailure(null); } })
      .catch((e) => { if (on) setFailure(failureReason(e)); });
    return () => { on = false; };
  }, []);

  // The read failed for a reason that is NOT "no such endpoint". Name the
  // reason we actually have, and claim nothing about the setting itself, which
  // is exactly what we could not read. Checked before the loading branch
  // because a failure leaves `state` undefined.
  if (failure) {
    return (
      <SettingsBlock title="Memory consolidation" desc="Merging duplicate facts in your shared memory.">
        <NoteRow tone="warn">
          Couldn't read consolidation status — {failure}. Whether agent-assisted consolidation is on is
          unknown from here, and nothing about it has been changed.
        </NoteRow>
      </SettingsBlock>
    );
  }

  if (state === undefined) return null;

  // An older daemon serves no consolidation endpoint (404, and only 404). Say
  // that, and say what still happens — a card that vanished would read as
  // "this feature is gone".
  if (state === null) {
    return (
      <SettingsBlock title="Memory consolidation" desc="Merging duplicate facts in your shared memory.">
        <NoteRow>
          This daemon doesn't report consolidation yet, so the agent-assisted setting can't be changed from here.{" "}
          {MECHANICAL_ALWAYS}
        </NoteRow>
      </SettingsBlock>
    );
  }

  const { config, lastRun, produced, runsInWindow, usdInWindow, noPassReason } = state.delegate;
  const on = config.enabled;

  const toggle = async (next: boolean) => {
    // Guarded as well as visually disabled: the switch is a focusable button,
    // and a keyboard press must not reach a daemon that will refuse it.
    if (!writeEnabled || busy) return;
    setBusy(true);
    try {
      setState(await BatonAPI.setMemoryDelegateEnabled(next));
      showToast(next
        ? { kind: "ok", title: "Agent-assisted consolidation on", desc: `Baton may now launch your own agent, on your credentials, up to ${config.maxRunsPerDay}× and ${usd(config.maxUsdPerDay)} a day.` }
        : { kind: "ok", title: "Agent-assisted consolidation off", desc: "No agent will be launched. The free mechanical pass keeps running." });
    } catch (e) {
      showToast({ kind: "error", title: "Could not change the setting", desc: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsBlock
      title="Memory consolidation"
      desc="Merging duplicate facts in your shared memory. Nothing is ever deleted — the older fact is superseded and kept."
    >
      <SettingRow
        label="Mechanical consolidation"
        hint="Zero-LLM, free, and always on: it merges duplicate facts by fingerprint and reports contradictions for a person. Runs when the machine is idle, or on demand with `baton memory consolidate`."
      >
        <span className="tag" data-tip="Not a setting — this pass has no cost to opt out of">Always on</span>
      </SettingRow>
      {state.mechanical && <MechanicalReceipt pass={state.mechanical} />}

      <SettingRow
        label="Agent-assisted consolidation — spends your tokens"
        hint={`${DELEGATE_CONSENT} Capped at ${config.maxRunsPerDay} runs and ${usd(config.maxUsdPerDay)} a day, ${config.maxFactsPerJob} facts per job. Off by default.`}
      >
        {/* Disabled AND explained: the wrapper stops the pointer, `toggle`
            stops the keyboard, the tooltip names the reason, and the row
            below spells out how to change it. Greying it out on its own
            would leave the user guessing which of the two it was. */}
        <span data-tip={writeEnabled ? undefined : READ_ONLY_TIP} style={{ display: "inline-flex", opacity: writeEnabled ? 1 : 0.45, pointerEvents: writeEnabled ? "auto" : "none" }}>
          <Switch checked={on} onChange={(v) => void toggle(v)} label="Agent-assisted consolidation — launches a coding agent on your account and spends your tokens" />
        </span>
      </SettingRow>

      {!writeEnabled && (
        <NoteRow tone="warn">
          Read-only — this daemon is running without <span className="mono">--write</span>, so Baton won't turn a paid
          setting on from a dashboard that can't be trusted to write anything else. Restart it with{" "}
          <span className="mono">baton serve --write</span> to change this. {MECHANICAL_ALWAYS}
        </NoteRow>
      )}

      {/* The reassurance a switched-off toggle owes the user, and the limit a
          switched-on one owes them. */}
      <NoteRow>{on ? DELEGATE_LIMIT : MECHANICAL_ALWAYS}</NoteRow>

      {/* Why `produced` cannot have come from an agent pass — the daemon's own
          sentence, verbatim. Non-null on every real reply today, because no
          launcher is wired. Without it an empty list below reads as "a pass ran
          and merged nothing", and the toast on flipping the switch promises a
          launch that cannot happen. The demo sends null here, so the showcase
          still shows the screen a working pass would fill. */}
      {noPassReason && <NoteRow tone="warn">{noPassReason}</NoteRow>}

      {lastRun && (
        <DelegateReceipt
          run={lastRun}
          runsInWindow={runsInWindow}
          usdInWindow={usdInWindow}
          maxRuns={config.maxRunsPerDay}
          maxUsd={config.maxUsdPerDay}
          windowMs={config.windowMs}
        />
      )}
      {lastRun && produced.length > 0 && produced.map((f) => <ProducedFactRow key={f.id} f={f} />)}
      {!lastRun && (
        <NoteRow>No agent pass has ever run on this repo — nothing has been spent.</NoteRow>
      )}
    </SettingsBlock>
  );
}

export function SettingsScreen({ prefs, repo, viewer, meta }: { prefs: Prefs; repo: string | null; viewer?: Meta["viewer"]; meta?: Meta | null }) {
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <ScreenHeader title="Settings" subtitle="Appearance, connection, and the agent registry" />
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 20 }}>
        <div style={{ maxWidth: 640, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
          <SettingsBlock title="Appearance">
            <SettingRow label="Theme" hint="Dark is the default. System follows your OS.">
              <SegmentedControl size="sm" ariaLabel="Theme" value={prefs.theme} onChange={prefs.setTheme}
                options={[{ value: "system", label: "System", icon: "monitor" }, { value: "light", label: "Light", icon: "sun" }, { value: "dark", label: "Dark", icon: "moon" }]} />
            </SettingRow>
            <SettingRow label="Accent" hint="Used for focus rings, primary actions, and active nav.">
              <div style={{ display: "flex", gap: 7 }}>
                {ACCENTS.map((ac) => {
                  const on = prefs.accent === ac.id;
                  return (
                    <button key={ac.id} className="fr" aria-label={ac.label} aria-pressed={on} onClick={() => prefs.setAccent(ac.id)} data-tip={ac.label}
                      style={{ width: 26, height: 26, borderRadius: 99, cursor: "pointer", background: `hsl(${ac.h}, ${ac.s}, ${ac.l})`, border: "2px solid", borderColor: on ? "var(--text-primary)" : "transparent", boxShadow: on ? "0 0 0 2px var(--bg-surface)" : "none", padding: 0 }} />
                  );
                })}
              </div>
            </SettingRow>
            <SettingRow label="Reduce motion" hint="Minimize animations and transitions across the app.">
              <Switch checked={prefs.motion === "reduce"} onChange={(v) => prefs.setMotion(v ? "reduce" : "full")} label="Reduce motion" />
            </SettingRow>
          </SettingsBlock>

          <ConnectionSettings prefs={prefs} />

          {/* Loopback-only twice over: the endpoint refuses a remote viewer,
              and a viewer the daemon has TOLD us is remote never mounts the
              card at all. Demo mode shows the fixture fleet — the showcase
              includes the stale-record path, because Clean up is half the
              feature. */}
          {(BatonAPI.demo || viewer?.local !== false) && <DaemonsCard writeEnabled={prefs.writeEnabled} />}

          <SessionSettings viewer={viewer} />

          <RoutingSettings />

          <MemoryConsolidationCard writeEnabled={prefs.writeEnabled} />

          <SettingsBlock title="Agent registry" desc="Color, label, and glyph for each agent. Drives badges across the app.">
            {AGENT_REGISTRY.map((a) => (
              <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 16px", borderBottom: "1px solid var(--border-subtle)" }}>
                <AgentBadge id={a.id} size="sm" showLabel={false} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-medium)" }}>{a.label}</div>
                  <div className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)" }}>{a.id}</div>
                </div>
                <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}>
                  <span style={{ width: 14, height: 14, borderRadius: 4, background: a.color }} /> {a.color}
                </span>
              </div>
            ))}
            <div style={{ padding: "11px 16px" }}>
              <button className="btn btn-sm fr" disabled style={{ opacity: 0.7 }} data-tip="Editing the registry from the UI is planned."><Icon name="plus" size={13} /> Customize registry <ComingSoon /></button>
            </div>
          </SettingsBlock>

          <AboutSettings meta={meta} />

          <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center", padding: "8px 0 16px", color: "var(--text-quaternary)", fontSize: "var(--fs-12)" }}>
            <BatonMark size={14} /> Baton{repo ? ` · ${repo}` : ""}
          </div>
        </div>
      </div>
    </div>
  );
}
