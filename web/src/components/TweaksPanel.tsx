/* ============================================================
   BATON — Tweaks panel (self-contained dev / demo affordance)
   A floating, draggable control panel echoing the design prototype's
   BatonTweaks. It flips the demo scenario (busy / calm / empty),
   simulates offline, toggles write actions, and changes
   theme / accent / motion live.

   The design's tweaks-panel.jsx was the Claude Design host's edit-mode
   panel (postMessage protocol) — unusable in a shipped app — so this is
   a standalone equivalent with its own trigger + open state, styled with
   Baton tokens so it respects the active theme.
   ============================================================ */
import { useState, useRef, useEffect, useCallback } from "react";
import { Icon } from "./Icon";
import { SegmentedControl, Switch } from "./primitives";
import { ACCENTS } from "../lib/registry";
import type { Prefs } from "../hooks/usePrefs";
import type { ScenarioName } from "../lib/demoData";

function Section({ label }: { label: string }) {
  return (
    <div style={{ fontSize: 10, fontWeight: "var(--fw-semibold)", letterSpacing: "var(--ls-caps)", textTransform: "uppercase", color: "var(--text-quaternary)", padding: "10px 0 0" }}>
      {label}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <span style={{ fontSize: "var(--fs-12)", fontWeight: "var(--fw-medium)", color: "var(--text-secondary)" }}>{label}</span>
        {children}
      </div>
      {hint && <span style={{ fontSize: 10.5, color: "var(--text-quaternary)", lineHeight: 1.4 }}>{hint}</span>}
    </div>
  );
}

const SCENARIOS: { value: ScenarioName; label: string }[] = [
  { value: "busy", label: "Busy" },
  { value: "calm", label: "Calm" },
  { value: "empty", label: "Empty" },
];

export function TweaksPanel({ prefs, scenario, setScenario, demo, setDemo }: {
  prefs: Prefs;
  scenario: ScenarioName;
  setScenario: (s: ScenarioName) => void;
  demo: boolean;
  setDemo: (v: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const pos = useRef({ x: 16, y: 16 }); // distance from right / bottom

  const place = useCallback(() => {
    const el = panelRef.current;
    if (!el) return;
    el.style.right = `${pos.current.x}px`;
    el.style.bottom = `${pos.current.y}px`;
  }, []);

  useEffect(() => { if (open) place(); }, [open, place]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const onDragStart = (e: React.MouseEvent) => {
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const startRight = window.innerWidth - r.right;
    const startBottom = window.innerHeight - r.bottom;
    const PAD = 12;
    const move = (ev: MouseEvent) => {
      const w = el.offsetWidth, h = el.offsetHeight;
      pos.current = {
        x: Math.min(Math.max(PAD, startRight - (ev.clientX - sx)), window.innerWidth - w - PAD),
        y: Math.min(Math.max(PAD, startBottom - (ev.clientY - sy)), window.innerHeight - h - PAD),
      };
      place();
    };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <>
      {/* trigger */}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Tweaks" aria-expanded={open}
        data-tip="Tweaks — demo data & appearance" data-tip-side="left"
        style={{
          position: "fixed", right: 16, bottom: 16, width: 40, height: 40, borderRadius: 99,
          display: open ? "none" : "grid", placeItems: "center", cursor: "pointer",
          background: "var(--bg-elevated)", border: "1px solid var(--border-strong)", color: "var(--text-secondary)",
          boxShadow: "var(--shadow-lg)", zIndex: "var(--z-tweaks)" as unknown as number,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-secondary)")}>
        <Icon name="settings" size={18} />
      </button>

      {open && (
        <div ref={panelRef} role="dialog" aria-label="Tweaks" style={{
          position: "fixed", right: 16, bottom: 16, width: 282, maxHeight: "calc(100vh - 32px)",
          display: "flex", flexDirection: "column", background: "var(--bg-elevated)",
          border: "1px solid var(--border-strong)", borderRadius: "var(--r-lg)", boxShadow: "var(--shadow-xl)",
          overflow: "hidden", zIndex: "var(--z-tweaks)" as unknown as number, animation: "scale-in var(--dur-2) var(--ease-out)",
        }}>
          {/* header (drag handle) */}
          <div onMouseDown={onDragStart} style={{
            display: "flex", alignItems: "center", gap: 8, padding: "10px 8px 10px 14px", cursor: "move", userSelect: "none",
            borderBottom: "1px solid var(--border-subtle)", flex: "none",
          }}>
            <Icon name="settings" size={14} style={{ color: "var(--text-tertiary)" }} />
            <b style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)" }}>Tweaks</b>
            <span className="tag" style={{ marginLeft: "auto" }}>preview</span>
            <button className="btn btn-ghost btn-icon fr" onMouseDown={(e) => e.stopPropagation()} onClick={() => setOpen(false)} aria-label="Close tweaks" style={{ width: 26, height: 26 }}>
              <Icon name="x" size={14} />
            </button>
          </div>

          <div style={{ padding: "4px 14px 14px", display: "flex", flexDirection: "column", gap: 11, overflowY: "auto", minHeight: 0 }}>
            <Section label="Demo data" />
            <Row label="Use demo data" hint={demo ? "Showing illustrative sessions — the daemon isn't queried." : "Querying the live baton serve daemon."}>
              <Switch checked={demo} onChange={setDemo} label="Use demo data" />
            </Row>
            <Row label="Scenario">
              <SegmentedControl size="sm" ariaLabel="Demo scenario" value={SCENARIOS.some((s) => s.value === scenario) ? (scenario as "busy" | "calm" | "empty") : "busy"}
                onChange={(v) => setScenario(v)} options={SCENARIOS} />
            </Row>
            <Row label="Simulate offline">
              <Switch checked={prefs.offline} onChange={prefs.setOffline} label="Simulate offline" />
            </Row>

            <Section label="Capabilities" />
            <Row label="Write actions" hint="Enables Merge & Remove.">
              <Switch checked={prefs.writeEnabled} onChange={prefs.setWriteEnabled} label="Write actions" />
            </Row>

            <Section label="Appearance" />
            <Row label="Theme">
              <SegmentedControl size="sm" ariaLabel="Theme" value={prefs.theme} onChange={prefs.setTheme}
                options={[{ value: "system", label: "Auto" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
            </Row>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: "var(--fs-12)", fontWeight: "var(--fw-medium)", color: "var(--text-secondary)" }}>Accent</span>
              <div style={{ display: "flex", gap: 6 }}>
                {ACCENTS.map((ac) => {
                  const on = prefs.accent === ac.id;
                  return (
                    <button key={ac.id} type="button" aria-label={ac.label} title={ac.label} aria-pressed={on} onClick={() => prefs.setAccent(ac.id)}
                      style={{ flex: 1, height: 26, borderRadius: 6, cursor: "pointer", background: `hsl(${ac.h} ${ac.s} ${ac.l})`, padding: 0,
                        border: "2px solid", borderColor: on ? "var(--text-primary)" : "transparent",
                        boxShadow: on ? "0 0 0 1px var(--bg-elevated)" : "0 0 0 1px var(--border-subtle)" }} />
                  );
                })}
              </div>
            </div>
            <Row label="Reduce motion">
              <Switch checked={prefs.motion === "reduce"} onChange={(v) => prefs.setMotion(v ? "reduce" : "full")} label="Reduce motion" />
            </Row>
          </div>
        </div>
      )}
    </>
  );
}
