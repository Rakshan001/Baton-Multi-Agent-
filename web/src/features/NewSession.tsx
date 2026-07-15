/* ============================================================
   BATON — New session dialog
   Creates an isolated worktree + branch (POST /api/tasks, wraps
   `baton new`). The user then launches their agent in that
   worktree — Baton does not spawn agent processes.
   ============================================================ */
import { useState, useRef, useEffect } from "react";
import { Icon } from "../components/Icon";
import { CommandLine } from "../components/primitives";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { BatonAPI, ApiError } from "../lib/api";
import { showToast } from "../lib/toast";
import type { Task } from "../types";

export function NewSessionDialog({ onClose }: { onClose: () => void }) {
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Task | null>(null);
  // Multi-repo hub: a task must target one sub-project (its own git repo). null = single repo.
  const [hubProjects, setHubProjects] = useState<{ id: string; name: string }[] | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, () => { if (!busy) onClose(); });

  useEffect(() => {
    void BatonAPI.getMeta().then((m) => {
      if (m.hub && m.projects?.length) { setHubProjects(m.projects); setProject((p) => p ?? m.projects![0].id); }
    }).catch(() => undefined);
  }, []);

  const submit = async () => {
    const t = task.trim();
    if (!t || busy || (hubProjects && !project)) return;
    setBusy(true);
    try {
      const result = await BatonAPI.createTask(t, project ?? undefined);
      setCreated(result);
      showToast({ kind: "ok", title: "Session created", desc: result.branch, mono: true });
    } catch (e) {
      const err = e as ApiError;
      const desc = err.code === "NOT_FOUND" || err.status === 404
        ? "The daemon doesn't expose POST /api/tasks yet — update baton serve."
        : err.message;
      showToast({ kind: "error", title: "Couldn't create session", desc });
      setBusy(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: "var(--z-overlay)" as unknown as number, display: "grid", placeItems: "center", padding: 20 }}>
      <div onClick={() => !busy && onClose()} style={{ position: "absolute", inset: 0, background: "var(--bg-scrim)", backdropFilter: "blur(3px)", animation: "fade-in var(--dur-2)" }} />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="New session" style={{
        position: "relative", width: "min(520px, 100%)", background: "var(--bg-elevated)", border: "1px solid var(--border-strong)",
        borderRadius: "var(--r-xl)", boxShadow: "var(--shadow-xl)", animation: "scale-in var(--dur-2) var(--ease-out)" }}>

        <div style={{ padding: "18px 20px 14px", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 36, height: 36, borderRadius: 10, flex: "none", display: "grid", placeItems: "center", background: "var(--accent-soft)", border: "1px solid var(--accent-border)", color: "var(--accent-text)" }}><Icon name="plus" size={18} /></span>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0, fontSize: "var(--fs-16)", fontWeight: "var(--fw-semibold)" }}>New session</h2>
            <p style={{ margin: "3px 0 0", fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>Creates an isolated worktree + branch for an agent to work in.</p>
          </div>
          <button className="btn btn-ghost btn-icon fr" onClick={() => !busy && onClose()} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>

        {created ? (
          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--clean-text)" }}>
              <Icon name="checkCircle" size={18} /> <span style={{ fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)" }}>Worktree created</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="tag">Launch your agent there</span>
              <CommandLine command={`cd ${created.worktreePath}`} />
            </div>
            <div style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>
              Branch <span className="mono" style={{ color: "var(--text-secondary)" }}>{created.branch}</span> — start <span className="mono">claude</span>, <span className="mono">cursor</span>, or any agent in that directory and it'll show up on the board.
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button className="btn btn-primary fr" onClick={onClose}>Done</button>
            </div>
          </div>
        ) : (
          <>
            {hubProjects && (
              <div style={{ padding: "16px 20px 4px", display: "flex", flexDirection: "column", gap: 8 }}>
                <span className="tag">Project</span>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(132px, 1fr))", gap: 8 }}>
                  {hubProjects.map((pr) => {
                    const on = project === pr.id;
                    return (
                      <button key={pr.id} className="fr" onClick={() => setProject(pr.id)} aria-pressed={on} style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 11px", borderRadius: "var(--r-md)", cursor: "pointer", textAlign: "left", background: on ? "color-mix(in srgb, var(--accent) 14%, transparent)" : "var(--bg-surface)", border: `1px solid ${on ? "color-mix(in srgb, var(--accent) 45%, transparent)" : "var(--border-subtle)"}` }}>
                        <Icon name="folder" size={14} style={{ color: on ? "var(--accent)" : "var(--text-tertiary)", flex: "none" }} />
                        <span style={{ flex: 1, fontSize: "var(--fs-13)", fontWeight: "var(--fw-medium)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pr.name}</span>
                        {on && <Icon name="check" size={14} style={{ color: "var(--accent)", flex: "none" }} />}
                      </button>
                    );
                  })}
                </div>
                <span style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>This hub holds several repos — the worktree branches off the one you pick.</span>
              </div>
            )}
            <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 8 }}>
              <span className="tag">Task description</span>
              <textarea data-autofocus value={task} onChange={(e) => setTask(e.target.value)} rows={3}
                onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit(); }}
                placeholder="e.g. Refactor auth middleware to support API keys"
                style={{ width: "100%", resize: "vertical", padding: "10px 12px", background: "var(--bg-input)", border: "1px solid var(--border-default)", borderRadius: "var(--r-sm)", color: "var(--text-primary)", fontSize: "var(--fs-14)", fontFamily: "inherit", lineHeight: 1.5, outline: "none" }} />
              <span style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>A kebab-case slug and <span className="mono">baton/&lt;slug&gt;</span> branch are derived automatically.</span>
            </div>
            <div style={{ padding: "12px 20px", borderTop: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ flex: 1, fontSize: "var(--fs-12)", color: "var(--text-quaternary)" }}><span className="kbd">⌘</span> <span className="kbd">↵</span> to create</span>
              <button className="btn fr" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="btn btn-primary fr" onClick={submit} disabled={!task.trim() || busy || (!!hubProjects && !project)}>
                {busy ? <><Icon name="refresh" size={13} style={{ animation: "spin 0.8s linear infinite" }} /> Creating…</> : <><Icon name="plus" size={14} /> Create session</>}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
