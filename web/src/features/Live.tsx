/* ============================================================
   BATON — Live coding session (PREVIEW) (ported from live.jsx)
   Live activity stream + running-app preview + the project's dev
   servers. Live streaming isn't exposed by the daemon yet — labelled.
   ============================================================ */
import { useState, useRef, useEffect, useMemo } from "react";
import { Icon, type IconName } from "../components/Icon";
import { AgentBadge, SegmentedControl } from "../components/primitives";
import { getAgent, AGENT_REGISTRY, AgentGlyph } from "../lib/registry";
import { deriveColumn, COLUMN_DEFS } from "../lib/derive";
import { branchFor } from "../lib/api";
import { buildActivity, getDiff, SERVERS, type DevServer, type LiveEvent, type LiveEventType } from "../lib/preview";
import { useMediaQuery } from "../hooks/useMediaQuery";
import type { StatusRow } from "../types";

const LIVE_EV: Record<LiveEventType, { icon: IconName | null; c: string; italic?: boolean; term?: boolean }> = {
  boot: { icon: "link", c: "var(--accent-text)" },
  think: { icon: "sparkle", c: "var(--text-tertiary)", italic: true },
  read: { icon: "search", c: "var(--text-secondary)" },
  edit: { icon: "fileWarning", c: "var(--dirty-text)" },
  create: { icon: "plus", c: "var(--clean-text)" },
  delete: { icon: "trash", c: "var(--conflict-text)" },
  cmd: { icon: "terminal", c: "var(--text-primary)", term: true },
  out: { icon: null, c: "var(--text-tertiary)", term: true },
  commit: { icon: "gitCommit", c: "var(--clean-text)" },
  warn: { icon: "alertTriangle", c: "var(--conflict-text)" },
};

function LiveDot({ color = "var(--clean)", size = 7 }: { color?: string; size?: number }) {
  return (
    <span style={{ position: "relative", width: size, height: size, flex: "none", display: "inline-block" }}>
      <span style={{ position: "absolute", inset: 0, borderRadius: 99, background: color }} />
      <span style={{ position: "absolute", inset: 0, borderRadius: 99, background: color, animation: "ping 1.6s var(--ease-out) infinite" }} />
    </span>
  );
}

