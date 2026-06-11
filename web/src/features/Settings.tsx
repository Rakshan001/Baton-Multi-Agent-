/* ============================================================
   BATON — Settings screen (ported from admin.jsx)
   Appearance · Connection · Agent registry
   ============================================================ */
import { useState, type ReactNode } from "react";
import { Icon } from "../components/Icon";
import { AgentBadge, SegmentedControl, Switch, ComingSoon } from "../components/primitives";
import { BatonMark } from "../components/BatonMark";
import { ScreenHeader } from "./shared";
import { AGENT_REGISTRY, ACCENTS } from "../lib/registry";
import { showToast } from "../lib/toast";
import { BatonAPI } from "../lib/api";
import { fetchMeta, loadConnections, updateConnectionUrl } from "../lib/connections";
import type { Prefs } from "../hooks/usePrefs";

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

export function SettingsScreen({ prefs, repo }: { prefs: Prefs; repo: string | null }) {
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
