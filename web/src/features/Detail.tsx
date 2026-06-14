/* ============================================================
   BATON — Session detail sheet (ported from detail.jsx)
   ============================================================ */
import { useState, useEffect, type ReactNode } from "react";
import { Icon, type IconName } from "../components/Icon";
import { Sheet, AgentBadge, StatusPill, SyncChips, ProgressBar, ErrorState, ConfirmDialog, CopyButton } from "../components/primitives";
import { getAgent } from "../lib/registry";
import { deriveColumn, COLUMN_DEFS } from "../lib/derive";
import { timeAgo } from "../lib/format";
import { ApiError, BatonAPI } from "../lib/api";
import { showToast } from "../lib/toast";
import type { TaskDetail, DiffFile } from "../types";

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span className="tag">{label}</span>
      {children}
    </div>
  );
}

function CopyField({ value, icon }: { value: string; icon?: IconName }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--bg-base)", border: "1px solid var(--border-default)", borderRadius: "var(--r-sm)", padding: "7px 8px 7px 11px" }}>
      {icon && <Icon name={icon} size={13} style={{ color: "var(--text-quaternary)", flex: "none" }} />}
      <span className="mono" style={{ flex: 1, fontSize: "var(--fs-12)", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</span>
      <CopyButton value={value} iconOnly className="btn btn-sm btn-ghost" />
    </div>
  );
}

