/* ============================================================
   BATON — Context-pack modal ("Share context")
   Fetches /api/kb/context?format=json and offers Copy / Download —
   a paste-able project brief for external chatbots.
   ============================================================ */
import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { CopyButton } from "../components/primitives";
import { BatonAPI } from "../lib/api";
import type { ContextPackResponse } from "../types";

export function ContextPackModal({ project, onClose }: { project: string | null; onClose: () => void }) {
  const [pack, setPack] = useState<ContextPackResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<Element | null>(null);

  useEffect(() => {
    let cancelled = false;
    BatonAPI.getKbContext(project ?? undefined)
      .then((p) => { if (!cancelled) setPack(p); })
      .catch((e) => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [project]);

  useEffect(() => {
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
  }, [onClose]);

  const download = () => {
    if (!pack) return;
    const blob = new Blob([pack.markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${project ?? "hub"}-context.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Share context"
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 60, background: "var(--bg-scrim)", display: "grid", placeItems: "center", padding: 24 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: "min(760px, 100%)", maxHeight: "84vh", display: "flex", flexDirection: "column", gap: 12, background: "var(--bg-surface)", border: "1px solid var(--border-default)", borderRadius: 14, padding: 18, boxShadow: "0 24px 64px rgba(0,0,0,.35)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Icon name="share" size={16} />
          <div style={{ fontWeight: "var(--fw-semibold)" }}>Share context</div>
          <div style={{ flex: 1 }} />
          <button className="btn btn-sm fr" onClick={onClose} aria-label="Close"><Icon name="x" size={14} /></button>
        </div>
        <div style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}>
          A paste-able brief of this project for any chatbot (ChatGPT, Grok, DeepSeek…) — no source code included.
        </div>
        {error && <div style={{ color: "var(--conflict-text)", fontSize: "var(--fs-12)" }}>{error}</div>}
        {!pack && !error && <div className="skeleton" style={{ height: 220, borderRadius: 10 }} />}
        {pack && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}>
                ~{pack.tokens.toLocaleString()} tokens
              </span>
              {pack.fits.map((f) => (
                <span key={f.id} style={{
                  display: "inline-flex", alignItems: "center", gap: 4, height: 20, padding: "0 8px",
                  borderRadius: "var(--r-full)", fontSize: "var(--fs-12)",
                  color: f.ok ? "var(--clean-text)" : "var(--text-tertiary)",
                  background: f.ok ? "var(--clean-soft)" : "var(--bg-active)",
                  border: `1px solid ${f.ok ? "var(--clean-border)" : "var(--border-subtle)"}`,
                }}>
                  <Icon name={f.ok ? "check" : "x"} size={11} /> {f.label}
                </span>
              ))}
            </div>
            {pack.redactions > 0 && (
              <div style={{ fontSize: "var(--fs-12)", color: "var(--conflict-text)" }}>
                ⚠️ {pack.redactions} secret-looking value{pack.redactions === 1 ? "" : "s"} redacted.
              </div>
            )}
            {pack.omitted.length > 0 && (
              <div style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>
                Trimmed to fit the budget: {pack.omitted.join(", ")}
              </div>
            )}
            <pre style={{ flex: 1, minHeight: 0, overflow: "auto", margin: 0, padding: 12, borderRadius: 10, border: "1px solid var(--border-subtle)", background: "var(--bg-base)", fontSize: "var(--fs-12)", lineHeight: 1.5, whiteSpace: "pre-wrap", userSelect: "text" }}>
              {pack.markdown}
            </pre>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn fr" onClick={download} style={{ height: 30 }}>
                <Icon name="arrowRight" size={14} style={{ transform: "rotate(90deg)" }} /> Download .md
              </button>
              <CopyButton value={pack.markdown} label="Copy markdown" className="btn btn-primary" title="Copy the whole pack" />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
