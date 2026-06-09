/* ============================================================
   BATON — shared screen chrome (ported from insights.jsx)
   ScreenHeader · SearchInput · AgentFilter
   ============================================================ */
import type { ReactNode } from "react";
import { Icon } from "../components/Icon";
import { getAgent, AgentGlyph } from "../lib/registry";
import type { AgentId } from "../types";

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