function LivePreviewFrame({ accent, pulse }: { accent: string; pulse: boolean }) {
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg-base)", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 10px", borderBottom: "1px solid var(--border-subtle)", flex: "none" }}>
        <span style={{ display: "flex", gap: 5 }}>{["#ff5f57", "#febc2e", "#28c840"].map((c) => <span key={c} style={{ width: 9, height: 9, borderRadius: 99, background: c, opacity: 0.85 }} />)}</span>
        <button className="btn btn-ghost btn-icon fr" style={{ width: 24, height: 24 }} aria-label="Reload"><Icon name="refresh" size={12} style={{ animation: pulse ? "spin 0.6s var(--ease-out)" : "none" }} /></button>
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 7, height: 26, padding: "0 10px", background: "var(--bg-input)", border: "1px solid var(--border-subtle)", borderRadius: 99 }}>
          <span style={{ width: 6, height: 6, borderRadius: 99, background: "var(--clean)" }} />
          <span className="mono" style={{ fontSize: 11, color: "var(--text-tertiary)" }}>localhost:3000</span>
        </div>
        <button className="btn btn-ghost btn-icon fr" style={{ width: 24, height: 24 }} data-tip="Open in browser" aria-label="Open"><Icon name="externalLink" size={12} /></button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", position: "relative" }}>
        {pulse && <div style={{ position: "absolute", inset: 0, boxShadow: `inset 0 0 0 2px ${accent}`, opacity: 0.5, animation: "fade-in var(--dur-2)", pointerEvents: "none", zIndex: 2 }} />}
        <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "#fff", color: "#0c0d12" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid #ececf1" }}>
            <span style={{ width: 22, height: 22, borderRadius: 6, background: accent, display: "grid", placeItems: "center", color: "#fff", fontSize: 12, fontWeight: 800 }}>O</span>
            <span style={{ fontWeight: 700, fontSize: 14, letterSpacing: "-0.02em" }}>Orbit</span>
            <div style={{ display: "flex", gap: 14, marginLeft: 12 }}>{["Products", "Orders", "Customers"].map((n, i) => <span key={n} style={{ fontSize: 12.5, color: i === 0 ? "#0c0d12" : "#7c828c", fontWeight: i === 0 ? 600 : 500 }}>{n}</span>)}</div>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, color: "#7c828c", border: "1px solid #e6e7ec", borderRadius: 99, padding: "3px 9px" }}>Sign in</span>
              <span style={{ fontSize: 11, color: "#fff", background: accent, borderRadius: 99, padding: "4px 11px", fontWeight: 600 }}>Get started</span>
            </div>
          </div>
          <div style={{ padding: "26px 24px", flex: 1, minHeight: 0, overflow: "hidden" }}>
            <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1.15, maxWidth: 380 }}>Everything you ship, in one orbit.</div>
            <div style={{ fontSize: 13, color: "#6b7280", marginTop: 8, maxWidth: 360, lineHeight: 1.5 }}>The commerce platform for modern teams — fast, composable, and built to scale.</div>
            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <span style={{ fontSize: 12.5, color: "#fff", background: "#0c0d12", borderRadius: 8, padding: "9px 16px", fontWeight: 600 }}>Start free</span>
              <span style={{ fontSize: 12.5, color: "#0c0d12", border: "1px solid #e6e7ec", borderRadius: 8, padding: "9px 16px", fontWeight: 600 }}>Book a demo</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginTop: 26 }}>
              {([["Revenue", "$248k"], ["Orders", "1,932"], ["Conversion", "3.8%"]] as const).map(([k, v]) => (
                <div key={k} style={{ border: "1px solid #ececf1", borderRadius: 12, padding: "13px 14px", background: "#fbfbfd" }}>
                  <div style={{ fontSize: 11, color: "#8b909a" }}>{k}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em", marginTop: 4 }}>{v}</div>
                  <div style={{ height: 3, borderRadius: 9, background: "#eef0f3", marginTop: 9 }}><div style={{ height: "100%", width: "62%", borderRadius: 9, background: accent }} /></div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ServerRow({ s }: { s: DevServer }) {
  const owner = s.owner ? getAgent(s.owner as StatusRow["agent"]) : null;
  const meta = ({ running: { c: "var(--clean)", label: "running" }, degraded: { c: "var(--dirty)", label: "degraded" }, stopped: { c: "var(--idle)", label: "stopped" } } as const)[s.status];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "10px 12px", borderBottom: "1px solid var(--border-subtle)" }}>
      {s.status === "running" ? <LiveDot color={meta.c} /> : <span style={{ width: 7, height: 7, borderRadius: 99, background: meta.c, flex: "none" }} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)" }}>{s.label}</span>
          <span style={{ fontSize: 10, color: "var(--text-tertiary)", background: "var(--bg-surface-2)", border: "1px solid var(--border-subtle)", borderRadius: 99, padding: "1px 6px" }}>{s.framework}</span>
          {owner && <span data-tip={`owned by ${owner.short}`} style={{ display: "inline-flex" }}><AgentBadge id={s.owner as StatusRow["agent"]} size="sm" showLabel={false} /></span>}
        </div>
        <div className="mono" style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>$ {s.cmd}</div>
      </div>
      <div style={{ textAlign: "right", flex: "none" }}>
        {s.port && <div className="mono" style={{ fontSize: 11, color: meta.c }}>:{s.port}</div>}
        <div style={{ fontSize: 10, color: "var(--text-quaternary)" }}>{s.uptime}</div>
      </div>
      {s.preview
        ? <button className="btn btn-sm btn-icon fr" data-tip="Open preview" aria-label="Open"><Icon name="externalLink" size={13} /></button>
        : <button className="btn btn-sm btn-icon fr" data-tip="Restart" aria-label="Restart"><Icon name="refresh" size={13} /></button>}
    </div>
  );
}

interface TimedEvent extends LiveEvent { at: number }

