/* ============================================================
   BATON — Live coding session (ported from live.jsx)
   Demo mode: scripted activity stream (showcase). Real mode: the
   daemon's SSE feed — file edits, commits, agent attach/detach,
   overlap warnings — backfilled from /api/tasks/:slug + signals.
   ============================================================ */
import { useState, useRef, useEffect, useMemo } from "react";
import { Icon, type IconName } from "../components/Icon";
import { AgentBadge } from "../components/primitives";
import { getAgent, AGENT_REGISTRY, AgentGlyph } from "../lib/registry";
import { deriveColumn, COLUMN_DEFS } from "../lib/derive";
import { BatonAPI, branchFor } from "../lib/api";
import { buildActivity, getDiff, type LiveEvent, type LiveEventType } from "../lib/preview";
import { useMediaQuery } from "../hooks/useMediaQuery";
import type { BatonEventMsg } from "../hooks/useEvents";
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

const cap = (list: TimedEvent[]) => (list.length > 500 ? list.slice(-500) : list);

export function LiveSession({
  slug, session, sessions, onClose, setSlug, onOpenDiff, demo = false, subscribe,
}: {
  slug: string;
  session?: StatusRow;
  sessions: StatusRow[];
  onClose: () => void;
  setSlug: (slug: string) => void;
  onOpenDiff: (slug: string) => void;
  demo?: boolean;
  subscribe?: (type: string, fn: (e: BatonEventMsg) => void) => () => void;
}) {
  const task = session;
  const agent = getAgent(task?.agent ?? null);
  const accent = task?.agent ? agent.color : "var(--accent)";
  const [events, setEvents] = useState<TimedEvent[]>([]);
  const [demoStreaming, setDemoStreaming] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [railOpen, setRailOpen] = useState(false);
  const showRail = useMediaQuery("(min-width: 780px)");
  const logRef = useRef<HTMLDivElement>(null);
  const others = useMemo(() => sessions.filter((s) => s.agent && s.slug !== slug), [sessions, slug]);
  const pick = (s: string) => { setSlug(s); setRailOpen(false); };
  // Real mode: "working" = an agent process is attached to the worktree.
  const streaming = demo ? demoStreaming : task?.agent != null;

  // Demo: scripted showcase stream.
  useEffect(() => {
    if (!demo) return;
    setEvents([]); setDemoStreaming(true); setRailOpen(false);
    const script = buildActivity(slug, task);
    let i = 0, alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (!alive) return;
      if (i >= script.length) { setDemoStreaming(false); return; }
      const ev = script[i++];
      setEvents((cur) => [...cur, { ...ev, at: Date.now() }]);
      timer = setTimeout(tick, i < 4 ? 520 : 720 + Math.random() * 520);
    };
    timer = setTimeout(tick, 320);
    return () => { alive = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, demo]);

  // Real: backfill from the API, then ride the SSE feed.
  useEffect(() => {
    if (demo) return;
    setEvents([]); setRailOpen(false);
    let alive = true;
    void (async () => {
      const rows: TimedEvent[] = [];
      try {
        const detail = await BatonAPI.getTask(slug);
        rows.push({ t: "boot", text: `Watching ${branchFor(slug)} — ${detail.filesChanged} uncommitted file${detail.filesChanged === 1 ? "" : "s"}`, at: Date.parse(detail.createdAt) || Date.now() });
        for (const c of detail.commits.slice(0, 10).reverse()) {
          rows.push({ t: "commit", text: c.message, meta: c.sha.slice(0, 7), at: Date.parse(c.at) || Date.now() });
        }
      } catch {
        rows.push({ t: "warn", text: "Session not found — it may have been merged or removed.", at: Date.now() });
      }
      try {
        for (const sig of await BatonAPI.getSignals()) {
          for (const h of sig.holders) {
            if (h.slug === slug) rows.push({ t: "edit", text: `Editing ${sig.path}`, at: Date.parse(h.lastEditAt) || Date.now() });
          }
        }
      } catch { /* signals are best-effort */ }
      if (alive) setEvents(cap(rows.sort((a, b) => a.at - b.at)));
    })();

    const push = (ev: TimedEvent) => setEvents((cur) => cap([...cur, ev]));
    const unsub = subscribe?.("*", (msg) => {
      const mslug = msg.slug as string | undefined;
      switch (msg.type) {
        case "file.edited":
          if (mslug === slug) push({ t: "edit", text: `Edited ${msg.path as string}`, at: Date.parse(msg.at as string) || Date.now() });
          break;
        case "commit.created":
          if (mslug === slug) push({ t: "commit", text: msg.message as string, meta: (msg.sha as string)?.slice(0, 7), at: Date.now() });
          break;
        case "agent.output":
          if (mslug === slug) push({ t: (msg.stream as string) === "err" ? "warn" : "out", text: msg.line as string, at: Date.now() });
          break;
        case "agent.started":
          if (mslug === slug) push({ t: "boot", text: `${getAgent((msg.agent as StatusRow["agent"]) ?? null).short} attached`, at: Date.now() });
          break;
        case "agent.stopped":
          if (mslug === slug) push({ t: "warn", text: `${getAgent((msg.agent as StatusRow["agent"]) ?? null).short} detached`, at: Date.now() });
          break;
        case "handoff.created":
          if (mslug === slug) push({ t: "commit", text: `Handoff brief created → ${msg.toAgent as string}`, at: Date.now() });
          break;
        case "signal.overlap": {
          const slugs = (msg.slugs as string[]) ?? [];
          if (slugs.includes(slug)) {
            const othersList = slugs.filter((s) => s !== slug).join(", ");
            push({ t: "warn", text: `Overlap on ${msg.path as string} — also edited by ${othersList}`, at: Date.now() });
          }
          break;
        }
      }
    });
    return () => { alive = false; unsub?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, demo, subscribe]);

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
          {streaming ? <><LiveDot size={6} /> {agent.short} is working</> : <>idle · {demo ? "waiting for changes" : "no agent attached"}</>}
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
        {!demo && events.length === 0 && (
          <div style={{ display: "grid", placeItems: "center", flex: 1, padding: 24 }}>
            <span style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)", textAlign: "center", maxWidth: 340 }}>
              No activity yet — events appear here as the agent edits files and commits on <span className="mono">{branchFor(slug)}</span>.
            </span>
          </div>
        )}
        {streaming && <div style={{ display: "flex", gap: 9, alignItems: "center", padding: "3px 0 3px 53px" }}><span style={{ width: 7, height: 14, background: accent, animation: "blink 1s steps(2) infinite", borderRadius: 1 }} /></div>}
      </div>
      <div style={{ flex: "none", padding: "8px 13px", borderTop: "1px solid var(--border-subtle)", background: "var(--bg-surface)", display: "flex", alignItems: "center", gap: 8 }}>
        {demo && getDiff(slug).length > 0 && <button className="btn btn-sm fr" onClick={() => onOpenDiff(slug)}><Icon name="terminal" size={12} /> View diff</button>}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-quaternary)" }}>
          {events.filter((e) => e.t === "edit" || e.t === "create" || e.t === "delete").length} file edit{events.filter((e) => e.t === "edit" || e.t === "create" || e.t === "delete").length === 1 ? "" : "s"} · {events.filter((e) => e.t === "commit").length} commit{events.filter((e) => e.t === "commit").length === 1 ? "" : "s"} this session
        </span>
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
              {demo && <span style={{ fontSize: 10, fontWeight: "var(--fw-semibold)", letterSpacing: "var(--ls-caps)", textTransform: "uppercase", color: "var(--text-tertiary)", background: "var(--bg-surface)", border: "1px dashed var(--border-default)", borderRadius: 99, padding: "2px 7px", flex: "none" }} data-tip="Demo mode — this stream is illustrative. Real sessions stream the daemon's live events.">Preview</span>}
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
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>{ActivityPane}</div>
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
