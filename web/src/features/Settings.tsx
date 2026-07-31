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
import { BatonAPI } from "../lib/api";
import { fetchMeta, loadConnections, updateConnectionUrl } from "../lib/connections";
import type { Prefs } from "../hooks/usePrefs";
import type { AgentId, FleetDaemon, Meta, RoutingConfig, RoutingInfo, RoutingMode, TierEntry } from "../types";
import { auth } from "../lib/auth";
import { usePoll } from "../hooks/usePoll";
import { fleetOrder, folderName, middleTruncate, uptimeLabel } from "../lib/fleet";

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
    <div style={{ display: "flex", alignItems: "center", gap: 16, padding: "13px 16px", borderBottom: "1px solid var(--border-subtle)" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-medium)" }}>{label}</div>
        {hint && <div style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)", marginTop: 2, textWrap: "pretty" }}>{hint}</div>}
      </div>
      <div style={{ flex: "none" }}>{children}</div>
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
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: "var(--fw-semibold)", letterSpacing: "var(--ls-caps)", textTransform: "uppercase", color: prefs.writeEnabled ? "var(--clean-text)" : "var(--text-tertiary)", background: prefs.writeEnabled ? "var(--clean-soft)" : "var(--bg-surface-2)", border: `1px solid ${prefs.writeEnabled ? "var(--clean-border)" : "var(--border-default)"}`, borderRadius: 99, padding: "2px 7px" }}>
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
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState<string[]>([]);
  const rows = fleetOrder(fleet.data ?? []);
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
        // share a port, and this row is exactly one of them.
        const r = await BatonAPI.stopFleetDaemon(d.port, d.pid);
        setStopping((s) => [...s, `${d.pid}-${d.port}`]);
        showToast(r.outcome === "cleaned"
          ? { kind: "ok", title: "Cleaned up", desc: `${folderName(d.root)} — the daemon was already gone; only its record remained.` }
          : { kind: "ok", title: `Stopped ${folderName(d.root)}`, desc: r.outcome === "signal" ? "Stopped by signal — that daemon predates graceful shutdown." : `Port ${d.port} is free again.` });
      }
      setConfirm(null);
    } catch (e) {
      showToast({ kind: "error", title: "Could not stop it", desc: (e as Error).message });
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
              {live && !d.self && (
                <a className="btn btn-sm btn-ghost fr" href={`http://127.0.0.1:${d.port}`} target="_blank" rel="noreferrer" data-tip="Open that project's dashboard">
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

export function SettingsScreen({ prefs, repo, viewer }: { prefs: Prefs; repo: string | null; viewer?: Meta["viewer"] }) {
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

          <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center", padding: "8px 0 16px", color: "var(--text-quaternary)", fontSize: "var(--fs-12)" }}>
            <BatonMark size={14} /> Baton{repo ? ` · ${repo}` : ""}
          </div>
        </div>
      </div>
    </div>
  );
}