/* ---- Sessions rail: collapsible agent folders → session children ---- */
function RailChild({ s, color, currentSlug, onPick }: {
  s: StatusRow; color: string; currentSlug: string; onPick: (slug: string) => void;
}) {
  const cd = COLUMN_DEFS.find((c) => c.id === deriveColumn(s))!;
  const on = s.slug === currentSlug;
  return (
    <button className="fr" onClick={() => onPick(s.slug)} aria-current={on} style={{
      position: "relative", display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "6px 8px 6px 10px",
      borderRadius: "var(--r-sm)", border: "none", cursor: "pointer", textAlign: "left", marginBottom: 1,
      background: on ? "var(--bg-active)" : "transparent" }}
      onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(e) => { if (!on) e.currentTarget.style.background = "transparent"; }}>
      <span aria-hidden="true" style={{ position: "absolute", left: -11, top: "50%", width: 10, height: 1, background: "var(--border-default)" }} />
      {on && <span style={{ position: "absolute", left: 0, top: 7, bottom: 7, width: 2.5, borderRadius: 99, background: color }} />}
      {s.agent ? <LiveDot color={cd.color} size={6} /> : <span style={{ width: 6, height: 6, borderRadius: 99, background: cd.color, flex: "none" }} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "var(--fs-12)", fontWeight: on ? "var(--fw-semibold)" : "var(--fw-medium)", color: on ? "var(--text-primary)" : "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.task}</div>
        <div className="mono" style={{ fontSize: 10, color: "var(--text-quaternary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.slug}</div>
      </div>
    </button>
  );
}

function RailFolder({ id, color, glyph, label, items, idleGroup, currentSlug, onPick, collapsed, toggle }: {
  id: string; color: string; glyph?: React.ReactNode; label: string; items: StatusRow[]; idleGroup?: boolean;
  currentSlug: string; onPick: (slug: string) => void; collapsed: Record<string, boolean>; toggle: (id: string) => void;
}) {
  const isOpen = collapsed[id] !== true;
  const hasCurrent = items.some((s) => s.slug === currentSlug);
  return (
    <div style={{ marginBottom: 3 }}>
      <button className="fr" onClick={() => toggle(id)} aria-expanded={isOpen} style={{
        display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 9px 7px 7px", borderRadius: "var(--r-sm)",
        border: "none", cursor: "pointer", textAlign: "left", background: hasCurrent ? `color-mix(in srgb, ${color} 9%, transparent)` : "transparent" }}
        onMouseEnter={(e) => { if (!hasCurrent) e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = hasCurrent ? `color-mix(in srgb, ${color} 9%, transparent)` : "transparent"; }}>
        <Icon name="chevronRight" size={13} style={{ color: "var(--text-tertiary)", flex: "none", transform: isOpen ? "rotate(90deg)" : "none", transition: "transform var(--dur-1)" }} />
        <span style={{ width: 22, height: 22, borderRadius: 6, flex: "none", display: "grid", placeItems: "center",
          background: idleGroup ? "var(--idle-soft)" : `color-mix(in srgb, ${color} 16%, transparent)`,
          border: `1px solid ${idleGroup ? "var(--idle-border)" : `color-mix(in srgb, ${color} 36%, transparent)`}` }}>
          {idleGroup ? <Icon name="bot" size={12} style={{ color: "var(--idle)" }} /> : glyph}
        </span>
        <span style={{ flex: 1, fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)", color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        <span className="mono" style={{ fontSize: 10, color: "var(--text-secondary)", background: "var(--bg-surface-2)", borderRadius: 99, padding: "1px 7px", border: "1px solid var(--border-subtle)", flex: "none" }}>{items.length}</span>
      </button>
      {isOpen && (
        <div style={{ position: "relative", marginLeft: 17, paddingLeft: 11, borderLeft: "1px solid var(--border-subtle)", marginTop: 1 }}>
          {items.length > 1 && !idleGroup && (
            <div style={{ fontSize: 10, color: "var(--text-quaternary)", padding: "2px 0 4px 2px", letterSpacing: "var(--ls-snug)" }}>{items.length} parallel sessions</div>
          )}
          {items.map((s) => <RailChild key={s.slug} s={s} color={color} currentSlug={currentSlug} onPick={onPick} />)}
        </div>
      )}
    </div>
  );
}

function LiveSessionRail({ sessions, currentSlug, onPick, onClose }: {
  sessions: StatusRow[];
  currentSlug: string;
  onPick: (slug: string) => void;
  onClose?: () => void;
}) {
  const live = sessions.filter((s) => s.agent !== null);
  const idle = sessions.filter((s) => s.agent === null);
  const groups = AGENT_REGISTRY.map((a) => ({ a, items: live.filter((s) => s.agent === a.id) })).filter((g) => g.items.length);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0, background: "var(--bg-surface)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 12px", borderBottom: "1px solid var(--border-subtle)", flex: "none" }}>
        <Icon name="layers" size={14} style={{ color: "var(--text-tertiary)" }} />
        <span style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)" }}>Sessions</span>
        <span className="mono" style={{ fontSize: 11, color: "var(--clean-text)" }}>{live.length} live</span>
        {onClose && <button className="btn btn-ghost btn-icon fr" onClick={onClose} aria-label="Close sessions" style={{ marginLeft: "auto", width: 26, height: 26 }}><Icon name="x" size={14} /></button>}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 8 }}>
        {groups.map(({ a, items }) => (
          <RailFolder key={a.id} id={a.id!} color={a.color} label={a.short} items={items} glyph={<AgentGlyph id={a.id} size={13} />}
            currentSlug={currentSlug} onPick={onPick} collapsed={collapsed} toggle={toggle} />
        ))}
        {idle.length > 0 && <RailFolder id="__idle" color="var(--idle)" label="Idle · unassigned" items={idle} idleGroup
          currentSlug={currentSlug} onPick={onPick} collapsed={collapsed} toggle={toggle} />}
      </div>
    </div>
  );
}

