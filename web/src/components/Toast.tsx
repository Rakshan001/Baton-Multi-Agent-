/* ============================================================
   BATON — Toast viewport (ported from primitives.jsx ToastViewport)
   ============================================================ */
import { useState, useEffect } from "react";
import { Icon, type IconName } from "./Icon";
import type { Toast } from "../lib/toast";

const META: Record<string, { icon: IconName; c: string }> = {
  ok: { icon: "checkCircle", c: "var(--clean)" },
  error: { icon: "alertOctagon", c: "var(--conflict)" },
  info: { icon: "dot", c: "var(--accent)" },
  warn: { icon: "alertTriangle", c: "var(--dirty)" },
};

export function ToastViewport() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    const onToast = (e: Event) => {
      const t = (e as CustomEvent<Toast>).detail;
      setToasts((cur) => [...cur, t]);
      const dur = t.duration || (t.kind === "error" ? 5200 : 3200);
      if (!t.sticky) setTimeout(() => setToasts((cur) => cur.filter((x) => x.id !== t.id)), dur);
    };
    window.addEventListener("baton:toast", onToast);
    return () => window.removeEventListener("baton:toast", onToast);
  }, []);
  const dismiss = (id: string) => setToasts((cur) => cur.filter((x) => x.id !== id));
  return (
    <div aria-live="polite" style={{ position: "fixed", bottom: 20, right: 20, zIndex: "var(--z-overlay)" as unknown as number, display: "flex", flexDirection: "column", gap: 10, maxWidth: 380, pointerEvents: "none" }}>
      {toasts.map((t) => {
        const m = META[t.kind || "info"] || META.info;
        return (
          <div key={t.id} role="status" style={{
            display: "flex", gap: 11, alignItems: "flex-start", padding: "12px 12px 12px 13px",
            background: "var(--bg-overlay)", border: "1px solid var(--border-strong)", borderRadius: "var(--r-md)",
            boxShadow: "var(--shadow-lg)", animation: "scale-in var(--dur-2) var(--ease-out)", pointerEvents: "auto", minWidth: 280,
          }}>
            <span style={{ color: m.c, display: "grid", marginTop: 1, flex: "none" }}><Icon name={m.icon} size={17} /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)", color: "var(--text-primary)" }}>{t.title}</div>
              {t.desc && <div className={t.mono ? "mono" : ""} style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)", marginTop: 2, wordBreak: "break-all" }}>{t.desc}</div>}
              {t.action && <button className="btn btn-sm fr" style={{ marginTop: 9 }} onClick={() => { t.action!.onClick(); dismiss(t.id); }}>{t.action.label}</button>}
            </div>
            <button className="fr" onClick={() => dismiss(t.id)} aria-label="Dismiss" style={{ background: "none", border: "none", color: "var(--text-tertiary)", cursor: "pointer", padding: 2, marginTop: -1, borderRadius: 4 }}>
              <Icon name="x" size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
