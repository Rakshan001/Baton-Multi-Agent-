/* ============================================================
   BATON — Handoff flow
   POST /api/tasks/:slug/handoff generates a HANDOFF.md brief in the
   worktree (session context + plan + graph excerpt); the receiving
   agent picks it up with `baton take`. Write-gated.
   ============================================================ */
import { useState, useRef, useEffect } from "react";
import { Icon } from "../components/Icon";
import { AgentBadge } from "../components/primitives";
import { AGENT_REGISTRY, getAgent } from "../lib/registry";
import { BatonAPI, branchFor } from "../lib/api";
import { showToast } from "../lib/toast";
import type { StatusRow, AgentId, RouteSuggestion } from "../types";

/** One-line explanation of why routing picked this agent (chip tooltip). */
function suggestionWhy(s: RouteSuggestion): string {
  switch (s.source) {
    case "rule": return `Routing rule matched: ${s.matched.join(", ")}`;
    case "severity": return `Severity ${s.severity}/100 → ${s.tier} tier`;
    case "single": return "Single-agent mode";
    default: return "Default route (baton.config.json)";
  }
}

export function HandoffDialog({
  slug, session, onClose, writeEnabled,
}: {
  slug: string;
  session?: StatusRow;
  onClose: () => void;
  writeEnabled: boolean;
}) {
  const task = session;
  const [target, setTarget] = useState<AgentId | null>(null);
  const [commitPending, setCommitPending] = useState(true);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [doneInfo, setDoneInfo] = useState<{ toAgent: AgentId; estTokens?: number; estCostUsd?: number; briefPath?: string } | null>(null);
  const [suggestion, setSuggestion] = useState<RouteSuggestion | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const hasPending = (task?.filesChanged || 0) > 0;
  const options = AGENT_REGISTRY.filter((a) => a.id !== task?.agent);

  // Routing suggestion: preselect only while the user hasn't picked anything.
  useEffect(() => {
    if (!task?.task) return;
    let on = true;
    BatonAPI.getRouting(task.task).then((r) => {
      if (!on || !r.suggestion) return;
      setSuggestion(r.suggestion);
      // Manual mode = advisory only — show the chip, never preselect.
      if (r.suggestion.mode === "manual") return;
      const valid = options.some((a) => a.id === r.suggestion!.agent);
      if (valid) setTarget((cur) => cur ?? (r.suggestion!.agent as AgentId));
    }).catch(() => undefined);
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.task]);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    document.addEventListener("keydown", onKey, true);
    setTimeout(() => ref.current?.focus(), 40);
    return () => { document.removeEventListener("keydown", onKey, true); prev?.focus?.(); };
  }, [onClose]);

  const doHandoff = async () => {
    if (!target || !writeEnabled) return;
    setBusy(true);
    try {
      const r = await BatonAPI.handoffTask(slug, { toAgent: target, commitPending: commitPending && hasPending, note: note.trim() || undefined });
      showToast({ kind: "ok", title: `Brief ready for ${getAgent(target).short}`, desc: branchFor(slug), mono: true });
      setDoneInfo({ toAgent: target, estTokens: r.estTokens, estCostUsd: r.estCostUsd, briefPath: r.briefPath });
      setBusy(false);
    } catch (e) { showToast({ kind: "error", title: "Handoff failed", desc: (e as Error).message }); setBusy(false); }
  };

  if (doneInfo) {
    const wt = doneInfo.briefPath?.replace(/\/HANDOFF\.md$/, "") ?? "";
    return (
      <div style={{ position: "fixed", inset: 0, zIndex: "var(--z-overlay)" as unknown as number, display: "grid", placeItems: "center", padding: 20 }}>
        <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "var(--bg-scrim)", backdropFilter: "blur(3px)", animation: "fade-in var(--dur-2)" }} />
        <div role="dialog" aria-modal="true" aria-label="Handoff brief ready" style={{ position: "relative", width: "min(520px, 100%)", background: "var(--bg-elevated)", border: "1px solid var(--border-strong)", borderRadius: "var(--r-xl)", boxShadow: "var(--shadow-xl)", animation: "scale-in var(--dur-2) var(--ease-out)", padding: 22 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <span style={{ width: 36, height: 36, borderRadius: 10, display: "grid", placeItems: "center", background: "var(--clean-soft)", border: "1px solid var(--clean-border)", color: "var(--clean-text)" }}><Icon name="check" size={18} /></span>
            <div>
              <h2 style={{ margin: 0, fontSize: "var(--fs-16)", fontWeight: "var(--fw-semibold)" }}>HANDOFF.md is ready</h2>
              <p style={{ margin: "2px 0 0", fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>
                For <AgentBadge id={doneInfo.toAgent} size="sm" />{typeof doneInfo.estTokens === "number" && doneInfo.estTokens > 0 ? <> · condensed from ≈{doneInfo.estTokens.toLocaleString()} tokens of session</> : null}
              </p>
            </div>
          </div>
          <div className="tag" style={{ marginBottom: 8 }}>Start the next agent with</div>
          <pre className="mono" style={{ margin: 0, padding: "10px 12px", background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: "var(--r-md)", fontSize: "var(--fs-12)", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{`cd ${wt}\nbaton take ${slug}`}</pre>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
            <button className="btn btn-primary fr" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: "var(--z-overlay)" as unknown as number, display: "grid", placeItems: "center", padding: 20 }}>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "var(--bg-scrim)", backdropFilter: "blur(3px)", animation: "fade-in var(--dur-2)" }} />
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Hand off session" style={{
        position: "relative", width: "min(520px, 100%)", maxHeight: "90vh", overflowY: "auto", background: "var(--bg-elevated)",
        border: "1px solid var(--border-strong)", borderRadius: "var(--r-xl)", boxShadow: "var(--shadow-xl)", animation: "scale-in var(--dur-2) var(--ease-out)" }}>

        <div style={{ padding: "18px 20px 14px", borderBottom: "1px solid var(--border-subtle)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ width: 36, height: 36, borderRadius: 10, flex: "none", display: "grid", placeItems: "center", background: "var(--accent-soft)", border: "1px solid var(--accent-border)", color: "var(--accent-text)" }}><Icon name="share" size={18} /></span>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <h2 style={{ margin: 0, fontSize: "var(--fs-16)", fontWeight: "var(--fw-semibold)" }}>Hand off session</h2>
              </div>
              <p style={{ margin: "3px 0 0", fontSize: "var(--fs-12)", color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task?.task}</p>
            </div>
            <button className="btn btn-ghost btn-icon fr" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
          </div>
        </div>

        <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ flex: 1, padding: "10px 12px", borderRadius: "var(--r-md)", background: "var(--bg-surface)", border: "1px solid var(--border-subtle)" }}>
              <div className="tag" style={{ marginBottom: 6 }}>From</div>
              <AgentBadge id={task?.agent ?? null} size="sm" />
            </div>
            <Icon name="arrowRight" size={18} style={{ color: "var(--text-quaternary)", flex: "none" }} />
            <div style={{ flex: 1, padding: "10px 12px", borderRadius: "var(--r-md)", background: target ? "var(--accent-soft)" : "var(--bg-surface)", border: `1px solid ${target ? "var(--accent-border)" : "var(--border-subtle)"}`, transition: "background var(--dur-2)" }}>
              <div className="tag" style={{ marginBottom: 6 }}>To</div>
              {target ? <AgentBadge id={target} size="sm" /> : <span style={{ fontSize: "var(--fs-13)", color: "var(--text-tertiary)" }}>Pick an agent…</span>}
            </div>
          </div>

          <div>
            <div className="tag" style={{ marginBottom: 8 }}>Receiving agent</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8 }}>
              {options.map((a) => {
                const on = target === a.id;
                const suggested = suggestion?.agent === a.id;
                return (
                  <button key={a.id} className="fr" onClick={() => setTarget(a.id)} aria-pressed={on} style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 11px", borderRadius: "var(--r-md)", cursor: "pointer", background: on ? `color-mix(in srgb, ${a.color} 14%, transparent)` : "var(--bg-surface)", border: `1px solid ${on ? `color-mix(in srgb, ${a.color} 45%, transparent)` : "var(--border-subtle)"}`, textAlign: "left", boxShadow: on ? `0 0 0 1px color-mix(in srgb, ${a.color} 30%, transparent) inset` : "none", transition: "border-color var(--dur-1)" }}>
                    <AgentBadge id={a.id} size="sm" showLabel={false} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-medium)", display: "block" }}>{a.short}</span>
                      {suggested && (
                        <span style={{ fontSize: 9.5, color: "var(--accent-text)", display: "block" }}
                          data-tip={suggestion ? suggestionWhy(suggestion) : undefined}>
                          suggested{suggestion?.matched.length ? ` · '${suggestion.matched[0]}'` : ""}{suggestion?.model ? ` · ${suggestion.model}` : ""}{suggestion?.confidence === "low" ? " · low confidence" : ""}
                        </span>
                      )}
                    </div>
                    {on && <Icon name="check" size={14} style={{ color: a.color }} />}
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ padding: "12px 14px", borderRadius: "var(--r-md)", background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", display: "flex", flexDirection: "column", gap: 9 }}>
            <div className="tag">What transfers</div>
            <div style={{ display: "flex", alignItems: "center", gap: 9, fontSize: "var(--fs-13)", color: "var(--text-secondary)" }}>
              <Icon name="gitBranch" size={14} style={{ color: "var(--text-quaternary)", flex: "none" }} />
              <span className="mono" style={{ color: "var(--text-primary)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{branchFor(slug)}</span>
              <span className="mono" style={{ flex: "none", whiteSpace: "nowrap" }}>{task?.ahead || 0} commit{task?.ahead === 1 ? "" : "s"}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 9, fontSize: "var(--fs-13)", color: "var(--text-secondary)" }}>
              <Icon name="folder" size={14} style={{ color: "var(--text-quaternary)" }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Isolated worktree</span>
            </div>
          </div>

          {hasPending && (
            <label style={{ display: "flex", gap: 11, padding: "12px 14px", borderRadius: "var(--r-md)", cursor: "pointer", background: commitPending ? "var(--dirty-soft)" : "var(--bg-surface)", border: `1px solid ${commitPending ? "var(--dirty-border)" : "var(--border-subtle)"}`, transition: "background var(--dur-1)" }}>
              <button role="checkbox" aria-checked={commitPending} onClick={(e) => { e.preventDefault(); setCommitPending((v) => !v); }} className="fr" style={{ width: 18, height: 18, flex: "none", marginTop: 1, borderRadius: 5, cursor: "pointer", display: "grid", placeItems: "center", background: commitPending ? "var(--dirty)" : "transparent", border: `1.5px solid ${commitPending ? "var(--dirty)" : "var(--border-strong)"}` }}>
                {commitPending && <Icon name="check" size={12} style={{ color: "#1a1a1a" }} strokeWidth={3} />}
              </button>
              <div onClick={() => setCommitPending((v) => !v)}>
                <div style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-medium)", display: "flex", alignItems: "center", gap: 7 }}>
                  Commit {task?.filesChanged} pending change{task?.filesChanged === 1 ? "" : "s"} first
                </div>
                <div style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)", marginTop: 2, textWrap: "pretty" }}>
                  Agents only see each other's work once it's committed. Recommended before handing off.
                </div>
              </div>
            </label>
          )}

          <div>
            <div className="tag" style={{ marginBottom: 8 }}>Note for the next agent <span style={{ color: "var(--text-quaternary)", textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· optional</span></div>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="e.g. middleware refactor is done; remaining work is the key-rotation cron + tests."
              style={{ width: "100%", resize: "vertical", padding: "9px 11px", background: "var(--bg-input)", border: "1px solid var(--border-default)", borderRadius: "var(--r-sm)", color: "var(--text-primary)", fontSize: "var(--fs-13)", fontFamily: "inherit", lineHeight: 1.5, outline: "none" }} />
          </div>
        </div>

        <div style={{ padding: "12px 20px", borderTop: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 10, position: "sticky", bottom: 0, background: "var(--bg-elevated)" }}>
          {!writeEnabled && <span style={{ flex: 1, fontSize: "var(--fs-12)", color: "var(--text-tertiary)", display: "flex", alignItems: "center", gap: 6 }}><Icon name="alertTriangle" size={13} style={{ color: "var(--dirty)" }} /> Read-only — enable write actions</span>}
          {writeEnabled && <div style={{ flex: 1 }} />}
          <button className="btn fr" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary fr" disabled={!target || !writeEnabled || busy} onClick={doHandoff}
            data-tip={!writeEnabled ? "Read-only — start `baton serve --write`" : undefined}
            style={(!target || !writeEnabled) ? { opacity: 0.55, cursor: "not-allowed" } : {}}>
            {busy ? <><Icon name="refresh" size={13} style={{ animation: "spin 0.8s linear infinite" }} /> Handing off…</> : <><Icon name="share" size={13} /> Hand off</>}
          </button>
        </div>
      </div>
    </div>
  );
}
