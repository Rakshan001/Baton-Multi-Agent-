/* ============================================================
   BATON — Primitive component library (ported from primitives.jsx,
   card.jsx ConfirmDialog, admin.jsx Switch, detail.jsx ComingSoon)
   ============================================================ */
import {
  useState, useEffect, useRef, useReducer,
  type CSSProperties, type ReactNode,
} from "react";
import { Icon, type IconName } from "./Icon";
import { getAgent, AgentGlyph } from "../lib/registry";
import { progressEstimate, timeAgo, timeAgoShort, copyText } from "../lib/format";
import { showToast } from "../lib/toast";
import type { AgentId, Status } from "../types";

type Size = "sm" | "md" | "lg";

/* ---------- AgentBadge ---------- */
export function AgentBadge({
  id, size = "md", showLabel = true, dim = false,
}: { id: AgentId | null; size?: Size; showLabel?: boolean; dim?: boolean }) {
  const a = getAgent(id);
  const col = a.color;
  const isNeutral = !id;
  const glyphSize = size === "sm" ? 13 : size === "lg" ? 18 : 15;
  const swatch = size === "sm" ? 20 : size === "lg" ? 30 : 24;
  return (
    <span className="agent-badge" style={{ display: "inline-flex", alignItems: "center", gap: showLabel ? 7 : 0, opacity: dim ? 0.85 : 1 }}>
      <span style={{
        width: swatch, height: swatch, borderRadius: size === "lg" ? 9 : 7,
        display: "grid", placeItems: "center", flex: "none",
        background: isNeutral ? "var(--idle-soft)" : `color-mix(in srgb, ${col} 16%, transparent)`,
        border: `1px solid ${isNeutral ? "var(--idle-border)" : `color-mix(in srgb, ${col} 38%, transparent)`}`,
        boxShadow: isNeutral ? "none" : `inset 0 0 12px color-mix(in srgb, ${col} 10%, transparent)`,
      }}>
        <AgentGlyph id={id} size={glyphSize} color={isNeutral ? "var(--idle)" : col} />
      </span>
      {showLabel && (
        <span style={{ fontSize: size === "sm" ? "var(--fs-12)" : "var(--fs-13)", fontWeight: "var(--fw-medium)", color: "var(--text-primary)", letterSpacing: "var(--ls-snug)" }}>{a.short}</span>
      )}
    </span>
  );
}

/* ---------- StatusPill ---------- */
export const STATUS_META: Record<Status, { label: string; color: string; soft: string; border: string; dot: string }> = {
  clean: { label: "Clean", color: "var(--clean-text)", soft: "var(--clean-soft)", border: "var(--clean-border)", dot: "var(--clean)" },
  dirty: { label: "Dirty", color: "var(--dirty-text)", soft: "var(--dirty-soft)", border: "var(--dirty-border)", dot: "var(--dirty)" },
  conflict: { label: "Conflict", color: "var(--conflict-text)", soft: "var(--conflict-soft)", border: "var(--conflict-border)", dot: "var(--conflict)" },
};
export function StatusPill({ status, pulse = false }: { status: Status; pulse?: boolean }) {
  const m = STATUS_META[status] || STATUS_META.clean;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5, height: 21, padding: "0 8px 0 7px",
      borderRadius: "var(--r-full)", fontSize: "var(--fs-12)", fontWeight: "var(--fw-medium)",
      color: m.color, background: m.soft, border: `1px solid ${m.border}`, whiteSpace: "nowrap",
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: m.dot, flex: "none", animation: pulse && status === "conflict" ? "pulse-dot 1.6s var(--ease-in-out) infinite" : "none" }} />
      {m.label}
    </span>
  );
}

/* ---------- SyncChips ---------- */
export function SyncChips({ ahead, behind, size = "md" }: { ahead: number; behind: number; size?: Size }) {
  const fs = size === "sm" ? "var(--fs-11)" : "var(--fs-12)";
  const base: CSSProperties = {
    display: "inline-flex", alignItems: "center", gap: 2, fontFamily: "var(--font-mono)",
    fontSize: fs, fontWeight: "var(--fw-medium)" as CSSProperties["fontWeight"], padding: "1px 6px 1px 4px",
    borderRadius: "var(--r-xs)", border: "1px solid var(--border-default)",
  };
  return (
    <span style={{ display: "inline-flex", gap: 4 }}>
      <span data-tip={`${ahead} commit${ahead === 1 ? "" : "s"} ahead of main`} style={{ ...base, color: ahead > 0 ? "var(--text-secondary)" : "var(--text-quaternary)", background: ahead > 0 ? "var(--bg-surface-2)" : "transparent" }}>
        <Icon name="arrowUp" size={11} strokeWidth={2.4} /> {ahead}
      </span>
      <span data-tip={`${behind} commit${behind === 1 ? "" : "s"} behind main`} style={{ ...base, color: behind > 0 ? "var(--dirty-text)" : "var(--text-quaternary)", background: behind > 0 ? "var(--dirty-soft)" : "transparent", borderColor: behind > 0 ? "var(--dirty-border)" : "var(--border-default)" }}>
        <Icon name="arrowDown" size={11} strokeWidth={2.4} /> {behind}
      </span>
    </span>
  );
}

