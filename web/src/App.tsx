/* ============================================================
   BATON — App shell + root (ported from app.jsx)
   TopBar · Sidebar · BottomTabBar · routing · overlays
   ============================================================ */
import { useState, useEffect, useRef } from "react";
import { Icon, type IconName } from "./components/Icon";
import { BatonMark } from "./components/BatonMark";
import { CommandBar } from "./components/CommandBar";
import { ToastViewport } from "./components/Toast";
import { ApiDot, ComingSoon } from "./components/primitives";
import { TweaksPanel } from "./components/TweaksPanel";
import { usePrefs, ls, type Prefs } from "./hooks/usePrefs";
import { useStatus, useHistory, usePoll } from "./hooks/usePoll";
import { useEvents } from "./hooks/useEvents";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { BatonAPI } from "./lib/api";
import { showToast } from "./lib/toast";
import { WORKSPACE } from "./lib/preview";
import {
  addConnection, fetchMeta, loadConnections, projectFromMeta, removeConnection,
  DEFAULT_CONNECTION, type Connection,
} from "./lib/connections";
import type { ScenarioName } from "./lib/demoData";
import { CommandCenter } from "./features/CommandCenter";
import { KnowledgeGraphScreen } from "./features/KnowledgeGraph";
import { ActivityScreen } from "./features/Activity";
import { ConflictsScreen } from "./features/Conflicts";
import { HistoryScreen } from "./features/History";
import { AgentsScreen } from "./features/Agents";
import { SkillsScreen } from "./features/Skills";
import { SettingsScreen } from "./features/Settings";
import { Connect } from "./features/Connect";
import { DetailSheet } from "./features/Detail";
import { DiffViewer } from "./features/Diff";
import { HandoffDialog } from "./features/Handoff";
import { LaunchSession } from "./features/Launch";
import { LiveSession } from "./features/Live";
import { MemoryScreen } from "./features/Memory";
import type { Meta, AgentId, Project, AgentRosterEntry } from "./types";

interface NavItem { id: string; label: string; icon: IconName }
const NAV: NavItem[] = [
  { id: "home", label: "Command Center", icon: "grid" },
  { id: "activity", label: "Activity", icon: "zap" },
  { id: "conflicts", label: "Conflicts", icon: "alertTriangle" },
  { id: "graph", label: "Knowledge Graph", icon: "network" },
  { id: "memory", label: "Memory", icon: "sparkle" },
  { id: "history", label: "History", icon: "history" },
  { id: "agents", label: "Agents", icon: "bot" },
  { id: "skills", label: "Skills", icon: "command" },
  { id: "settings", label: "Settings", icon: "settings" },
];

interface Counts { active: number; total: number; conflicts: number }

type ProbeState = Record<string, Meta | "loading" | "offline">;

