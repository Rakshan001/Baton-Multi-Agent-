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
import { useFocusTrap } from "../hooks/useFocusTrap";
import { showToast } from "../lib/toast";
import type { StatusRow, AgentId, RouteSuggestion, HandoffLoadSuggestion, HandoffBriefEntry } from "../types";

/* ---- Handoff inbox (H3): open briefs awaiting pickup, with copy buttons ---- */

function copyText(label: string, text: string) {
  navigator.clipboard.writeText(text).then(
    () => showToast({ kind: "ok", title: `${label} copied` }),
    () => showToast({ kind: "error", title: "Copy failed", desc: "Clipboard unavailable in this context" }),
  );
}

function briefAge(iso: string): string {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(min) || min < 0) return "";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** The paste-into-the-next-agent prompt: where to work + the brief itself. */
function resumePrompt(b: HandoffBriefEntry): string {
  return `Continue this handed-off work. Work in: ${b.cwd}\n\n${b.body}\n\nExecute the plan above — don't re-plan from scratch; flag blockers instead.`;
}

export function HandoffInbox() {
  const [briefs, setBriefs] = useState<HandoffBriefEntry[]>([]);
  useEffect(() => {
    let on = true;
    const load = () => BatonAPI.getHandoffs().then((b) => { if (on) setBriefs(b); }).catch(() => undefined);
    load();
    const t = setInterval(load, 30_000);
    return () => { on = false; clearInterval(t); };
  }, []);

  if (!briefs.length) return null;
  return (
    <div style={{ flex: "2 1 360px", minWidth: 280, background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderLeft: "3px solid var(--accent)", borderRadius: "var(--r-lg)", padding: "11px 13px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)" }}>
        <Icon name="share" size={14} strokeWidth={2} style={{ color: "var(--accent-text)" }} /> <span style={{ whiteSpace: "nowrap" }}>Handoffs awaiting pickup</span>
        <span className="mono" style={{ marginLeft: "auto", fontSize: "var(--fs-12)", fontWeight: "var(--fw-regular)", color: "var(--text-tertiary)", whiteSpace: "nowrap" }}>{briefs.length} open</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {briefs.slice(0, 3).map((b) => (
          <div key={b.path} style={{ display: "flex", flexDirection: "column", gap: 7, padding: "8px 9px", borderRadius: "var(--r-sm)", background: "var(--bg-surface-2)", border: "1px solid var(--border-subtle)" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-medium)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.title}</div>
              <div className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {b.from} → {b.to} · {b.status}{b.created ? ` · ${briefAge(b.created)}` : ""}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button className="btn btn-sm fr" style={{ flex: "none" }} data-tip="Copy the full brief as a prompt for the next agent"
                onClick={() => copyText("Resume prompt", resumePrompt(b))}>
                <Icon name="copy" size={12} /> Resume prompt
              </button>
              <button className="btn btn-sm btn-ghost fr" style={{ flex: "none", width: 28, padding: 0 }} aria-label="Copy pickup command" data-tip={`Copy: baton resume ${b.slug}`}
                onClick={() => copyText("Pickup command", b.kind === "task" ? `cd ${b.cwd} && baton take ${b.slug}` : `baton resume ${b.slug}`)}>
                <Icon name="terminal" size={13} />
              </button>
              <button className="btn btn-sm btn-ghost fr" style={{ flex: "none", width: 28, padding: 0 }} aria-label="Copy brief file path" data-tip={`Copy path: ${b.path}`}
                onClick={() => copyText("Brief path", b.path)}>
                <Icon name="folder" size={13} />
              </button>
            </div>
          </div>
        ))}
        {briefs.length > 3 && <div style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)", padding: "0 8px" }}>…{briefs.length - 3} more — `baton resume` lists all</div>}
      </div>
    </div>
  );
}

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
  const [load, setLoad] = useState<HandoffLoadSuggestion | null>(null);
  const userPicked = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const hasPending = (task?.filesChanged || 0) > 0;
  const options = AGENT_REGISTRY.filter((a) => a.id !== task?.agent);

  const pick = (id: AgentId) => { userPicked.current = true; setTarget(id); };

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
      if (valid && !userPicked.current) setTarget((cur) => cur ?? (r.suggestion!.agent as AgentId));
    }).catch(() => undefined);
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.task]);

  // Load-aware recommendation: prefer a free agent. Overrides the routing-only
  // preselect (it already folds routing in as a tie-break) unless the user chose.
  useEffect(() => {
    let on = true;
    BatonAPI.suggestHandoff(slug).then((s) => {
      if (!on) return;
      setLoad(s);
      const valid = s.recommended && options.some((a) => a.id === s.recommended);
      if (valid && !userPicked.current) setTarget(s.recommended as AgentId);
    }).catch(() => undefined);
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  useFocusTrap(ref, onClose, { autoFocus: false });
  useEffect(() => { const t = setTimeout(() => ref.current?.focus(), 40); return () => clearTimeout(t); }, []);

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
        <div ref={ref} role="dialog" aria-modal="true" aria-label="Handoff brief ready" style={{ position: "relative", width: "min(520px, 100%)", background: "var(--bg-elevated)", border: "1px solid var(--border-strong)", borderRadius: "var(--r-xl)", boxShadow: "var(--shadow-xl)", animation: "scale-in var(--dur-2) var(--ease-out)", padding: 22 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <span style={{ width: 36, height: 36, borderRadius: 10, display: "grid", placeItems: "center", background: "var(--clean-soft)", border: "1px solid var(--clean-border)", color: "var(--clean-text)" }}><Icon name="check" size={18} /></span>
            <div>
              <h2 style={{ margin: 0, fontSize: "var(--fs-16)", fontWeight: "var(--fw-semibold)" }}>HANDOFF.md is ready</h2>
              <p style={{ margin: "2px 0 0", fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>
                For <AgentBadge id={doneInfo.toAgent} size="sm" />{typeof doneInfo.estTokens === "number" && doneInfo.estTokens > 0 ? <> · saves ≈{doneInfo.estTokens.toLocaleString()} tokens{typeof doneInfo.estCostUsd === "number" && doneInfo.estCostUsd > 0 ? <> / ≈${doneInfo.estCostUsd}</> : null} of replaying this session</> : null}
              </p>
            </div>
          </div>
          <div className="tag" style={{ marginBottom: 8 }}>Start the next agent with</div>
          <pre className="mono" style={{ margin: 0, padding: "10px 12px", background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: "var(--r-md)", fontSize: "var(--fs-12)", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{`cd ${wt}\nbaton take ${slug}`}</pre>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <button className="btn fr" onClick={() => copyText("Pickup command", `cd ${wt} && baton take ${slug}`)}><Icon name="copy" size={13} /> Copy command</button>
            {doneInfo.briefPath && <button className="btn fr" onClick={() => copyText("Brief path", doneInfo.briefPath!)}><Icon name="folder" size={13} /> Copy brief path</button>}
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
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
              <span className="tag">Receiving agent</span>
              {load?.recommended && (
                <span style={{ fontSize: 11, color: "var(--text-tertiary)" }} data-tip={load.reason}>
                  <Icon name="zap" size={10} style={{ color: "var(--accent)", verticalAlign: "-1px" }} /> {load.reason}
                </span>
              )}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8 }}>
              {options.map((a) => {
                const on = target === a.id;
                const suggested = suggestion?.agent === a.id;
                const recommended = load?.recommended === a.id;
                const loadN = load?.loads?.[a.id!] ?? 0;
                return (
                  <button key={a.id} className="fr" onClick={() => pick(a.id!)} aria-pressed={on} style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 11px", borderRadius: "var(--r-md)", cursor: "pointer", background: on ? `color-mix(in srgb, ${a.color} 14%, transparent)` : "var(--bg-surface)", border: `1px solid ${on ? `color-mix(in srgb, ${a.color} 45%, transparent)` : recommended ? "var(--accent-border)" : "var(--border-subtle)"}`, textAlign: "left", boxShadow: on ? `0 0 0 1px color-mix(in srgb, ${a.color} 30%, transparent) inset` : "none", transition: "border-color var(--dur-1)" }}>
                    <AgentBadge id={a.id} size="sm" showLabel={false} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-medium)", display: "flex", alignItems: "center", gap: 6 }}>
                        {a.short}
                        {load && <span style={{ fontSize: 9.5, fontWeight: "var(--fw-semibold)", color: loadN === 0 ? "var(--clean-text)" : "var(--dirty-text)" }} data-tip={loadN === 0 ? "No active tasks — free to take this" : `${loadN} task${loadN === 1 ? "" : "s"} in progress`}>{loadN === 0 ? "idle" : `${loadN} active`}</span>}
                      </span>
                      {recommended
                        ? <span style={{ fontSize: 9.5, color: "var(--accent-text)", display: "block" }} data-tip={load?.reason}>recommended · lightest load</span>
                        : suggested && (
                          <span style={{ fontSize: 9.5, color: "var(--text-tertiary)", display: "block" }}
                            data-tip={suggestion ? suggestionWhy(suggestion) : undefined}>
                            fits the task{suggestion?.matched.length ? ` · '${suggestion.matched[0]}'` : ""}
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
