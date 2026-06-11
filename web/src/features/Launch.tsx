/* ============================================================
   BATON — Launch session (animated) (ported from launch.jsx)
   Creating the worktree + branch is REAL (POST /api/tasks); the
   "attaching agent" step is a labelled preview — you start the
   agent in the worktree yourself.
   ============================================================ */
import { useState, useRef, useEffect, useMemo, type CSSProperties } from "react";
import { Icon, type IconName } from "../components/Icon";
import { AgentBadge } from "../components/primitives";
import { AGENT_REGISTRY, AgentGlyph, getAgent } from "../lib/registry";
import { BatonAPI } from "../lib/api";
import { showToast } from "../lib/toast";
import type { AgentId, RoutingSuggestion } from "../types";

type Phase = "form" | "provisioning" | "done";

export function LaunchSession({
  initialAgent, onClose, writeEnabled, onLaunched,
}: {
  initialAgent: AgentId | null;
  onClose: () => void;
  writeEnabled: boolean;
  onLaunched: (slug: string) => void;
}) {
  const [agent, setAgent] = useState<AgentId>(initialAgent || "claude");
  const [task, setTask] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [step, setStep] = useState(-1);
  const [suggestion, setSuggestion] = useState<RoutingSuggestion | null>(null);
  const [headlessStart, setHeadlessStart] = useState(false);
  const userPickedAgent = useRef(initialAgent !== null);
  const HEADLESS = ["claude", "codex", "gemini"];
  const taskRef = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true);

  // Routing suggestion while typing (debounced). Never overrides an explicit pick.
  useEffect(() => {
    if (task.trim().length < 4) { setSuggestion(null); return; }
    const t = setTimeout(() => {
      BatonAPI.getRouting(task.trim()).then((r) => {
        if (alive.current) setSuggestion(r.suggestion);
      }).catch(() => undefined);
    }, 400);
    return () => clearTimeout(t);
  }, [task]);
  const a = getAgent(agent);
  const slug = useMemo(() => BatonAPI.slugify(task || ""), [task]);
  const valid = task.trim().length >= 3;

  useEffect(() => {
    alive.current = true;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && phase === "form") { e.preventDefault(); onClose(); } };
    document.addEventListener("keydown", onKey, true);
    setTimeout(() => taskRef.current?.focus(), 60);
    return () => { alive.current = false; document.removeEventListener("keydown", onKey, true); prev?.focus?.(); };
  }, [onClose, phase]);

  const willStart = headlessStart && writeEnabled && HEADLESS.includes(agent);
  const steps: { label: string; sub: string; icon: IconName }[] = [
    { label: "Creating isolated worktree", sub: `.baton/wt/${slug}`, icon: "folder" },
    { label: "Checking out branch", sub: `baton/${slug}`, icon: "gitBranch" },
    willStart
      ? { label: `Starting ${a.short} (headless)`, sub: "agent runs the task in the worktree", icon: "bot" }
      : { label: `Attaching ${a.short}`, sub: "agent ready to work", icon: "bot" },
  ];

  const launch = async () => {
    if (!valid) return;
    setPhase("provisioning"); setStep(0);
    const apiP = BatonAPI.launchSession({ task: task.trim(), agent }).then(
      (r) => ({ ok: true as const, r }),
      (e: Error) => ({ ok: false as const, e }),
    );
    for (let i = 0; i < steps.length; i++) {
      await new Promise((r) => setTimeout(r, 620));
      if (!alive.current) return;
      setStep(i + 1);
    }
    const res = await apiP;
    if (!alive.current) return;
    if (!res.ok) { showToast({ kind: "error", title: "Launch failed", desc: res.e.message }); setPhase("form"); setStep(-1); return; }
    if (willStart) {
      try {
        await BatonAPI.startAgentRun(res.r.slug, { agent });
        showToast({ kind: "ok", title: `${a.short} running headless`, desc: "Watch it on the Live screen", mono: false });
      } catch (e) {
        showToast({ kind: "error", title: `${a.short} could not start`, desc: (e as Error).message });
      }
    }
    setPhase("done");
    await new Promise((r) => setTimeout(r, 850));
    if (!alive.current) return;
    if (!willStart) showToast({ kind: "ok", title: `${a.short} session created`, desc: `baton/${res.r.slug}`, mono: true });
    onLaunched(res.r.slug);
    onClose();
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: "var(--z-overlay)" as unknown as number, display: "grid", placeItems: "center", padding: 20 }}>
      <div onClick={() => phase === "form" && onClose()} style={{ position: "absolute", inset: 0, background: "var(--bg-scrim)", backdropFilter: "blur(3px)", animation: "fade-in var(--dur-2)" }} />
      <div role="dialog" aria-modal="true" aria-label="Launch session" style={{
        position: "relative", width: "min(520px, 100%)", maxHeight: "92vh", overflowY: "auto", background: "var(--bg-elevated)",
        border: "1px solid var(--border-strong)", borderRadius: "var(--r-xl)", boxShadow: "var(--shadow-xl)", animation: "scale-in var(--dur-2) var(--ease-out)" }}>

        <div style={{ padding: "18px 20px 16px", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 11, background: `linear-gradient(180deg, color-mix(in srgb, ${a.color} 10%, transparent), transparent)` }}>
          <span style={{ width: 38, height: 38, borderRadius: 11, flex: "none", display: "grid", placeItems: "center", background: `color-mix(in srgb, ${a.color} 16%, transparent)`, border: `1px solid color-mix(in srgb, ${a.color} 38%, transparent)`, transition: "background var(--dur-2)" }}>
            <AgentGlyph id={agent} size={20} />
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: "var(--fs-16)", fontWeight: "var(--fw-semibold)" }}>Launch session</h2>
              {!willStart && <span style={{ fontSize: 10, fontWeight: "var(--fw-semibold)", letterSpacing: "var(--ls-caps)", textTransform: "uppercase", color: "var(--text-tertiary)", background: "var(--bg-surface-2)", border: "1px dashed var(--border-default)", borderRadius: 99, padding: "2px 7px" }} data-tip="The worktree is created for real; tick 'Start headless' below (write mode) to also run the agent for real.">Preview</span>}
            </div>
            <p style={{ margin: "3px 0 0", fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>Spin up an isolated worktree + branch for an agent.</p>
          </div>
          {phase === "form" && <button className="btn btn-ghost btn-icon fr" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>}
        </div>

        {phase === "form" ? (
          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 18 }}>
            <div>
              <div className="tag" style={{ marginBottom: 8 }}>Agent</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(132px, 1fr))", gap: 8 }}>
                {AGENT_REGISTRY.map((ag) => {
                  const on = agent === ag.id;
                  return (
                    <button key={ag.id} className="fr" onClick={() => { userPickedAgent.current = true; setAgent(ag.id as AgentId); }} aria-pressed={on} style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 11px", borderRadius: "var(--r-md)", cursor: "pointer", textAlign: "left", background: on ? `color-mix(in srgb, ${ag.color} 14%, transparent)` : "var(--bg-surface)", border: `1px solid ${on ? `color-mix(in srgb, ${ag.color} 45%, transparent)` : "var(--border-subtle)"}`, boxShadow: on ? `0 0 0 1px color-mix(in srgb, ${ag.color} 30%, transparent) inset` : "none", transition: "border-color var(--dur-1), background var(--dur-1)" }}>
                      <AgentBadge id={ag.id} size="sm" showLabel={false} />
                      <span style={{ flex: 1, fontSize: "var(--fs-13)", fontWeight: "var(--fw-medium)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ag.short}</span>
                      {on && <Icon name="check" size={14} style={{ color: ag.color, flex: "none" }} />}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="tag" style={{ marginBottom: 8 }}>Task</div>
              <textarea ref={taskRef} value={task} onChange={(e) => setTask(e.target.value)} rows={2} placeholder="e.g. Add OAuth sign-in with Google"
                onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") launch(); }}
                style={{ width: "100%", resize: "vertical", padding: "10px 12px", background: "var(--bg-input)", border: "1px solid var(--border-default)", borderRadius: "var(--r-sm)", color: "var(--text-primary)", fontSize: "var(--fs-14)", fontFamily: "inherit", lineHeight: 1.5, outline: "none" }} />
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: "var(--fs-12)", color: "var(--text-tertiary)", flexWrap: "wrap" }}>
                <Icon name="gitBranch" size={13} style={{ color: "var(--text-quaternary)" }} />
                <span>branches from <span className="mono" style={{ color: "var(--text-secondary)" }}>main</span> →</span>
                <span className="mono" style={{ color: valid ? "var(--accent-text)" : "var(--text-quaternary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>baton/{valid ? slug : "…"}</span>
              </div>
              {writeEnabled && HEADLESS.includes(agent) && (
                <label style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 10, cursor: "pointer", fontSize: "var(--fs-13)", color: "var(--text-secondary)" }}>
                  <input type="checkbox" checked={headlessStart} onChange={(e) => setHeadlessStart(e.target.checked)} style={{ accentColor: "var(--accent)" }} />
                  Start {a.short} headless after create <span style={{ color: "var(--text-quaternary)", fontSize: "var(--fs-12)" }}>· runs the task non-interactively, output on the Live screen</span>
                </label>
              )}
              {suggestion && suggestion.source === "rule" && suggestion.agent !== agent && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: "var(--fs-12)", color: "var(--text-secondary)", padding: "7px 10px", borderRadius: "var(--r-sm)", background: "var(--accent-soft)", border: "1px dashed var(--accent-border)" }}>
                  <Icon name="sparkle" size={13} style={{ color: "var(--accent)", flex: "none" }} />
                  <span style={{ flex: 1 }}>
                    Routing suggests <b>{getAgent(suggestion.agent as AgentId).short}</b>{suggestion.model ? ` (${suggestion.model})` : ""} — matched '{suggestion.matched[0]}'
                  </span>
                  <button className="btn btn-sm fr" onClick={() => setAgent(suggestion.agent as AgentId)} style={{ height: 24 }}>Use it</button>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div style={{ padding: "26px 24px 24px", display: "flex", flexDirection: "column", gap: 4 }}>
            {phase === "done" ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "16px 0 8px", textAlign: "center", animation: "fade-up var(--dur-3) var(--ease-out)" }}>
                <span style={{ width: 56, height: 56, borderRadius: 99, display: "grid", placeItems: "center", background: "var(--clean-soft)", border: "1px solid var(--clean-border)", color: "var(--clean)", animation: "pop-check var(--dur-3) var(--ease-spring)" }}>
                  <Icon name="check" size={28} strokeWidth={2.4} />
                </span>
                <div>
                  <div style={{ fontSize: "var(--fs-16)", fontWeight: "var(--fw-semibold)" }}>Session ready</div>
                  <div className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)", marginTop: 3 }}>baton/{slug}</div>
                </div>
              </div>
            ) : (
              <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 0 }}>
                {steps.map((s, i) => {
                  const done = step > i; const activeStep = step === i;
                  return (
                    <li key={i} style={{ display: "flex", gap: 13, alignItems: "flex-start" }}>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", alignSelf: "stretch" }}>
                        <span style={{ width: 28, height: 28, borderRadius: 99, flex: "none", display: "grid", placeItems: "center", transition: "all var(--dur-2)", background: done ? `color-mix(in srgb, ${a.color} 18%, transparent)` : activeStep ? "var(--bg-surface)" : "var(--bg-surface-2)", border: `1.5px solid ${done ? a.color : activeStep ? "var(--border-strong)" : "var(--border-subtle)"}`, color: done ? a.color : activeStep ? "var(--text-primary)" : "var(--text-quaternary)" } as CSSProperties}>
                          {done ? <span style={{ animation: "pop-check var(--dur-2) var(--ease-spring)", display: "grid" }}><Icon name="check" size={15} strokeWidth={2.6} /></span>
                            : activeStep ? <span style={{ width: 14, height: 14, borderRadius: 99, border: "2px solid var(--border-default)", borderTopColor: a.color, animation: "spin 0.7s linear infinite" }} />
                            : <Icon name={s.icon} size={14} />}
                        </span>
                        {i < steps.length - 1 && <span style={{ width: 1.5, flex: 1, minHeight: 18, background: done ? a.color : "var(--border-subtle)", transition: "background var(--dur-3)", marginTop: 2, marginBottom: 2 }} />}
                      </div>
                      <div style={{ paddingTop: 4, paddingBottom: 14, flex: 1, minWidth: 0, opacity: activeStep || done ? 1 : 0.5, transition: "opacity var(--dur-2)" }}>
                        <div style={{ fontSize: "var(--fs-14)", fontWeight: "var(--fw-medium)", color: done ? "var(--text-secondary)" : "var(--text-primary)" }}>{s.label}</div>
                        <div className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.sub}</div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        )}

        {phase === "form" && (
          <div style={{ padding: "12px 20px", borderTop: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ flex: 1, fontSize: "var(--fs-12)", color: "var(--text-quaternary)", display: "flex", alignItems: "center", gap: 5 }}><span className="kbd">⌘</span><span className="kbd">↵</span> to launch{!writeEnabled && <span style={{ color: "var(--text-tertiary)", marginLeft: 6 }}>· agent attach is preview</span>}</span>
            <button className="btn fr" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary fr" disabled={!valid} onClick={launch} data-tip={!valid ? "Describe the task first" : undefined} style={!valid ? { opacity: 0.55, cursor: "not-allowed" } : {}}>
              <Icon name="zap" size={14} /> Launch
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