function ProjectSwitcher({ project, onProject, demo, connections, onConnectionsChange }: {
  project: Project; onProject: (id: string) => void; demo: boolean;
  connections: Connection[]; onConnectionsChange: (next: Connection[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [probes, setProbes] = useState<ProbeState>({});
  const [adding, setAdding] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftUrl, setDraftUrl] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const ws = WORKSPACE;
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc); document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  // Real mode: probe every connection's /api/meta when the menu opens.
  useEffect(() => {
    if (!open || demo) return;
    setAdding(false); setAddError(null);
    setProbes(Object.fromEntries(connections.map((c) => [c.id, "loading" as const])));
    for (const c of connections) {
      fetchMeta(c)
        .then((meta) => setProbes((p) => ({ ...p, [c.id]: meta })))
        .catch(() => setProbes((p) => ({ ...p, [c.id]: "offline" })));
    }
  }, [open, demo, connections]);

  const submitAdd = async (force = false) => {
    setAddError(null);
    let conn: { name: string; baseUrl: string };
    try {
      conn = { name: draftName, baseUrl: draftUrl };
      if (!force) await fetchMeta({ id: "probe", name: draftName, baseUrl: draftUrl.trim().replace(/\/+$/, "") });
    } catch {
      setAddError(`Could not reach ${draftUrl}/api/meta — is \`baton serve\` running there?`);
      return;
    }
    try {
      const added = addConnection(conn);
      onConnectionsChange(loadConnections());
      setAdding(false); setDraftName(""); setDraftUrl("");
      showToast({ kind: "ok", title: `Added ${added.name}`, desc: added.baseUrl, mono: true });
    } catch (e) {
      setAddError((e as Error).message);
    }
  };

  const remove = (id: string) => {
    removeConnection(id);
    if (project.id === id) onProject("default");
    onConnectionsChange(loadConnections());
  };

  const rows: Array<{ id: string; name: string; sub: string; color: string; live?: boolean; offline?: boolean; removable?: boolean }> = demo
    ? ws.projects.map((p) => ({ id: p.id, name: p.name, sub: p.framework, color: p.color, live: !!p.primary }))
    : connections.map((c) => {
        const probe = probes[c.id];
        const meta = typeof probe === "object" ? probe : null;
        const proj = projectFromMeta(c, meta);
        return {
          id: c.id, name: proj.name, color: proj.color,
          sub: probe === "loading" ? "checking…" : meta ? `${meta.branch} · ${meta.repo}` : "unreachable",
          offline: probe === "offline", removable: c.id !== "default",
        };
      });

  return (
    <div style={{ position: "relative" }} ref={ref}>
      <button className="fr" onClick={() => setOpen((o) => !o)} aria-haspopup="true" aria-expanded={open} data-tip={project.path} data-tip-side="bottom" style={{
        display: "inline-flex", alignItems: "center", gap: 8, height: 32, padding: "0 8px 0 10px", borderRadius: "var(--r-sm)",
        background: open ? "var(--bg-active)" : "var(--bg-surface-2)", border: "1px solid var(--border-subtle)", cursor: "pointer", color: "var(--text-primary)", fontFamily: "inherit" }}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--border-default)")}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border-subtle)")}>
        <span style={{ width: 14, height: 14, borderRadius: 4, background: project.color, flex: "none", display: "grid", placeItems: "center", color: "#fff", fontSize: 9, fontWeight: 800 }}>{project.name[0]?.toUpperCase()}</span>
        <span style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)" }}>{project.name}</span>
        <span style={{ color: "var(--text-quaternary)" }}>/</span>
        <span className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}>{project.branch}</span>
        <Icon name="chevronDown" size={13} style={{ color: "var(--text-tertiary)", transform: open ? "rotate(180deg)" : "none", transition: "transform var(--dur-1)" }} />
      </button>
      {open && (
        <div role="menu" style={{ position: "absolute", top: 38, left: 0, width: 320, background: "var(--bg-elevated)", border: "1px solid var(--border-strong)",
          borderRadius: "var(--r-lg)", boxShadow: "var(--shadow-xl)", padding: 6, zIndex: "var(--z-overlay)" as unknown as number, animation: "scale-in var(--dur-1) var(--ease-out)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 9px 8px" }}>
            <Icon name="folder" size={13} style={{ color: "var(--text-tertiary)" }} />
            <span className="mono" style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{demo ? ws.folder : "daemons"}</span>
            <span className="tag" style={{ marginLeft: "auto" }}>{rows.length} {demo ? "projects" : `connection${rows.length === 1 ? "" : "s"}`}</span>
          </div>
          {rows.map((p) => {
            const on = p.id === project.id;
            return (
              <div key={p.id} style={{ position: "relative" }}
                onMouseEnter={(e) => { const x = e.currentTarget.querySelector<HTMLElement>("[data-rm]"); if (x) x.style.opacity = "1"; }}
                onMouseLeave={(e) => { const x = e.currentTarget.querySelector<HTMLElement>("[data-rm]"); if (x) x.style.opacity = "0"; }}>
                <button role="menuitem" className="fr" onClick={() => { onProject(p.id); setOpen(false); }} style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "8px 9px", borderRadius: "var(--r-sm)", border: "none", cursor: "pointer", textAlign: "left",
                  background: on ? "var(--accent-soft)" : "transparent", opacity: p.offline ? 0.65 : 1 }}
                  onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { if (!on) e.currentTarget.style.background = "transparent"; }}>
                  <span style={{ width: 22, height: 22, borderRadius: 6, background: p.color, flex: "none", display: "grid", placeItems: "center", color: "#fff", fontSize: 11, fontWeight: 800 }}>{p.name[0]?.toUpperCase()}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)", color: on ? "var(--accent-text)" : "var(--text-primary)" }}>{p.name}</span>
                      {p.live && <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "var(--ls-caps)", textTransform: "uppercase", color: "var(--clean-text)", background: "var(--clean-soft)", border: "1px solid var(--clean-border)", borderRadius: 99, padding: "1px 5px" }}>live</span>}
                      {p.offline && <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "var(--ls-caps)", textTransform: "uppercase", color: "var(--conflict-text)", background: "var(--conflict-soft)", border: "1px solid var(--conflict-border)", borderRadius: 99, padding: "1px 5px" }}>unreachable</span>}
                    </div>
                    <div className="mono" style={{ fontSize: 10.5, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.sub}</div>
                  </div>
                  {on && <Icon name="check" size={15} style={{ color: "var(--accent)", flex: "none" }} />}
                </button>
                {p.removable && (
                  <button data-rm className="fr" aria-label={`Remove ${p.name}`} onClick={(e) => { e.stopPropagation(); remove(p.id); }} style={{
                    position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", opacity: 0, transition: "opacity var(--dur-1)",
                    width: 20, height: 20, display: "grid", placeItems: "center", borderRadius: 5, border: "none", cursor: "pointer",
                    background: "var(--bg-surface-2)", color: "var(--text-tertiary)" }}>
                    <Icon name="x" size={12} />
                  </button>
                )}
              </div>
            );
          })}
          <div style={{ height: 1, background: "var(--border-subtle)", margin: "6px 4px" }} />
          {demo ? (
            <button className="fr" disabled style={{ width: "100%", display: "flex", alignItems: "center", gap: 9, padding: "8px 9px", borderRadius: "var(--r-sm)", border: "none", background: "transparent", color: "var(--text-tertiary)", cursor: "not-allowed", opacity: 0.8, textAlign: "left" }}
              data-tip="Opening another folder from the UI is planned.">
              <span style={{ width: 22, height: 22, borderRadius: 6, display: "grid", placeItems: "center", border: "1px dashed var(--border-default)", flex: "none" }}><Icon name="plus" size={13} /></span>
              <span style={{ flex: 1, fontSize: "var(--fs-13)" }}>Open folder…</span>
              <ComingSoon />
            </button>
          ) : adding ? (
            <div style={{ padding: "8px 9px", display: "flex", flexDirection: "column", gap: 7 }}>
              <input value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="Name (e.g. skfin)" autoFocus
                style={{ height: 30, padding: "0 9px", background: "var(--bg-input)", border: "1px solid var(--border-default)", borderRadius: "var(--r-sm)", color: "var(--text-primary)", fontSize: "var(--fs-13)", outline: "none" }} />
              <input value={draftUrl} onChange={(e) => setDraftUrl(e.target.value)} placeholder="http://localhost:7078" className="mono"
                onKeyDown={(e) => { if (e.key === "Enter") void submitAdd(); }}
                style={{ height: 30, padding: "0 9px", background: "var(--bg-input)", border: "1px solid var(--border-default)", borderRadius: "var(--r-sm)", color: "var(--text-primary)", fontSize: "var(--fs-12)", outline: "none" }} />
              {addError && (
                <div style={{ fontSize: "var(--fs-12)", color: "var(--conflict-text)" }}>
                  {addError} <button className="fr" onClick={() => void submitAdd(true)} style={{ border: "none", background: "none", color: "var(--accent-text)", cursor: "pointer", padding: 0, fontSize: "inherit", textDecoration: "underline" }}>Add anyway</button>
                </div>
              )}
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                <button className="btn fr" style={{ height: 28 }} onClick={() => { setAdding(false); setAddError(null); }}>Cancel</button>
                <button className="btn btn-primary fr" style={{ height: 28 }} disabled={!draftUrl.trim()} onClick={() => void submitAdd()}>Add</button>
              </div>
            </div>
          ) : (
            <button className="fr" onClick={() => setAdding(true)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 9, padding: "8px 9px", borderRadius: "var(--r-sm)", border: "none", background: "transparent", color: "var(--text-secondary)", cursor: "pointer", textAlign: "left" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              data-tip="Run `baton serve -p <port>` in another repo, then add its URL here.">
              <span style={{ width: 22, height: 22, borderRadius: 6, display: "grid", placeItems: "center", border: "1px dashed var(--border-default)", flex: "none" }}><Icon name="plus" size={13} /></span>
              <span style={{ flex: 1, fontSize: "var(--fs-13)" }}>Add connection…</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function StatStrip({ counts, navigate }: { counts: Counts; navigate: (id: string) => void }) {
  const seg = (label: string, value: number, dot: string, opts: { onClick?: () => void; tip?: string; danger?: boolean; glow?: boolean } = {}) => {
    const Comp: any = opts.onClick ? "button" : "div";
    return (
      <Comp className={opts.onClick ? "fr" : ""} onClick={opts.onClick} data-tip={opts.tip} style={{
        display: "inline-flex", alignItems: "center", gap: 7, height: "100%", padding: "0 12px", border: "none",
        background: "transparent", cursor: opts.onClick ? "pointer" : "default", fontFamily: "inherit",
        borderRadius: opts.onClick ? "var(--r-sm)" : 0, transition: "background var(--dur-1)" }}
        onMouseEnter={opts.onClick ? (e: React.MouseEvent<HTMLElement>) => (e.currentTarget.style.background = "var(--bg-hover)") : undefined}
        onMouseLeave={opts.onClick ? (e: React.MouseEvent<HTMLElement>) => (e.currentTarget.style.background = "transparent") : undefined}>
        <span style={{ width: 7, height: 7, borderRadius: 99, background: dot, flex: "none", boxShadow: opts.glow ? `0 0 0 3px color-mix(in srgb, ${dot} 22%, transparent)` : "none" }} />
        <span className="mono" style={{ fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)", letterSpacing: "-0.02em", color: opts.danger ? "var(--conflict-text)" : "var(--text-primary)" }}>{value}</span>
        <span style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>{label}</span>
      </Comp>
    );
  };
  return (
    <div role="group" aria-label="Live counters" style={{ display: "flex", alignItems: "center", height: 32, background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: "var(--r-md)", padding: 2 }}>
      {seg("Active", counts.active, "var(--accent)", { tip: "Sessions with an agent attached", glow: counts.active > 0 })}
      <span style={{ width: 1, height: 16, background: "var(--border-subtle)" }} />
      {seg("Tasks", counts.total, "var(--idle)", { tip: "Total sessions" })}
      <span style={{ width: 1, height: 16, background: "var(--border-subtle)" }} />
      {seg("Conflicts", counts.conflicts, counts.conflicts ? "var(--conflict)" : "var(--idle)", { danger: counts.conflicts > 0, glow: counts.conflicts > 0, onClick: () => navigate("conflicts"), tip: "View conflicts" })}
    </div>
  );
}

function TopBar({ counts, apiState, lastUpdated, onRefresh, onMenu, onSearch, onLaunch, navigate, prefs, route, project, onProject, demo, live, reconnecting, connections, onConnectionsChange }: {
  counts: Counts; apiState: "online" | "fetching" | "offline"; lastUpdated: number | null;
  onRefresh: () => void; onMenu: () => void; onSearch: () => void; onLaunch: (agent: AgentId | null) => void;
  navigate: (id: string) => void; prefs: Prefs; route: string; project: Project; onProject: (id: string) => void; demo: boolean; live: boolean; reconnecting: boolean;
  connections: Connection[]; onConnectionsChange: (next: Connection[]) => void;
}) {
  const isMobile = useMediaQuery("(max-width: 860px)");
  const isNarrow = useMediaQuery("(max-width: 1080px)");
  const navLabel = NAV.find((n) => n.id === route)?.label;
  return (
    <header style={{ height: 54, flex: "none", display: "flex", alignItems: "center", gap: 10, padding: "0 12px 0 14px", borderBottom: "1px solid var(--border-subtle)", background: "var(--bg-surface)", zIndex: "var(--z-sticky)" as unknown as number }}>
      {isMobile && <button className="btn btn-ghost btn-icon fr" onClick={onMenu} aria-label="Menu"><Icon name="list" size={18} /></button>}
      <BatonMark size={24} withWord={!isMobile} />
      {!isMobile && <ProjectSwitcher project={project} onProject={onProject} demo={demo} connections={connections} onConnectionsChange={onConnectionsChange} />}
      {!isMobile && <span className="vdivider" style={{ height: 24, margin: "0 2px" }} />}
      {!isMobile && <StatStrip counts={counts} navigate={navigate} />}
      {isMobile && navLabel && <span style={{ fontSize: "var(--fs-15)", fontWeight: "var(--fw-semibold)", marginLeft: 2, letterSpacing: "var(--ls-snug)" }}>{navLabel}</span>}
      <div style={{ flex: 1 }} />

      <button className="btn btn-primary fr" onClick={() => onLaunch(null)} data-tip={isMobile ? "Launch session" : undefined} aria-label="Launch session" style={{ height: 32, padding: isMobile ? 0 : "0 12px 0 10px", width: isMobile ? 32 : "auto", flex: "none" }}>
        <Icon name="plus" size={15} />{!isMobile && <span>New session</span>}
      </button>

      <button className="fr" onClick={onSearch} aria-label="Search (Command K)" style={{
        display: "flex", alignItems: "center", gap: 8, height: 32, padding: "0 8px 0 11px", width: isMobile ? 32 : isNarrow ? 36 : 200, justifyContent: isMobile || isNarrow ? "center" : "flex-start",
        background: "var(--bg-input)", border: "1px solid var(--border-default)", borderRadius: "var(--r-sm)", cursor: "pointer", color: "var(--text-tertiary)", flex: "none" }}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--border-strong)")}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border-default)")}>
        <Icon name="search" size={15} />
        {!isMobile && !isNarrow && <><span style={{ fontSize: "var(--fs-13)", flex: 1, textAlign: "left" }}>Search…</span><span className="kbd">⌘K</span></>}
      </button>

      {demo && !isMobile && (
        <span data-tip="Showing illustrative data — the daemon isn't being queried. Turn off in Tweaks." data-tip-side="bottom" style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 32, padding: "0 10px", borderRadius: "var(--r-sm)", background: "var(--bg-surface-2)", border: "1px dashed var(--border-default)", color: "var(--text-tertiary)", fontSize: "var(--fs-12)", fontWeight: "var(--fw-semibold)", flex: "none" }}>
          <Icon name="sparkle" size={13} /> Demo data
        </span>
      )}
      {prefs.writeEnabled && !isMobile && (
        <span data-tip="Write actions enabled — Merge, Remove are live" data-tip-side="bottom" style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 32, padding: "0 10px", borderRadius: "var(--r-sm)", background: "var(--clean-soft)", border: "1px solid var(--clean-border)", color: "var(--clean-text)", fontSize: "var(--fs-12)", fontWeight: "var(--fw-semibold)", flex: "none" }}>
          <Icon name="gitMerge" size={13} /> Write
        </span>
      )}
      <ApiDot state={apiState} lastUpdated={lastUpdated} onRefresh={onRefresh} live={live} reconnecting={reconnecting} />
      <ThemeToggle prefs={prefs} />
    </header>
  );
}