export function LiveSession({
  slug, session, sessions, onClose, setSlug, onOpenDiff,
}: {
  slug: string;
  session?: StatusRow;
  sessions: StatusRow[];
  onClose: () => void;
  setSlug: (slug: string) => void;
  onOpenDiff: (slug: string) => void;
}) {
  const task = session;
  const agent = getAgent(task?.agent ?? null);
  const accent = task?.agent ? agent.color : "var(--accent)";
  const [events, setEvents] = useState<TimedEvent[]>([]);
  const [streaming, setStreaming] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [pulse, setPulse] = useState(false);
  const [tab, setTab] = useState<"activity" | "preview">("activity");
  const [railOpen, setRailOpen] = useState(false);
  const isWide = useMediaQuery("(min-width: 850px)");
  const showRail = useMediaQuery("(min-width: 780px)");
  const logRef = useRef<HTMLDivElement>(null);
  const others = useMemo(() => sessions.filter((s) => s.agent && s.slug !== slug), [sessions, slug]);
  const pick = (s: string) => { setSlug(s); setRailOpen(false); };
  const running = SERVERS.filter((s) => s.status === "running").length;

  useEffect(() => {
    setEvents([]); setStreaming(true); setRailOpen(false);
    const script = buildActivity(slug, task);
    let i = 0, alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (!alive) return;
      if (i >= script.length) { setStreaming(false); return; }
      const ev = script[i++];
      setEvents((cur) => [...cur, { ...ev, at: Date.now() }]);
      if (ev.t === "edit" || ev.t === "create" || ev.t === "commit") { setPulse(true); setTimeout(() => setPulse(false), 520); }
      timer = setTimeout(tick, i < 4 ? 520 : 720 + Math.random() * 520);
    };
    timer = setTimeout(tick, 320);
    return () => { alive = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  useEffect(() => { const t = setInterval(() => setElapsed((e) => e + 1), 1000); return () => clearInterval(t); }, [slug]);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [events]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0"), ss = String(elapsed % 60).padStart(2, "0");

  const ActivityPane = (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%", background: "var(--code-bg)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 13px", borderBottom: "1px solid var(--border-subtle)", flex: "none", background: "var(--bg-surface)" }}>
        <Icon name="terminal" size={14} style={{ color: "var(--text-tertiary)" }} />
        <span style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)" }}>Activity</span>
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, fontSize: "var(--fs-12)", color: streaming ? "var(--clean-text)" : "var(--text-tertiary)" }}>
          {streaming ? <><LiveDot size={6} /> {agent.short} is working</> : <>idle · waiting for changes</>}
        </span>
      </div>
      <div ref={logRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 13px", display: "flex", flexDirection: "column", gap: 2 }}>
        {events.map((e, i) => {
          const m = LIVE_EV[e.t] || LIVE_EV.read;
          return (
            <div key={i} style={{ display: "flex", gap: 9, alignItems: "baseline", padding: "2px 0", animation: "fade-up 0.25s var(--ease-out)" }}>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--text-quaternary)", flex: "none", width: 30, textAlign: "right", userSelect: "none" }}>{new Date(e.at).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" })}</span>
              <span style={{ width: 14, flex: "none", display: "grid", placeItems: "center", color: m.c, marginTop: 1 }}>{m.term ? <span className="mono" style={{ fontSize: 12 }}>{e.t === "cmd" ? "$" : "›"}</span> : m.icon ? <Icon name={m.icon} size={12} /> : null}</span>
              <span className={m.term ? "mono" : ""} style={{ flex: 1, minWidth: 0, fontSize: m.term ? 12 : "var(--fs-12)", color: m.c, fontStyle: m.italic ? "italic" : "normal", lineHeight: 1.5, wordBreak: "break-word" }}>
                {e.text}
                {e.meta && <span className="mono" style={{ marginLeft: 8, fontSize: 11, color: e.t === "commit" ? "var(--accent-text)" : "var(--text-quaternary)" }}>{e.meta}</span>}
              </span>
            </div>
          );
        })}
        {streaming && <div style={{ display: "flex", gap: 9, alignItems: "center", padding: "3px 0 3px 53px" }}><span style={{ width: 7, height: 14, background: accent, animation: "blink 1s steps(2) infinite", borderRadius: 1 }} /></div>}
      </div>
      <div style={{ flex: "none", padding: "8px 13px", borderTop: "1px solid var(--border-subtle)", background: "var(--bg-surface)", display: "flex", alignItems: "center", gap: 8 }}>
        {getDiff(slug).length > 0 && <button className="btn btn-sm fr" onClick={() => onOpenDiff(slug)}><Icon name="terminal" size={12} /> View diff</button>}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-quaternary)" }}>{events.filter((e) => e.t === "edit" || e.t === "create" || e.t === "delete").length} file ops this run</span>
      </div>
    </div>
  );

  const PreviewPane = (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      <div style={{ flex: 1, minHeight: 0, borderBottom: isWide ? "1px solid var(--border-subtle)" : "none" }}><LivePreviewFrame accent={accent} pulse={pulse} /></div>
      <div style={{ flex: "none", maxHeight: isWide ? "44%" : "none", display: "flex", flexDirection: "column", background: "var(--bg-surface)", minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 13px", borderBottom: "1px solid var(--border-subtle)", flex: "none" }}>
          <Icon name="layers" size={14} style={{ color: "var(--text-tertiary)" }} />
          <span style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)" }}>Dev servers</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--clean-text)" }}>{running} running</span>
          <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-quaternary)", display: "inline-flex", alignItems: "center", gap: 5 }}><Icon name="link" size={11} /> managed by Baton</span>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>{SERVERS.map((s) => <ServerRow key={s.id} s={s} />)}</div>
      </div>
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: "var(--z-overlay)" as unknown as number, display: "grid", placeItems: "center", padding: "min(3vh, 24px) min(3vw, 28px)" }}>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "var(--bg-scrim)", backdropFilter: "blur(3px)", animation: "fade-in var(--dur-2)" }} />
      <div role="dialog" aria-modal="true" aria-label={`Live session — ${task?.task || slug}`} style={{
        position: "relative", width: "min(1240px, 100%)", height: "min(860px, 100%)", background: "var(--bg-surface)",
        border: "1px solid var(--border-strong)", borderRadius: "var(--r-xl)", boxShadow: "var(--shadow-xl)", overflow: "hidden",
        display: "flex", flexDirection: "column", animation: "scale-in var(--dur-3) var(--ease-out)" }}>

        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 12px 11px 16px", borderBottom: "1px solid var(--border-subtle)", flex: "none", background: `linear-gradient(180deg, color-mix(in srgb, ${accent} 8%, transparent), var(--bg-surface-2))` }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7, height: 24, padding: "0 9px", borderRadius: 99, background: "var(--conflict-soft)", border: "1px solid var(--conflict-border)", flex: "none" }}>
            <LiveDot color="var(--conflict-strong)" size={6} />
            <span style={{ fontSize: 11, fontWeight: "var(--fw-bold)", letterSpacing: "var(--ls-caps)", color: "var(--conflict-text)" }}>LIVE</span>
          </span>
          <AgentBadge id={task?.agent ?? null} size="sm" showLabel={false} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task?.task || slug}</span>
              <span style={{ fontSize: 10, fontWeight: "var(--fw-semibold)", letterSpacing: "var(--ls-caps)", textTransform: "uppercase", color: "var(--text-tertiary)", background: "var(--bg-surface)", border: "1px dashed var(--border-default)", borderRadius: 99, padding: "2px 7px", flex: "none" }} data-tip="Live session streaming isn't exposed by the API yet — illustrative preview.">Preview</span>
            </div>
            <div className="mono" style={{ fontSize: 11, color: "var(--text-tertiary)", display: "flex", alignItems: "center", gap: 6 }}>
              <Icon name="gitBranch" size={11} /> {branchFor(slug)} <span style={{ color: "var(--text-quaternary)" }}>·</span> <Icon name="clock" size={11} /> {mm}:{ss}
            </div>
          </div>
          {!showRail && (
            <button className="btn btn-sm fr" onClick={() => setRailOpen(true)} aria-label="Sessions" style={{ flex: "none" }}>
              <Icon name="layers" size={13} /> Sessions
            </button>
          )}
          {showRail && others.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }} data-tip="Other agents live in this repo">
              <span style={{ fontSize: 11, color: "var(--text-tertiary)" }} className="lv-hide-sm">also live</span>
              <div style={{ display: "flex" }}>
                {others.slice(0, 5).map((s, i) => (
                  <button key={s.slug} className="fr" onClick={() => pick(s.slug)} data-tip={`${getAgent(s.agent).short} · ${s.task}`} aria-label={`Watch ${s.task}`}
                    style={{ marginLeft: i ? -7 : 0, borderRadius: 8, border: "2px solid var(--bg-surface-2)", background: "transparent", padding: 0, cursor: "pointer", lineHeight: 0 }}>
                    <AgentBadge id={s.agent} size="sm" showLabel={false} />
                  </button>
                ))}
              </div>
            </div>
          )}
          <button className="btn btn-ghost btn-icon fr" onClick={onClose} aria-label="Close · Esc" data-tip="Close · Esc" data-tip-side="bottom"><Icon name="x" size={16} /></button>
        </div>

        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          {showRail && (
            <aside style={{ width: 248, flex: "none", borderRight: "1px solid var(--border-subtle)" }}>
              <LiveSessionRail sessions={sessions} currentSlug={slug} onPick={pick} />
            </aside>
          )}
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
            {isWide ? (
              <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
                <div style={{ flex: "1.05 1 0", minWidth: 0, borderRight: "1px solid var(--border-subtle)" }}>{ActivityPane}</div>
                <div style={{ flex: "1 1 0", minWidth: 0 }}>{PreviewPane}</div>
              </div>
            ) : (
              <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                <div style={{ flex: "none", padding: 8, borderBottom: "1px solid var(--border-subtle)" }}>
                  <SegmentedControl size="sm" ariaLabel="Live panes" value={tab} onChange={setTab}
                    options={[{ value: "activity", label: "Activity", icon: "terminal" }, { value: "preview", label: "Preview & servers", icon: "monitor" }]} />
                </div>
                <div style={{ flex: 1, minHeight: 0 }}>{tab === "activity" ? ActivityPane : PreviewPane}</div>
              </div>
            )}
          </div>
        </div>

        {!showRail && railOpen && (
          <div style={{ position: "absolute", inset: 0, zIndex: 2, display: "flex" }}>
            <div onClick={() => setRailOpen(false)} style={{ position: "absolute", inset: 0, background: "var(--bg-scrim)", animation: "fade-in var(--dur-2)" }} />
            <div style={{ position: "relative", width: "min(300px, 86%)", boxShadow: "var(--shadow-xl)", borderRight: "1px solid var(--border-strong)", animation: "sheet-in-right var(--dur-3) var(--ease-out)" }}>
              <LiveSessionRail sessions={sessions} currentSlug={slug} onPick={pick} onClose={() => setRailOpen(false)} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
