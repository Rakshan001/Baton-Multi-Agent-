/* ============================================================
   BATON — wordmark (ported from shell.jsx)
   ============================================================ */
import { useId } from "react";

export function BatonMark({ size = 22, withWord = false }: { size?: number; withWord?: boolean }) {
  const id = useId();
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--accent-hover)" /><stop offset="1" stopColor="var(--accent-press)" />
          </linearGradient>
        </defs>
        <rect x="3.5" y="3.5" width="25" height="25" rx="8" fill={`url(#${id})`} />
        <rect x="9.2" y="14.4" width="13.6" height="3.2" rx="1.6" fill="#fff" transform="rotate(-38 16 16)" />
        <circle cx="11.4" cy="20.2" r="2.5" fill="#fff" /><circle cx="20.6" cy="11.8" r="2.5" fill="#fff" />
      </svg>
      {withWord && <span style={{ fontSize: size * 0.82, fontWeight: 700, letterSpacing: "-0.03em", color: "var(--text-primary)" }}>Baton</span>}
    </span>
  );
}