function ThemeToggle({ prefs }: { prefs: Prefs }) {
  const next = prefs.resolvedTheme === "dark" ? "light" : "dark";
  return (
    <button className="btn btn-ghost btn-icon fr" onClick={() => prefs.setTheme(next)} aria-label={`Switch to ${next} theme`} data-tip={`Switch to ${next}`} data-tip-side="bottom">
      <Icon name={prefs.resolvedTheme === "dark" ? "sun" : "moon"} size={17} />
    </button>
  );
}

function Sidebar({ route, navigate, counts, project }: { route: string; navigate: (id: string) => void; counts: Counts; project: Project }) {
  return (
    <nav aria-label="Primary" style={{ width: 216, flex: "none", borderRight: "1px solid var(--border-subtle)", background: "var(--bg-surface)", display: "flex", flexDirection: "column", padding: 10, gap: 2 }}>
      {NAV.map((n) => {
        const active = route === n.id;
        const badge = n.id === "conflicts" && counts.conflicts > 0 ? counts.conflicts : null;
        return (
          <button key={n.id} className="fr" onClick={() => navigate(n.id)} aria-current={active ? "page" : undefined} style={{ display: "flex", alignItems: "center", gap: 11, height: 38, padding: "0 11px", borderRadius: "var(--r-sm)", border: "none", cursor: "pointer", textAlign: "left", width: "100%", position: "relative", background: active ? "var(--accent-soft)" : "transparent", color: active ? "var(--accent-text)" : "var(--text-secondary)", fontSize: "var(--fs-13)", fontWeight: "var(--fw-medium)", fontFamily: "inherit", transition: "background var(--dur-1), color var(--dur-1)" }}
            onMouseEnter={(e) => { if (!active) { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text-primary)"; } }}
            onMouseLeave={(e) => { if (!active) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-secondary)"; } }}>
            {active && <span style={{ position: "absolute", left: -10, top: 9, bottom: 9, width: 3, borderRadius: 99, background: "var(--accent)" }} />}
            <Icon name={n.icon} size={17} style={{ flex: "none" }} />
            <span style={{ flex: 1 }}>{n.label}</span>
            {badge && <span style={{ fontSize: 11, fontWeight: "var(--fw-semibold)", color: "var(--conflict-text)", background: "var(--conflict-soft)", border: "1px solid var(--conflict-border)", borderRadius: 99, minWidth: 18, height: 18, display: "grid", placeItems: "center", padding: "0 5px" }}>{badge}</span>}
          </button>
        );
      })}
      <div style={{ flex: 1 }} />
      <div style={{ padding: "10px 9px", borderTop: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 9 }}>
        <span style={{ width: 24, height: 24, borderRadius: 6, background: project.color, flex: "none", display: "grid", placeItems: "center", color: "#fff", fontSize: 11, fontWeight: 800 }}>{project.name[0]}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "var(--fs-12)", fontWeight: "var(--fw-semibold)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{project.name}</div>
          <div className="mono" data-tip={project.path} style={{ fontSize: 10, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{project.path}</div>
        </div>
      </div>
    </nav>
  );
}

function BottomTabBar({ route, navigate, counts }: { route: string; navigate: (id: string) => void; counts: Counts }) {
  return (
    <nav aria-label="Primary" style={{ flex: "none", display: "flex", borderTop: "1px solid var(--border-default)", background: "var(--bg-surface)", paddingBottom: "env(safe-area-inset-bottom)" }}>
      {NAV.map((n) => {
        const active = route === n.id; const badge = n.id === "conflicts" && counts.conflicts > 0 ? counts.conflicts : null;
        return (
          <button key={n.id} className="fr" onClick={() => navigate(n.id)} aria-current={active ? "page" : undefined} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "9px 0 10px", minHeight: 56, border: "none", background: "transparent", cursor: "pointer", position: "relative", color: active ? "var(--accent-text)" : "var(--text-tertiary)" }}>
            <span style={{ position: "relative" }}>
              <Icon name={n.icon} size={20} />
              {badge && <span style={{ position: "absolute", top: -4, right: -7, fontSize: 9, fontWeight: 700, color: "#fff", background: "var(--conflict-strong)", borderRadius: 99, minWidth: 14, height: 14, display: "grid", placeItems: "center", padding: "0 3px" }}>{badge}</span>}
            </span>
            <span style={{ fontSize: 10, fontWeight: "var(--fw-medium)" }}>{n.label.replace("Command ", "")}</span>
          </button>
        );
      })}
    </nav>
  );
}

function MobileNavDrawer({ open, onClose, route, navigate }: { open: boolean; onClose: () => void; route: string; navigate: (id: string) => void }) {
  if (!open) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: "var(--z-sheet)" as unknown as number }}>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "var(--bg-scrim)", animation: "fade-in var(--dur-2)" }} />
      <div role="dialog" aria-modal="true" aria-label="Navigation" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 260, background: "var(--bg-surface)", borderRight: "1px solid var(--border-strong)", boxShadow: "var(--shadow-xl)", animation: "sheet-in-right var(--dur-3) var(--ease-out)", display: "flex", flexDirection: "column", padding: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 6px 14px" }}><BatonMark size={24} withWord /></div>
        {NAV.map((n) => {
          const active = route === n.id;
          return <button key={n.id} className="fr" onClick={() => { navigate(n.id); onClose(); }} style={{ display: "flex", alignItems: "center", gap: 12, height: 44, padding: "0 12px", borderRadius: "var(--r-sm)", border: "none", cursor: "pointer", width: "100%", textAlign: "left", background: active ? "var(--accent-soft)" : "transparent", color: active ? "var(--accent-text)" : "var(--text-secondary)", fontSize: "var(--fs-14)", fontWeight: "var(--fw-medium)", fontFamily: "inherit" }}>
            <Icon name={n.icon} size={18} /> {n.label}
          </button>;
        })}
      </div>
    </div>
  );
}