/* ---------- ProgressBar (est., derived from ahead) ---------- */
export function ProgressBar({ ahead, color = "var(--accent)", showLabel = true }: { ahead: number; color?: string; showLabel?: boolean }) {
  const v = progressEstimate(ahead);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      {showLabel && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)", letterSpacing: "var(--ls-snug)" }}>
            Progress <span style={{ color: "var(--text-quaternary)", fontStyle: "italic" }}>est.</span>
          </span>
          <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)" }}>{ahead} commit{ahead === 1 ? "" : "s"}</span>
        </div>
      )}
      <div style={{ height: 4, borderRadius: 99, background: "var(--bg-active)", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${Math.max(ahead > 0 ? 8 : 0, v * 100)}%`, borderRadius: 99, background: `linear-gradient(90deg, color-mix(in srgb, ${color} 60%, transparent), ${color})`, transition: "width var(--dur-3) var(--ease-out)" }} />
      </div>
    </div>
  );
}

/* ---------- ConflictBadge ---------- */
export function ConflictBadge({ count, size = "md" }: { count: number; size?: Size }) {
  if (!count) return null;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4, height: size === "sm" ? 19 : 21,
      padding: "0 7px", borderRadius: "var(--r-full)", fontSize: "var(--fs-12)", fontWeight: "var(--fw-semibold)",
      color: "var(--conflict-text)", background: "var(--conflict-soft)", border: "1px solid var(--conflict-border)",
    }}>
      <Icon name="alertTriangle" size={12} strokeWidth={2} />
      {count} {count === 1 ? "conflict" : "conflicts"}
    </span>
  );
}

/* ---------- CopyButton ---------- */
export function CopyButton({
  value, label, className = "btn btn-sm", iconOnly = false, title = "Copy",
}: { value: string; label?: string; className?: string; iconOnly?: boolean; title?: string }) {
  const [done, setDone] = useState(false);
  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await copyText(value);
    setDone(true);
    showToast({ kind: "ok", title: "Copied to clipboard", desc: value });
    setTimeout(() => setDone(false), 1400);
  };
  return (
    <button className={className + " fr"} onClick={onClick} data-tip={title} data-tip-side="bottom" aria-label={title} style={iconOnly ? { width: 28, padding: 0 } : undefined}>
      <Icon name={done ? "check" : "copy"} size={13} style={{ color: done ? "var(--clean-text)" : undefined }} />
      {!iconOnly && (label || "Copy")}
    </button>
  );
}

/* ---------- StatCounter ---------- */
export function StatCounter({
  label, value, tone = "default", icon, onClick, active,
}: { label: string; value: ReactNode; tone?: "default" | "accent" | "conflict" | "ready"; icon?: ReactNode; onClick?: () => void; active?: boolean }) {
  const toneColor = { default: "var(--text-primary)", accent: "var(--accent-text)", conflict: "var(--conflict-text)", ready: "var(--ready-text)" }[tone];
  const Comp: any = onClick ? "button" : "div";
  return (
    <Comp className={onClick ? "fr" : ""} onClick={onClick} style={{
      display: "inline-flex", alignItems: "center", gap: 7, height: 32, padding: "0 10px",
      borderRadius: "var(--r-sm)", border: "1px solid transparent", background: active ? "var(--bg-active)" : "transparent",
      cursor: onClick ? "pointer" : "default", fontFamily: "inherit", transition: "background var(--dur-1)",
    }}
      onMouseEnter={onClick ? (e: React.MouseEvent<HTMLElement>) => { if (!active) e.currentTarget.style.background = "var(--bg-hover)"; } : undefined}
      onMouseLeave={onClick ? (e: React.MouseEvent<HTMLElement>) => { if (!active) e.currentTarget.style.background = "transparent"; } : undefined}>
      {icon && <span style={{ color: tone === "conflict" ? "var(--conflict)" : tone === "ready" ? "var(--ready)" : "var(--text-tertiary)", display: "grid" }}>{icon}</span>}
      <span className="mono" style={{ fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)", color: toneColor, letterSpacing: "-0.02em" }}>{value}</span>
      <span style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>{label}</span>
    </Comp>
  );
}

/* ---------- ApiDot ---------- */
export function ApiDot({ state, lastUpdated, onRefresh }: { state: "online" | "fetching" | "offline"; lastUpdated: number | null; onRefresh: () => void }) {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => { const t = setInterval(force, 1000); return () => clearInterval(t); }, []);
  const meta = ({ online: { c: "var(--clean)", t: "Connected" }, fetching: { c: "var(--accent)", t: "Syncing…" }, offline: { c: "var(--conflict)", t: "Offline" } } as const)[state] || { c: "var(--idle)", t: "—" };
  const ago = lastUpdated ? timeAgo(lastUpdated) : "—";
  return (
    <button className="fr" onClick={onRefresh} data-tip={`${meta.t} · localhost:7077\nUpdated ${ago} — click to refresh`} data-tip-side="bottom"
      aria-label={`API ${meta.t}, updated ${ago}. Refresh`} style={{
        display: "inline-flex", alignItems: "center", gap: 7, height: 32, padding: "0 10px",
        borderRadius: "var(--r-sm)", border: "1px solid var(--border-subtle)", background: "var(--bg-surface)", cursor: "pointer",
      }}>
      <span style={{ position: "relative", width: 8, height: 8, flex: "none" }}>
        <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: meta.c, animation: state !== "offline" ? "pulse-dot 2s var(--ease-in-out) infinite" : "none" }} />
      </span>
      <span style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
        {state === "offline" ? "Offline" : <>updated <span className="mono">{ago === "just now" ? "0s" : timeAgoShort(lastUpdated)}</span></>}
      </span>
    </button>
  );
}

/* ---------- Skeletons ---------- */
export function SkelLine({ w = "100%", h = 10, style }: { w?: number | string; h?: number; style?: CSSProperties }) {
  return <div className="skeleton" style={{ width: w, height: h, ...style }} />;
}
export function CardSkeleton() {
  return (
    <div className="card" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <SkelLine w={120} h={11} /><SkelLine w={48} h={18} style={{ borderRadius: 99 }} />
      </div>
      <SkelLine w="88%" h={13} /><SkelLine w="60%" h={13} />
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <SkelLine w={54} h={20} style={{ borderRadius: 6 }} /><SkelLine w={40} h={20} style={{ borderRadius: 6 }} />
      </div>
      <SkelLine w="100%" h={4} style={{ borderRadius: 99 }} />
    </div>
  );
}

/* ---------- CommandLine ---------- */
export function CommandLine({ command, prompt = "$" }: { command: string; prompt?: string }) {
  const [done, setDone] = useState(false);
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 10, padding: "9px 9px 9px 14px", borderRadius: "var(--r-md)", background: "var(--bg-base)", border: "1px solid var(--border-default)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-13)", maxWidth: "100%" }}>
      <span style={{ color: "var(--text-quaternary)", userSelect: "none" }}>{prompt}</span>
      <span style={{ color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{command}</span>
      <button className="btn btn-sm fr" style={{ height: 26, flex: "none" }} onClick={async () => { await copyText(command); setDone(true); showToast({ kind: "ok", title: "Command copied" }); setTimeout(() => setDone(false), 1400); }} aria-label="Copy command">
        <Icon name={done ? "check" : "copy"} size={12} style={{ color: done ? "var(--clean-text)" : undefined }} />
      </button>
    </div>
  );
}

/* ---------- EmptyState ---------- */
export function EmptyState({
  icon = "inbox", title, desc, command, action,
}: { icon?: IconName; title: string; desc?: ReactNode; command?: string; action?: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "56px 24px", gap: 14, minHeight: 240 }}>
      <div style={{ width: 52, height: 52, borderRadius: 14, display: "grid", placeItems: "center", background: "var(--bg-surface-2)", border: "1px solid var(--border-subtle)", color: "var(--text-tertiary)" }}>
        <Icon name={icon} size={24} strokeWidth={1.6} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5, maxWidth: 380 }}>
        <h3 style={{ margin: 0, fontSize: "var(--fs-15)", fontWeight: "var(--fw-semibold)", color: "var(--text-primary)" }}>{title}</h3>
        {desc && <p style={{ margin: 0, fontSize: "var(--fs-13)", color: "var(--text-tertiary)", lineHeight: "var(--lh-snug)" }}>{desc}</p>}
      </div>
      {command && <CommandLine command={command} />}
      {action}
    </div>
  );
}

/* ---------- ErrorState ---------- */
export function ErrorState({
  title = "Can't reach Baton", desc, command = "baton serve", onRetry, retrying,
}: { title?: string; desc?: ReactNode; command?: string; onRetry?: () => void; retrying?: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "56px 24px", gap: 16, minHeight: 280 }}>
      <div style={{ width: 56, height: 56, borderRadius: 16, display: "grid", placeItems: "center", background: "var(--conflict-soft)", border: "1px solid var(--conflict-border)", color: "var(--conflict)" }}>
        <Icon name="wifiOff" size={26} strokeWidth={1.7} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 420 }}>
        <h3 style={{ margin: 0, fontSize: "var(--fs-16)", fontWeight: "var(--fw-semibold)" }}>{title}</h3>
        <p style={{ margin: 0, fontSize: "var(--fs-13)", color: "var(--text-tertiary)", lineHeight: "var(--lh-snug)" }}>
          {desc || <>The local API isn't responding on <span className="mono">localhost:7077</span>. Start the daemon, then retry.</>}
        </p>
      </div>
      <CommandLine command={command} />
      {onRetry && (
        <button className="btn btn-primary fr" onClick={onRetry} disabled={retrying}>
          <Icon name="refresh" size={14} style={{ animation: retrying ? "spin 0.8s linear infinite" : "none" }} />
          {retrying ? "Retrying…" : "Retry connection"}
        </button>
      )}
    </div>
  );
}

/* ---------- SegmentedControl ---------- */
export interface SegOption<T extends string> { value: T; label: string; icon?: IconName; tip?: string }
export function SegmentedControl<T extends string>({
  options, value, onChange, size = "md", ariaLabel,
}: { options: SegOption<T>[]; value: T; onChange: (v: T) => void; size?: Size; ariaLabel?: string }) {
  const h = size === "sm" ? 28 : 32;
  return (
    <div role="tablist" aria-label={ariaLabel} style={{ display: "inline-flex", padding: 3, gap: 2, background: "var(--bg-surface-2)", border: "1px solid var(--border-subtle)", borderRadius: "var(--r-md)" }}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button key={o.value} role="tab" aria-selected={active} className="fr" onClick={() => onChange(o.value)} data-tip={o.tip} style={{
            display: "inline-flex", alignItems: "center", gap: 6, height: h - 6, padding: "0 11px",
            border: "none", borderRadius: "var(--r-sm)", cursor: "pointer", fontSize: "var(--fs-13)", fontWeight: "var(--fw-medium)", fontFamily: "inherit",
            color: active ? "var(--text-primary)" : "var(--text-tertiary)", background: active ? "var(--bg-elevated)" : "transparent",
            boxShadow: active ? "var(--shadow-xs)" : "none", transition: "color var(--dur-1), background var(--dur-1)",
          }}>
            {o.icon && <Icon name={o.icon} size={15} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ---------- Switch ---------- */
export function Switch({ checked, onChange, label, id }: { checked: boolean; onChange: (v: boolean) => void; label?: string; id?: string }) {
  return (
    <button role="switch" aria-checked={checked} aria-label={label} id={id} className="fr" onClick={() => onChange(!checked)}
      style={{ width: 38, height: 22, borderRadius: 99, border: "1px solid", flex: "none", cursor: "pointer", padding: 0, position: "relative", background: checked ? "var(--accent)" : "var(--bg-active)", borderColor: checked ? "transparent" : "var(--border-default)", transition: "background var(--dur-2)" }}>
      <span style={{ position: "absolute", top: 2, left: checked ? 18 : 2, width: 16, height: 16, borderRadius: 99, background: "#fff", boxShadow: "var(--shadow-sm)", transition: "left var(--dur-2) var(--ease-out)" }} />
    </button>
  );
}

/* ---------- ComingSoon ---------- */
export function ComingSoon({ children, tip }: { children?: ReactNode; tip?: string }) {
  return (
    <span data-tip={tip || "Not available yet — Baton doesn't expose this from the API today."} style={{
      display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, fontWeight: "var(--fw-semibold)",
      letterSpacing: "var(--ls-caps)", textTransform: "uppercase", color: "var(--text-tertiary)",
      background: "var(--bg-surface-2)", border: "1px dashed var(--border-default)", borderRadius: 99, padding: "2px 7px",
    }}>{children || "Coming soon"}</span>
  );
}

/* ---------- Sheet (focus-trapped drawer) ---------- */
export function Sheet({
  open, onClose, children, labelledBy, side = "right", width = 460,
}: { open: boolean; onClose: () => void; children: ReactNode; labelledBy?: string; side?: "right" | "bottom"; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<Element | null>(null);
  useEffect(() => {
    if (!open) return;
    lastFocus.current = document.activeElement;
    const el = ref.current!;
    const focusable = () => el.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])');
    const first = focusable()[0];
    if (first) setTimeout(() => first.focus(), 40);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
      if (e.key === "Tab") {
        const f = Array.from(focusable()); if (!f.length) return;
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); (lastFocus.current as HTMLElement)?.focus?.(); };
  }, [open, onClose]);
  if (!open) return null;
  const isMobile = window.matchMedia("(max-width: 720px)").matches;
  const mobile = isMobile || side === "bottom";
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: "var(--z-sheet)" as unknown as number }}>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "var(--bg-scrim)", backdropFilter: "blur(2px)", animation: "fade-in var(--dur-2) var(--ease-out)" }} />
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={labelledBy} style={{
        position: "absolute", background: "var(--bg-surface)", boxShadow: "var(--shadow-xl)", display: "flex", flexDirection: "column", overflow: "hidden",
        ...(mobile
          ? { left: 0, right: 0, bottom: 0, maxHeight: "92vh", borderTopLeftRadius: 18, borderTopRightRadius: 18, borderTop: "1px solid var(--border-strong)", animation: "sheet-in-bottom var(--dur-3) var(--ease-out)" }
          : { top: 0, right: 0, bottom: 0, width: Math.min(width, window.innerWidth - 40), borderLeft: "1px solid var(--border-strong)", animation: "sheet-in-right var(--dur-3) var(--ease-out)" }),
      }}>
        {children}
      </div>
    </div>
  );
}

/* ---------- ConfirmDialog ---------- */
export function ConfirmDialog({
  open, onClose, onConfirm, title, body, confirmLabel = "Confirm", tone = "default", icon, busy,
}: { open: boolean; onClose: () => void; onConfirm: () => void; title?: ReactNode; body?: ReactNode; confirmLabel?: string; tone?: "default" | "danger" | "warn"; icon?: IconName; busy?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current!;
    const f = () => el.querySelectorAll<HTMLElement>('button:not([disabled]),[tabindex]:not([tabindex="-1"])');
    setTimeout(() => { const b = el.querySelector<HTMLElement>("[data-autofocus]"); (b || f()[0])?.focus(); }, 40);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      if (e.key === "Tab") {
        const list = Array.from(f()); if (!list.length) return;
        const i = list.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); list[list.length - 1].focus(); }
        else if (!e.shiftKey && i === list.length - 1) { e.preventDefault(); list[0].focus(); }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); prev?.focus?.(); };
  }, [open, onClose]);
  if (!open) return null;
  const accent = tone === "danger" ? "var(--conflict)" : tone === "warn" ? "var(--dirty)" : "var(--accent)";
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: "var(--z-overlay)" as unknown as number, display: "grid", placeItems: "center", padding: 20 }}>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "var(--bg-scrim)", backdropFilter: "blur(2px)", animation: "fade-in var(--dur-2)" }} />
      <div ref={ref} role="alertdialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined} style={{
        position: "relative", width: "min(440px, 100%)", background: "var(--bg-elevated)", border: "1px solid var(--border-strong)", borderRadius: "var(--r-xl)", boxShadow: "var(--shadow-xl)", padding: 22, animation: "scale-in var(--dur-2) var(--ease-out)", display: "flex", flexDirection: "column", gap: 14,
      }}>
        <div style={{ display: "flex", gap: 13, alignItems: "flex-start" }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, flex: "none", display: "grid", placeItems: "center", background: `color-mix(in srgb, ${accent} 14%, transparent)`, border: `1px solid color-mix(in srgb, ${accent} 34%, transparent)`, color: accent }}>
            <Icon name={icon || (tone === "danger" ? "alertTriangle" : "gitMerge")} size={19} />
          </div>
          <div style={{ flex: 1, paddingTop: 1 }}>
            <h3 style={{ margin: 0, fontSize: "var(--fs-16)", fontWeight: "var(--fw-semibold)" }}>{title}</h3>
            <div style={{ marginTop: 6, fontSize: "var(--fs-13)", color: "var(--text-secondary)", lineHeight: "var(--lh-snug)" }}>{body}</div>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 9, marginTop: 2 }}>
          <button className="btn fr" onClick={onClose} disabled={busy}>Cancel</button>
          <button data-autofocus className={"btn fr " + (tone === "danger" ? "btn-danger" : "btn-primary")} onClick={onConfirm} disabled={busy}>
            {busy && <Icon name="refresh" size={13} style={{ animation: "spin 0.8s linear infinite" }} />}
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
