// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — shared screen chrome (ported from insights.jsx)
   ScreenHeader · SearchInput · AgentFilter · isSettled
   ============================================================ */
import type { ReactNode } from "react";
import { Icon } from "../components/Icon";
import { getAgent, AgentGlyph } from "../lib/registry";
import type { AgentId, EditSignal } from "../types";

/**
 * A path nobody holds any more: every holder has committed or reverted. Kept on
 * the board for a few minutes as "just finished" rather than vanishing the moment
 * someone commits (ISS-15). An older daemon omits `state` — treat that as active.
 */
export const isSettled = (s: EditSignal) => s.holders.length > 0 && s.holders.every((h) => h.state === "settled");

export function ScreenHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <div style={{ padding: "16px 20px 14px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", borderBottom: "1px solid var(--border-subtle)" }}>
      <div style={{ flex: "1 1 auto", minWidth: 0 }}>
        <h1 style={{ margin: 0, fontSize: "var(--fs-18)", fontWeight: "var(--fw-semibold)", letterSpacing: "var(--ls-tight)" }}>{title}</h1>
        {subtitle && <p style={{ margin: "3px 0 0", fontSize: "var(--fs-13)", color: "var(--text-tertiary)" }}>{subtitle}</p>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>{children}</div>
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7, height: 32, padding: "0 10px", minWidth: 200, background: "var(--bg-input)", border: "1px solid var(--border-default)", borderRadius: "var(--r-sm)" }}>
      <Icon name="search" size={14} style={{ color: "var(--text-tertiary)", flex: "none" }} />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder}
        style={{ flex: 1, border: "none", background: "transparent", color: "var(--text-primary)", fontSize: "var(--fs-13)", outline: "none", minWidth: 0 }} />
      {value && <button className="fr" onClick={() => onChange("")} aria-label="Clear" style={{ border: "none", background: "none", color: "var(--text-tertiary)", cursor: "pointer", display: "grid", padding: 2, borderRadius: 4 }}><Icon name="x" size={13} /></button>}
    </div>
  );
}

export function AgentFilter({ agents, value, onChange }: { agents: AgentId[]; value: AgentId | null; onChange: (v: AgentId | null) => void }) {
  return (
    <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
      <button className="chip fr" aria-pressed={!value} onClick={() => onChange(null)} style={{ cursor: "pointer", background: !value ? "var(--accent-soft)" : "var(--bg-surface-2)", borderColor: !value ? "var(--accent-border)" : "var(--border-default)", color: !value ? "var(--accent-text)" : "var(--text-secondary)" }}>All</button>
      {agents.map((id) => {
        const a = getAgent(id); const on = value === id;
        return (
          <button key={id} className="chip fr" aria-pressed={on} onClick={() => onChange(on ? null : id)} style={{ cursor: "pointer", background: on ? `color-mix(in srgb, ${a.color} 16%, transparent)` : "var(--bg-surface-2)", borderColor: on ? `color-mix(in srgb, ${a.color} 40%, transparent)` : "var(--border-default)", color: "var(--text-primary)" }}>
            <AgentGlyph id={id} size={12} /> {a.short}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A mono, letter-spaced micro-label — the Skills screen's one structural device.
 *
 * Used only where it labels a genuinely different KIND of information (what a
 * skill is, what it leaves behind, what it ships, which agents hold it). Not
 * decoration: if two blocks would carry the same label, they should be one
 * block instead.
 */
export function Label({ children, tone }: { children: ReactNode; tone?: "accent" | "quiet" }) {
  return (
    <span style={{
      fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.11em", textTransform: "uppercase",
      fontWeight: "var(--fw-semibold)", lineHeight: 1.4,
      color: tone === "accent" ? "var(--clean-text)" : "var(--text-quaternary)",
    }}>{children}</span>
  );
}

/** Hairline that fills the remaining space on a label row. */
export const rule: React.CSSProperties = { flex: 1, height: 1, background: "var(--border-subtle)" };