export default function App() {
  const prefs = usePrefs();
  const [route, setRoute] = useState<string>(() => ls.get("baton:route", "home"));
  const [selected, setSelected] = useState<string | null>(null);
  const [diffSlug, setDiffSlug] = useState<string | null>(null);
  const [handoffSlug, setHandoffSlug] = useState<string | null>(null);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [launchOpen, setLaunchOpen] = useState<{ agent: AgentId | null } | null>(null);
  const [liveSlug, setLiveSlug] = useState<string | null>(null);
  const [filter, setFilter] = useState<"conflict" | "ready" | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [projectId, setProjectId] = useState(() => BatonAPI.project);
  const [scenario, setScenarioState] = useState<ScenarioName>(() => BatonAPI.scenario);
  const [demo, setDemoState] = useState(() => BatonAPI.demo);
  const setDemo = (v: boolean) => { BatonAPI.setDemo(v); setDemoState(v); };
  const [connections, setConnections] = useState<Connection[]>(loadConnections);
  const [connectionId, setConnectionId] = useState(() => BatonAPI.connectionId);
  const activeConn = connections.find((c) => c.id === connectionId) ?? DEFAULT_CONNECTION;

  const events = useEvents({ enabled: !prefs.offline && !demo, baseUrl: activeConn.baseUrl });
  const status = useStatus(events.live);
  const history = useHistory(events.live);
  const meta = usePoll<Meta>(() => BatonAPI.getMeta(), { interval: 30000, deps: [connectionId] });
  const agents = usePoll<AgentRosterEntry[]>(() => BatonAPI.getAgents(), { interval: 8000, deps: [connectionId] });
  const isMobile = useMediaQuery("(max-width: 860px)");

  // Real mode: the UI's write capability follows the daemon (`baton serve --write`)
  // instead of hiding behind a per-browser toggle. Demo mode keeps pure prefs.
  const daemonWrite = demo ? null : (meta.data ? !!meta.data.writeEnabled : null);
  useEffect(() => {
    prefs.followDaemonWrite(daemonWrite);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daemonWrite]);

  const navigate = (r: string) => { setRoute(r); ls.set("baton:route", r); };
  const onOpen = (slug: string) => setSelected(slug);
  const onLaunch = (agent: AgentId | null) => setLaunchOpen({ agent });
  const onLive = (slug: string) => setLiveSlug(slug);

  const project: Project = demo
    ? (WORKSPACE.projects.find((p) => p.id === projectId) || WORKSPACE.projects[0])
    : projectFromMeta(activeConn, meta.data ?? null);
  const onProject = (id: string) => {
    const clearSelection = () => { setSelected(null); setFilter(null); setDiffSlug(null); setHandoffSlug(null); setLiveSlug(null); setLaunchOpen(null); };
    if (demo) {
      if (id === projectId) return;
      setProjectId(id);
      clearSelection();
      BatonAPI.setProject(id);
      const p = WORKSPACE.projects.find((x) => x.id === id)!;
      showToast({ kind: "info", title: `Switched to ${p.name}`, desc: p.path });
      return;
    }
    if (id === connectionId) return;
    const conn = connections.find((c) => c.id === id);
    if (!conn) return;
    setConnectionId(conn.id);
    clearSelection();
    BatonAPI.setConnection(conn);
    status.refetch(); history.refetch(); meta.refetch();
    showToast({ kind: "info", title: `Switched to ${conn.name}`, desc: conn.baseUrl || "this origin", mono: true });
  };
  const setScenario = (s: ScenarioName) => {
    setScenarioState(s);
    setSelected(null); setFilter(null);
    BatonAPI.setScenario(s);
    const desc: Record<ScenarioName, string> = {
      busy: "Several active agents, live conflicts, work ready to merge.",
      calm: "Mostly clean, one agent working.",
      empty: "No sessions yet.",
      offline: "The daemon is unreachable.",
    };
    showToast({ kind: "info", title: `Scenario: ${s}`, desc: desc[s] });
  };

  // ⌘K
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setCmdOpen((o) => !o); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const sessions = status.data || [];
  const counts: Counts = {
    active: sessions.filter((s) => s.agent !== null).length,
    total: sessions.length,
    conflicts: sessions.filter((s) => s.status === "conflict").length,
  };
  const apiState = prefs.offline || status.error ? "offline" : status.isFetching ? "fetching" : "online";

  // connection phase, derived from the real first status poll
  const firstLoadDone = status.data !== null || status.error !== null;
  const phase: "connecting" | "connected" | "offline" =
    prefs.offline ? "offline" : !firstLoadDone ? "connecting" : status.error && !status.data ? "offline" : "connected";

  // clear the retry spinner once a refetch settles
  useEffect(() => { if (retrying && !status.isFetching) setRetrying(false); }, [retrying, status.isFetching]);
  const retry = () => { setRetrying(true); status.refetch(); history.refetch(); meta.refetch(); };

  if (phase !== "connected") {
    return (
      <div style={{ height: "100%" }}>
        <Connect phase={phase === "connecting" ? "connecting" : "offline"} onRetry={retry} retrying={retrying}
          alternatives={!demo && connections.length > 1 ? connections.filter((c) => c.id !== connectionId) : []}
          onPick={onProject} />
        <TweaksPanel prefs={prefs} scenario={scenario} setScenario={setScenario} demo={demo} setDemo={setDemo} />
        <ToastViewport />
      </div>
    );
  }

  const screen = (() => {
    switch (route) {
      case "activity": return <ActivityScreen status={status} onOpen={onOpen} onOpenDiff={setDiffSlug} onHandoff={setHandoffSlug} onLive={onLive} />;
      case "conflicts": return <ConflictsScreen status={status} onOpen={onOpen} />;
      case "graph": return <KnowledgeGraphScreen writeEnabled={prefs.writeEnabled} />;
      case "memory": return <MemoryScreen writeEnabled={prefs.writeEnabled} />;
      case "history": return <HistoryScreen history={history} onOpen={onOpen} />;
      case "agents": return <AgentsScreen agents={agents} onOpen={onOpen} onLaunch={onLaunch} onHandoff={setHandoffSlug} writeEnabled={prefs.writeEnabled} />;
      case "skills": return <SkillsScreen writeEnabled={prefs.writeEnabled} />;
      case "settings": return <SettingsScreen prefs={prefs} repo={meta.data?.repo ?? null} />;
      default: return <CommandCenter status={status} view={prefs.view} setView={prefs.setView} onOpen={onOpen} writeEnabled={prefs.writeEnabled} filter={filter} setFilter={setFilter} project={project} onNewSession={() => onLaunch(null)} />;
    }
  })();

  const selectedRow = (slug: string | null) => sessions.find((s) => s.slug === slug);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <TopBar counts={counts} apiState={apiState} lastUpdated={status.lastUpdated}
        onRefresh={() => { status.refetch(); history.refetch(); }}
        onMenu={() => setNavOpen(true)} onSearch={() => setCmdOpen(true)} onLaunch={onLaunch} navigate={navigate}
        prefs={prefs} route={route} project={project} onProject={onProject} demo={demo} live={events.live} reconnecting={events.reconnecting}
        connections={connections} onConnectionsChange={setConnections} />
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {!isMobile && <Sidebar route={route} navigate={navigate} counts={counts} project={project} />}
        <main style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--bg-base)" }}>
          <div key={route} style={{ flex: 1, minHeight: 0, animation: "route-in var(--dur-2) var(--ease-out)" }}>{screen}</div>
        </main>
      </div>
      {isMobile && <BottomTabBar route={route} navigate={navigate} counts={counts} />}
      <MobileNavDrawer open={navOpen} onClose={() => setNavOpen(false)} route={route} navigate={navigate} />

      {selected && <DetailSheet slug={selected} onClose={() => setSelected(null)} writeEnabled={prefs.writeEnabled} onOpenDiff={setDiffSlug} onHandoff={setHandoffSlug} onLive={onLive} />}
      {diffSlug && <DiffViewer slug={diffSlug} session={selectedRow(diffSlug)} onClose={() => setDiffSlug(null)} writeEnabled={prefs.writeEnabled} onHandoff={(s) => { setDiffSlug(null); setHandoffSlug(s); }} />}
      {handoffSlug && <HandoffDialog slug={handoffSlug} session={selectedRow(handoffSlug)} onClose={() => setHandoffSlug(null)} writeEnabled={prefs.writeEnabled} />}
      {liveSlug && <LiveSession slug={liveSlug} session={selectedRow(liveSlug)} sessions={sessions} onClose={() => setLiveSlug(null)} setSlug={setLiveSlug} onOpenDiff={(s) => { setLiveSlug(null); setDiffSlug(s); }} demo={demo} subscribe={events.subscribe} />}
      {launchOpen && <LaunchSession initialAgent={launchOpen.agent} onClose={() => setLaunchOpen(null)} writeEnabled={prefs.writeEnabled} onLaunched={(slug) => setSelected(slug)} />}
      <CommandBar open={cmdOpen} onClose={() => setCmdOpen(false)} navigate={navigate} onOpen={onOpen} onLaunch={onLaunch} sessions={sessions} prefs={prefs} />
      <TweaksPanel prefs={prefs} scenario={scenario} setScenario={setScenario} demo={demo} setDemo={setDemo} />
      <ToastViewport />
    </div>
  );
}
