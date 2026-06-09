/* ============================================================
   BATON — Command palette (⌘K) (ported from shell.jsx)
   ============================================================ */
import { useState, useRef, useEffect, useMemo } from "react";
import { Icon, type IconName } from "./Icon";
import { AgentBadge } from "./primitives";
import type { Prefs } from "../hooks/usePrefs";
import type { StatusRow, AgentId } from "../types";

interface Command {
  id: string;
  label: string;
  sub?: string;
  icon?: IconName;
  agent?: AgentId | null;
  group: string;
  run: () => void;
}

export function CommandBar({
  open, onClose, navigate, onOpen, onLaunch, sessions, prefs,
}: {
  open: boolean;
  onClose: () => void;
  navigate: (r: string) => void;
  onOpen: (slug: string) => void;
  onLaunch: (agent: AgentId | null) => void;
  sessions: StatusRow[];
  prefs: Prefs;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setQ(""); setSel(0); setTimeout(() => inputRef.current?.focus(), 30); } }, [open]);
  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onEsc, true);
    return () => window.removeEventListener("keydown", onEsc, true);
  }, [open, onClose]);

  const commands = useMemo<Command[]>(() => {
    const nav: Command[] = [
      { id: "n-home", label: "Go to Command Center", icon: "grid", group: "Navigate", run: () => navigate("home") },
      { id: "n-activity", label: "Go to Activity", icon: "zap", group: "Navigate", run: () => navigate("activity") },
      { id: "n-conflicts", label: "Go to Conflicts", icon: "alertTriangle", group: "Navigate", run: () => navigate("conflicts") },
      { id: "n-history", label: "Go to History", icon: "history", group: "Navigate", run: () => navigate("history") },
      { id: "n-agents", label: "Go to Agents", icon: "bot", group: "Navigate", run: () => navigate("agents") },
      { id: "n-settings", label: "Go to Settings", icon: "settings", group: "Navigate", run: () => navigate("settings") },
    ];
    const actions: Command[] = [
      { id: "a-launch", label: "Launch session", icon: "zap", group: "Actions", run: () => onLaunch(null) },
      { id: "a-theme", label: `Switch to ${prefs.resolvedTheme === "dark" ? "light" : "dark"} theme`, icon: prefs.resolvedTheme === "dark" ? "sun" : "moon", group: "Actions", run: () => prefs.setTheme(prefs.resolvedTheme === "dark" ? "light" : "dark") },
      { id: "a-write", label: `${prefs.writeEnabled ? "Disable" : "Enable"} write actions`, icon: "gitMerge", group: "Actions", run: () => prefs.setWriteEnabled(!prefs.writeEnabled) },
      { id: "a-board", label: "View board", icon: "columns", group: "Actions", run: () => { navigate("home"); prefs.setView("board"); } },
      { id: "a-canvas", label: "View canvas", icon: "network", group: "Actions", run: () => { navigate("home"); prefs.setView("canvas"); } },
    ];
    const sess: Command[] = (sessions || []).map((s) => ({ id: "s-" + s.slug, label: s.task, sub: s.slug, agent: s.agent, group: "Sessions", run: () => onOpen(s.slug) }));
    return [...nav, ...actions, ...sess];
  }, [navigate, onOpen, onLaunch, sessions, prefs]);

  const filtered = q ? commands.filter((c) => (c.label + " " + (c.sub || "")).toLowerCase().includes(q.toLowerCase())) : commands;
  const groups = filtered.reduce<Record<string, Command[]>>((m, c) => { (m[c.group] = m[c.group] || []).push(c); return m; }, {});
  const flat = Object.values(groups).flat();
  useEffect(() => { if (sel >= flat.length) setSel(Math.max(0, flat.length - 1)); }, [flat.length, sel]);

  if (!open) return null;
  const choose = (c: Command) => { c.run(); onClose(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(flat.length - 1, s + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); if (flat[sel]) choose(flat[sel]); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  };
  let idx = -1;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: "var(--z-cmd)" as unknown as number, display: "flex", justifyContent: "center", alignItems: "flex-start", paddingTop: "12vh" }}>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "var(--bg-scrim)", backdropFilter: "blur(3px)", animation: "fade-in var(--dur-2)" }} />
      <div role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKey} style={{
        position: "relative", width: "min(580px, 92vw)", maxHeight: "66vh", background: "var(--bg-elevated)",
        border: "1px solid var(--border-strong)", borderRadius: "var(--r-xl)", boxShadow: "var(--shadow-xl)",
        display: "flex", flexDirection: "column", overflow: "hidden", animation: "scale-in var(--dur-2) var(--ease-out)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "14px 16px", borderBottom: "1px solid var(--border-subtle)" }}>
          <Icon name="search" size={17} style={{ color: "var(--text-tertiary)", flex: "none" }} />
          <input ref={inputRef} value={q} onChange={(e) => { setQ(e.target.value); setSel(0); }} placeholder="Search sessions or run a command…"
            style={{ flex: 1, border: "none", background: "transparent", color: "var(--text-primary)", fontSize: "var(--fs-15)", outline: "none" }} />
          <span className="kbd">esc</span>
        </div>
        <div style={{ overflowY: "auto", padding: 8 }}>
          {flat.length === 0 ? (
            <div style={{ padding: "26px", textAlign: "center", color: "var(--text-tertiary)", fontSize: "var(--fs-13)" }}>No results for “{q}”</div>
          ) : Object.entries(groups).map(([group, items]) => (
            <div key={group} style={{ marginBottom: 4 }}>
              <div className="tag" style={{ padding: "6px 10px 4px" }}>{group}</div>
              {items.map((c) => {
                idx++; const active = idx === sel; const ci = idx;
                return (
                  <button key={c.id} className="fr" onMouseMove={() => setSel(ci)} onClick={() => choose(c)} style={{
                    width: "100%", display: "flex", alignItems: "center", gap: 11, padding: "9px 10px", borderRadius: "var(--r-sm)",
                    border: "none", cursor: "pointer", textAlign: "left", background: active ? "var(--bg-active)" : "transparent" }}>
                    {c.agent !== undefined
                      ? <AgentBadge id={c.agent} size="sm" showLabel={false} />
                      : <span style={{ width: 24, height: 24, borderRadius: 7, display: "grid", placeItems: "center", background: "var(--bg-surface-2)", border: "1px solid var(--border-subtle)", color: "var(--text-secondary)", flex: "none" }}><Icon name={c.icon!} size={14} /></span>}
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: "var(--fs-13)", color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.label}</span>
                      {c.sub && <span className="mono" style={{ display: "block", fontSize: "var(--fs-11)", color: "var(--text-tertiary)" }}>{c.sub}</span>}
                    </span>
                    {active && <Icon name="cornerUpRight" size={14} style={{ color: "var(--text-tertiary)" }} />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