export function DetailSheet({
  slug, onClose, writeEnabled, onOpenDiff, onHandoff, onLive,
}: {
  slug: string;
  onClose: () => void;
  writeEnabled: boolean;
  onOpenDiff: (slug: string) => void;
  onHandoff: (slug: string) => void;
  onLive: (slug: string) => void;
}) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const titleId = "sheet-" + slug;

  const [diffFiles, setDiffFiles] = useState<DiffFile[] | null>(null); // null = loading

  useEffect(() => {
    let on = true; setTask(null); setError(null); setDiffFiles(null);
    BatonAPI.getTask(slug).then((t) => on && setTask(t)).catch((e) => on && setError(e as Error));
    BatonAPI.getDiff(slug).then((f) => on && setDiffFiles(f)).catch(() => on && setDiffFiles([]));
    return () => { on = false; };
  }, [slug]);

  const agent = task && getAgent(task.agent);
  const col = task && COLUMN_DEFS.find((c) => c.id === deriveColumn(task));

  const gate = (fn: () => void) => (writeEnabled ? fn : undefined);
  const readOnlyTip = "Read-only — start `baton serve --write` to enable";

  const doMerge = async () => {
    setBusy(true);
    try { await BatonAPI.mergeTask(slug); showToast({ kind: "ok", title: "Merged into main", desc: task!.branch, mono: true }); onClose(); }
    catch (e) { showToast({ kind: "error", title: "Merge failed", desc: (e as Error).message }); setBusy(false); setMergeOpen(false); }
  };
  const doRemove = async () => {
    setBusy(true);
    try { await BatonAPI.removeTask(slug); showToast({ kind: "ok", title: "Worktree removed", desc: task!.branch, mono: true }); onClose(); }
    catch (e) { showToast({ kind: "error", title: "Remove failed", desc: (e as Error).message }); setBusy(false); setRemoveOpen(false); }
  };

  const destructive = !!task && (task.status === "conflict" || task.behind > 0);

  return (
    <Sheet open={!!slug} onClose={onClose} labelledBy={titleId} width={480}>
      {/* header */}
      <div style={{ padding: "16px 18px 14px", borderBottom: "1px solid var(--border-subtle)", display: "flex", flexDirection: "column", gap: 12, flex: "none" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          {task ? <AgentBadge id={task.agent} size="lg" showLabel={false} /> : <div className="skeleton" style={{ width: 30, height: 30, borderRadius: 9 }} />}
          <div style={{ flex: 1, minWidth: 0, paddingTop: 1 }}>
            {task ? (
              <>
                <h2 id={titleId} style={{ margin: 0, fontSize: "var(--fs-16)", fontWeight: "var(--fw-semibold)", lineHeight: "var(--lh-snug)", letterSpacing: "var(--ls-snug)", textWrap: "pretty" }}>{task.task}</h2>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                  <span style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}>{agent!.label}</span>
                  <span style={{ width: 3, height: 3, borderRadius: 99, background: "var(--text-quaternary)" }} />
                  <StatusPill status={task.status} />
                  {col && <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>
                    <span style={{ width: 7, height: 7, borderRadius: 2, background: col.color }} />{col.label}</span>}
                </div>
              </>
            ) : <><div className="skeleton" style={{ width: "70%", height: 16 }} /><div className="skeleton" style={{ width: 120, height: 12, marginTop: 8 }} /></>}
          </div>
          <button className="btn btn-ghost btn-icon fr" onClick={onClose} aria-label="Close" data-tip="Close · Esc" data-tip-side="bottom"><Icon name="x" size={16} /></button>
        </div>
      </div>

      {/* body */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 18 }}>
        {error ? <ErrorState title="Couldn't load session" desc={error.message} onRetry={onClose} command="baton serve" /> : !task ? (
          <>
            <div className="skeleton" style={{ height: 56 }} /><div className="skeleton" style={{ height: 56 }} /><div className="skeleton" style={{ height: 120 }} />
          </>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <SyncChips ahead={task.ahead} behind={task.behind} />
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}>
                <Icon name="fileWarning" size={13} style={{ color: "var(--text-quaternary)" }} /> {task.filesChanged} changed
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}>
                <Icon name="clock" size={13} style={{ color: "var(--text-quaternary)" }} /> {timeAgo(task.createdAt)}
              </span>
              <div style={{ flex: 1, minWidth: 120 }}><ProgressBar ahead={task.ahead} color={task.agent ? agent!.color : "var(--accent)"} /></div>
            </div>

            <DetailRow label="Branch"><CopyField value={task.branch} icon="gitBranch" /></DetailRow>
            <DetailRow label="Worktree path"><CopyField value={task.worktreePath} icon="folder" /></DetailRow>

            {task.conflictFiles.length > 0 && (
              <DetailRow label={`Conflicting files · ${task.conflictFiles.length}`}>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {task.conflictFiles.map((f) => (
                    <div key={f} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: "var(--r-sm)", background: "var(--conflict-soft)", border: "1px solid var(--conflict-border)" }}>
                      <Icon name="alertTriangle" size={13} style={{ color: "var(--conflict)", flex: "none" }} />
                      <span className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--conflict-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f}</span>
                    </div>
                  ))}
                </div>
              </DetailRow>
            )}

            <DetailRow label={`Commits · ${task.commits.length} ahead of main`}>
              {task.commits.length === 0 ? (
                <div style={{ fontSize: "var(--fs-13)", color: "var(--text-tertiary)", padding: "10px 0" }}>No commits yet on this branch.</div>
              ) : (
                <ol style={{ listStyle: "none", margin: 0, padding: 0, position: "relative" }}>
                  <span aria-hidden="true" style={{ position: "absolute", left: 5, top: 8, bottom: 12, width: 1.5, background: "var(--border-default)" }} />
                  {task.commits.map((c) => (
                    <li key={c.sha} style={{ display: "flex", gap: 12, padding: "5px 0 12px", position: "relative" }}>
                      <span style={{ width: 11, height: 11, borderRadius: 99, marginTop: 3, flex: "none", background: "var(--bg-surface)", border: `2px solid ${task.agent ? agent!.color : "var(--accent)"}`, zIndex: 1 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: "var(--fs-13)", color: "var(--text-primary)", lineHeight: 1.4, textWrap: "pretty" }}>{c.message}</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3 }}>
                          <span className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--accent-text)" }}>{c.sha.slice(0, 7)}</span>
                          <span style={{ fontSize: "var(--fs-11)", color: "var(--text-quaternary)" }}>{timeAgo(c.at)}</span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </DetailRow>

            {/* live session — active sessions only */}
            {task.agent && (
              <button className="fr" onClick={() => onLive(slug)} style={{
                display: "flex", alignItems: "center", gap: 11, width: "100%", padding: "11px 13px", borderRadius: "var(--r-md)", cursor: "pointer", textAlign: "left",
                background: `linear-gradient(110deg, color-mix(in srgb, ${agent!.color} 14%, transparent), var(--bg-surface))`,
                border: `1px solid color-mix(in srgb, ${agent!.color} 36%, transparent)` }}>
                <span style={{ position: "relative", width: 9, height: 9, flex: "none" }}>
                  <span style={{ position: "absolute", inset: 0, borderRadius: 99, background: "var(--conflict-strong)" }} />
                  <span style={{ position: "absolute", inset: 0, borderRadius: 99, background: "var(--conflict-strong)", animation: "ping 1.6s var(--ease-out) infinite" }} />
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)" }}>Watch live session</div>
                  <div style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)", marginTop: 1 }}>Stream {agent!.short}'s activity, preview &amp; servers</div>
                </div>
                <Icon name="chevronRight" size={16} style={{ color: "var(--text-tertiary)" }} />
              </button>
            )}

            {/* changes + handoff (preview surfaces) */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="tag">Review &amp; route</span>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn fr" onClick={() => onOpenDiff(slug)} disabled={!diffFiles?.length}
                  style={{ flex: "1 1 160px", justifyContent: "flex-start", gap: 9, ...(diffFiles?.length ? {} : { opacity: 0.55 }) }}
                  data-tip={diffFiles === null ? "Loading changes…" : diffFiles.length ? "Open the git diff in a code view" : "No changes on this branch yet"}>
                  <Icon name="terminal" size={14} style={{ color: "var(--accent-text)" }} />
                  <span style={{ textAlign: "left" }}>View changes<br /><span style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)", fontWeight: 400 }}>{diffFiles === null ? "…" : `${diffFiles.length} file${diffFiles.length === 1 ? "" : "s"}`} · git diff</span></span>
                </button>
                <button className="btn fr" onClick={() => onHandoff(slug)} style={{ flex: "1 1 160px", justifyContent: "flex-start", gap: 9 }} data-tip="Hand this work to another agent">
                  <Icon name="share" size={14} style={{ color: "var(--accent-text)" }} />
                  <span style={{ textAlign: "left" }}>Hand off<br /><span style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)", fontWeight: 400 }}>route to another agent</span></span>
                </button>
                <button className="btn fr" disabled={!writeEnabled}
                  onClick={gate(async () => {
                    try {
                      const t = await BatonAPI.createTerminal(slug, { agent: (task.agent ?? "claude") as NonNullable<typeof task.agent> });
                      showToast({ kind: "ok", title: `${t.agent} terminal open`, desc: "Interactive session on the Live screen" });
                      onLive(slug);
                    } catch (e) {
                      // 409 = a terminal is already live for this task — just go watch it.
                      if (e instanceof ApiError && e.code === "CONFLICT") { onLive(slug); return; }
                      showToast({ kind: "error", title: "Could not open terminal", desc: (e as Error).message });
                    }
                  })}
                  style={{ flex: "1 1 160px", justifyContent: "flex-start", gap: 9, ...(writeEnabled ? {} : { opacity: 0.55, cursor: "not-allowed" }) }}
                  data-tip={writeEnabled ? "Run the agent interactively (tmux) in this worktree" : readOnlyTip}>
                  <Icon name="terminal" size={14} style={{ color: "var(--accent-text)" }} />
                  <span style={{ textAlign: "left" }}>Open terminal<br /><span style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)", fontWeight: 400 }}>interactive · in Live</span></span>
                </button>
                <button className="btn fr" disabled={!writeEnabled}
                  onClick={gate(async () => {
                    try {
                      const r = await BatonAPI.startAgentRun(slug, {});
                      showToast({ kind: "ok", title: `${r.agent} running headless`, desc: "Watch on the Live screen" });
                      onLive(slug);
                    } catch (e) {
                      showToast({ kind: "error", title: "Could not start agent", desc: (e as Error).message });
                    }
                  })}
                  style={{ flex: "1 1 160px", justifyContent: "flex-start", gap: 9, ...(writeEnabled ? {} : { opacity: 0.55, cursor: "not-allowed" }) }}
                  data-tip={writeEnabled ? "Run claude -p with the brief/task in this worktree" : readOnlyTip}>
                  <Icon name="zap" size={14} style={{ color: "var(--accent-text)" }} />
                  <span style={{ textAlign: "left" }}>Start agent<br /><span style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)", fontWeight: 400 }}>headless · output in Live</span></span>
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* footer actions */}
      {task && (
        <div style={{ flex: "none", padding: "12px 18px", borderTop: "1px solid var(--border-subtle)", display: "flex", gap: 9, background: "var(--bg-surface)" }}>
          <button className={"btn fr " + (writeEnabled ? "btn-primary" : "")} disabled={!writeEnabled} onClick={gate(() => setMergeOpen(true))}
            data-tip={writeEnabled ? undefined : readOnlyTip} style={{ flex: 1, ...(writeEnabled ? {} : { opacity: 0.55, cursor: "not-allowed" }) }}>
            <Icon name="gitMerge" size={14} /> Merge into main
          </button>
          <button className="btn btn-danger fr" disabled={!writeEnabled} onClick={gate(() => setRemoveOpen(true))}
            data-tip={writeEnabled ? "Remove worktree + branch" : readOnlyTip} style={writeEnabled ? {} : { opacity: 0.55, cursor: "not-allowed" }}>
            <Icon name="trash" size={14} /> Remove
          </button>
        </div>
      )}

      <ConfirmDialog open={mergeOpen} busy={busy} onClose={() => !busy && setMergeOpen(false)} onConfirm={doMerge}
        tone={destructive ? "danger" : "default"} title={destructive ? "Merge with conflicts?" : "Merge into main?"} confirmLabel="Merge branch"
        body={task && <span>Merge <span className="mono" style={{ color: "var(--text-primary)" }}>{task.branch}</span> into <span className="mono" style={{ color: "var(--text-primary)" }}>main</span>.
          {destructive && <span style={{ display: "block", marginTop: 8, color: "var(--conflict-text)" }}>
            {task.conflictFiles.length ? `${task.conflictFiles.length} conflicting file(s) may need manual resolution.` : `${task.behind} commit(s) behind main — may need rebasing.`}</span>}</span>} />

      <ConfirmDialog open={removeOpen} busy={busy} onClose={() => !busy && setRemoveOpen(false)} onConfirm={doRemove}
        tone="danger" icon="trash" title="Remove this session?" confirmLabel="Remove worktree"
        body={task && <span>This deletes the worktree at <span className="mono" style={{ color: "var(--text-primary)" }}>{task.worktreePath}</span> and the <span className="mono" style={{ color: "var(--text-primary)" }}>{task.branch}</span> branch. Unmerged commits will be lost.</span>} />
    </Sheet>
  );
}
