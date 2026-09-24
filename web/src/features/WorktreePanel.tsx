// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — the worktree detail panel (wt-node-actions)

   ONE SELECTION STATE, TWO PRESENTATIONS. This component is the panel
   body and nothing else: features/Worktrees.tsx owns the selected slug
   and decides whether to hang the body in an inline `aside` (≥900px)
   or inside the shared `Sheet` (below it, where Sheet already becomes a
   focus-trapped bottom sheet). There is deliberately no second panel —
   two of these would be two places to fix the same wording.

   ORDER IS DIAGNOSIS-FIRST AND IT IS NOT A STYLE CHOICE. The sections
   render in `PANEL_SECTION_ORDER` (flow/panel.ts), which is verdict →
   why → who → work → progress → identity → actions. The person reading
   this has just found work that stopped; a conventional detail pane
   would lead with the title and the branch path, which are the two
   things they need last. The order is exported as data so a test fails
   if it drifts, rather than a reviewer having to notice.

   WHAT THIS FILE IS NOT ALLOWED TO DO, and where each is enforced:

   · INVENT A REFUSAL. Section 2 renders `blocker` from the pipeline's
     own read-model, verbatim (flow/panel.ts:blockerFor). A write that
     comes back 409 renders the daemon's sentence the same way — that
     sentence IS the product (src/endpoints/worktrees.ts carries
     lifecycle's "Two agents in one worktree is the failure this
     prevents" through untouched), and softening it in front of someone
     about to hand over a dirty worktree would be the one place a
     paraphrase does real damage.
   · ASSEMBLE PROMPT TEXT. Copy prompt copies the open brief's body as
     the daemon built it, or a CLI command (pickup, or inspect for an
     orphan). Nothing is assembled (flow/panel.ts:resolveCopyPrompt).
   · DECIDE A WRITE IS IMPOSSIBLE. The gates check `--write` and
     "is there a task record at all", and stop. The stall barrier stays
     the daemon's.
   ============================================================ */
import { useCallback, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import {
  AgentBadge, ConfirmDialog, CopyButton, SyncChips,
} from "../components/primitives";
import { HEALTH_META, STATE_COLOR, quietLabel } from "../components/flow/health";
import { healthBorder } from "../components/flow/encoding";
import { useNodeMotion } from "../components/flow/useNodeMotion";
import {
  PANEL_SECTION_ORDER, READ_ONLY_TIP, blockerFor, briefFor, displayName, handoffGate, inspectGate,
  isTaskRow, mergeGate, pauseGate, progressHeadline, resolveCopyPrompt, takeoverGate, whoFacts,
  workInFlightFacts, type PanelMeta, type PanelSection, type WorktreeProgress,
} from "../components/flow/panel";
import { usePoll } from "../hooks/usePoll";
import { ApiError, BatonAPI, failureReason } from "../lib/api";
import { AGENT_REGISTRY } from "../lib/registry";
import { showToast } from "../lib/toast";
import type { AgentId, HandoffBriefEntry, PipelineView, WorktreeRow } from "../types";

/* ---------- small shared bits (local, deliberately) ----------
   `Chip` and `Field` exist as a near-copy of the chip inside
   flow/WorktreeNode.tsx. Not lifted into primitives.tsx: that card is not in
   this change's scope, and a shared component pulled out of one caller to
   serve two is how a "primitive" ends up with six boolean props. If a third
   surface needs it, that is the moment. */

function Chip({
  color, icon, title, children,
}: { color: string; icon?: Parameters<typeof Icon>[0]["name"]; title?: string; children: React.ReactNode }) {
  return (
    <span data-tip={title} style={{
      display: "inline-flex", alignItems: "center", gap: 4, maxWidth: "100%",
      padding: "2px 7px", borderRadius: "var(--r-full)", fontSize: "var(--fs-11)",
      fontWeight: "var(--fw-medium)", color, whiteSpace: "nowrap",
      background: `color-mix(in srgb, ${color} 12%, transparent)`,
      border: `1px solid color-mix(in srgb, ${color} 32%, transparent)`,
    }}>
      {icon && <Icon name={icon} size={11} strokeWidth={2.2} />}
      {children}
    </span>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 style={{
      margin: 0, fontSize: "var(--text-micro)", fontWeight: "var(--fw-semibold)",
      letterSpacing: "var(--ls-caps)", textTransform: "uppercase", color: "var(--text-quaternary)",
    }}>{children}</h3>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <section style={{
      display: "flex", flexDirection: "column", gap: 8, padding: "13px 16px",
      borderBottom: "1px solid var(--border-subtle)",
    }}>{children}</section>
  );
}

/** A copy field: the value readable, and a button that copies it. */
function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
      <span style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)", flex: "none", width: 62 }}>{label}</span>
      <span className="mono" title={value} style={{
        flex: 1, minWidth: 0, fontSize: "var(--fs-12)", color: "var(--text-secondary)",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>{value}</span>
      <CopyButton value={value} iconOnly className="btn btn-sm btn-ghost" title={`Copy ${label.toLowerCase()}`} />
    </div>
  );
}

/** A button whose disabled reason is said out loud, using the tooltip this
 *  codebase already uses for a write a read-only daemon will refuse. The
 *  wrapper span carries the tip because a disabled button receives no hover. */
function GatedButton({
  gate, onClick, className = "btn btn-sm fr", children, busy,
}: {
  gate: { enabled: boolean; tip?: string };
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
  busy?: boolean;
}) {
  return (
    <span data-tip={gate.enabled ? undefined : gate.tip} style={{ display: "inline-flex" }}>
      <button className={className} disabled={!gate.enabled || busy} onClick={onClick}
        aria-disabled={!gate.enabled || busy}>
        {busy && <Icon name="refresh" size={12} style={{ animation: "spin 0.8s linear infinite" }} />}
        {children}
      </button>
    </span>
  );
}

export interface WorktreePanelProps {
  row: WorktreeRow;
  /** Source of the verbatim `blocker` for section 2. Null while it loads. */
  pipeline: PipelineView | null;
  /** Open handoff briefs — what Copy prompt copies when one exists. */
  briefs: HandoffBriefEntry[] | null;
  /**
   * What GET /api/meta says about the daemon's own repo. This is where the
   * merge TARGET comes from, and there is no fallback: `baton merge` lands on
   * `currentBranch(gitRepo)` (src/commands/merge.ts:104), so a panel that
   * guessed the branch would name one thing and do another. Null while it
   * loads, or when the read failed — and Merge refuses on null.
   */
  meta: PanelMeta | null;
  writeEnabled: boolean;
  onClose: () => void;
  /** Refetch the worktree list: a write has changed what it says. */
  onRefresh: () => void;
  onOpenDiff: (slug: string) => void;
  onLive: (slug: string) => void;
  onHandoff: (slug: string) => void;
  /** Id of the panel's heading, for the Sheet's `aria-labelledby`. */
  headingId: string;
}

/**
 * One body PER WORKTREE: keyed by slug, so selecting another worktree mounts a
 * fresh one. A refusal, an open dialog, a half-typed agent name or a busy flag
 * all describe the worktree they were said about, and carried over they would
 * sit under the next one's name.
 */
export function WorktreePanel(props: WorktreePanelProps) {
  return <PanelBody key={props.row.slug} {...props} />;
}

function PanelBody(props: WorktreePanelProps) {
  const { row, pipeline, briefs, meta, writeEnabled, onClose, onRefresh, headingId } = props;
  const health = HEALTH_META[row.health] ?? HEALTH_META.unknown;
  const mayAnimate = useNodeMotion();

  // The ledger, per selected slug. `deps: [row.slug]` so switching selection
  // invalidates the response still in flight rather than painting the previous
  // worktree's notes under the new one's name. Only for a task row: nothing
  // else has a ledger, and the route refuses a non-task id with a 400.
  const isTask = isTaskRow(row);
  const progress = usePoll<WorktreeProgress>(
    () => BatonAPI.getWorktreeProgress(row.slug),
    { interval: 15000, deps: [row.slug], enabled: isTask },
  );

  // Joined by slug, so only for a task row: no other row's id names a task,
  // so a blocker or brief joined on it would not be this directory's.
  const brief = useMemo(
    () => (isTask ? briefFor(briefs, row.slug) : null),
    [briefs, row.slug, isTask],
  );
  const blocker = useMemo(
    () => (isTask ? blockerFor(pipeline, row.slug) : null),
    [pipeline, row.slug, isTask],
  );
  const copyPrompt = useMemo(
    () => resolveCopyPrompt(row, brief, writeEnabled),
    [row, brief, writeEnabled],
  );

  /* ---- writes ------------------------------------------------------- */
  const [dialog, setDialog] = useState<"takeover" | "pause" | "merge" | null>(null);
  const [agent, setAgent] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  // The daemon's own refusal sentence, kept on screen after the toast fades.
  // A 409 here is not a bug to swallow — it is the guard working.
  const [refusal, setRefusal] = useState<string | null>(null);
  // `busy` is state, so a second Enter in the same frame still reads false.
  // This ref is what makes one keypress one write.
  const inFlight = useRef(false);

  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setRefusal(null);
    try {
      await fn();
      showToast({ kind: "ok", title: `${label} — done` });
      setDialog(null);
      onRefresh();
    } catch (e) {
      // `failureReason` returns the daemon's message verbatim for a 409/403,
      // which is exactly the sentence the CLI would have printed.
      const said = failureReason(e);
      setRefusal(said);
      showToast({ kind: "error", title: `${label} refused`, desc: said });
      if (!(e instanceof ApiError)) setDialog(null);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [onRefresh]);

  const doTakeover = () => void run("Take over", () => BatonAPI.takeoverWorktree(row.slug, agent.trim()));
  const doPause = () => void run("Pause", () => BatonAPI.pauseWorktree(row.slug, { reason: reason.trim() || undefined }));

  const takeover = takeoverGate(row, writeEnabled);
  const paws = pauseGate(row, writeEnabled);
  const handoff = handoffGate(row, writeEnabled);
  const inspect = inspectGate(row);
  const merge = mergeGate(row, pipeline, meta, writeEnabled);

  /* ---- merge: optimistic, and rolled back OUT LOUD if it fails -------
   * The shape of features/Board.tsx:111-125, not a second pattern: mark it
   * landed before the request so the panel is not silent for a second, and on
   * failure put the optimistic write back, tell the client to drop its overlay
   * and re-read the daemon, and say in the toast that nothing landed. A merge
   * that failed while the UI still claims it succeeded is the one outcome this
   * screen cannot afford.
   *
   * `landed` carries the slug it belongs to and is rendered only for a
   * matching row. The body now remounts per slug (see `WorktreePanel`), so
   * that check is belt and braces — and switching away and back drops the
   * banner, which the refreshed row's `ahead: 0` still evidences.
   */
  const [landed, setLanded] = useState<{ slug: string; into: string; archivedRef: string | null } | null>(null);
  const doMerge = async () => {
    if (!merge.enabled || inFlight.current) return;
    inFlight.current = true;
    const into = merge.target;
    setBusy(true);
    setRefusal(null);
    setLanded({ slug: row.slug, into, archivedRef: null }); // optimistic
    try {
      const r = await BatonAPI.mergeWorktree(row.slug);
      // `r.into` is the branch the DAEMON merged into, which is the only
      // authority on where the work actually went.
      setLanded({ slug: row.slug, into: r.into, archivedRef: r.archivedRef });
      setDialog(null);
      showToast({
        kind: "ok", title: `Merged into ${r.into}`, desc: r.branch, mono: true,
      });
      onRefresh();
    } catch (e) {
      setLanded(null);                  // roll the optimistic write back
      BatonAPI.rollbackWorktree(row.slug);
      const said = failureReason(e);
      setRefusal(said);
      showToast({ kind: "error", title: "Merge failed — nothing landed, rolled back", desc: said });
      if (!(e instanceof ApiError)) setDialog(null);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const who = whoFacts(row);
  const work = workInFlightFacts(row);
  const view = progress.data;

  /* ---- the sections, rendered in the plan's order ------------------- */
  const sections: Record<PanelSection, React.ReactNode> = {
    /* 1 — VERDICT. Largest type in the panel, because it is the answer. */
    verdict: (
      <Section key="verdict">
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <span aria-hidden="true" style={{
            width: 34, height: 34, flex: "none", display: "grid", placeItems: "center",
            borderRadius: 10, color: health.color,
            background: `color-mix(in srgb, ${health.color} 13%, transparent)`,
            border: `${healthBorder(row.health).width}px ${healthBorder(row.health).pattern} color-mix(in srgb, ${health.color} 40%, transparent)`,
          }}>
            <Icon name={health.icon} size={18} strokeWidth={2} />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div id={headingId} style={{
              fontSize: "var(--fs-20)", fontWeight: "var(--fw-semibold)", lineHeight: 1.15,
              color: health.color, letterSpacing: "-0.01em",
            }}>{health.label}</div>
            <div style={{ marginTop: 3, fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}>
              Quiet for <span className="mono">{quietLabel(row.quietForMs)}</span>
              {row.state && <> · <span style={{ color: STATE_COLOR[row.state] }}>{row.state}</span></>}
            </div>
          </div>
        </div>
        <p style={{ margin: 0, fontSize: "var(--fs-12)", color: "var(--text-tertiary)", lineHeight: "var(--lh-snug)" }}>
          {health.blurb}
        </p>
      </Section>
    ),

    /* 2 — WHY. The daemon's refusal, verbatim. Nothing here rewords it. */
    why: (
      <Section key="why">
        <SectionTitle>Why</SectionTitle>
        {blocker
          ? (
            <p style={{
              margin: 0, padding: "8px 10px", borderRadius: "var(--r-sm)",
              background: "var(--conflict-soft)", border: "1px solid var(--conflict-border)",
              color: "var(--conflict-text)", fontSize: "var(--fs-12)", lineHeight: "var(--lh-snug)",
            }}>{blocker}</p>
          )
          : pipeline === null
            ? <span style={{ fontSize: "var(--fs-12)", color: "var(--text-quaternary)" }}>Reading the pipeline…</span>
            : (
              <span style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>
                The pipeline names nothing holding this up.
              </span>
            )}
        {refusal && (
          <p role="status" style={{
            margin: 0, padding: "8px 10px", borderRadius: "var(--r-sm)",
            background: "var(--dirty-soft)", border: "1px solid var(--dirty-border)",
            color: "var(--dirty-text)", fontSize: "var(--fs-12)", lineHeight: "var(--lh-snug)",
          }}>
            <strong style={{ fontWeight: "var(--fw-semibold)" }}>The daemon refused: </strong>{refusal}
          </p>
        )}
      </Section>
    ),

    /* 3 — WHO, and whether a process is ACTUALLY running. The two are
           different questions and the panel answers both out loud. */
    who: (
      <Section key="who">
        <SectionTitle>Who</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
          <AgentBadge id={who.badge as AgentId | null} size="sm" />
          {who.running
            ? (
              <Chip color="var(--ready)" icon="zap" title="A process is genuinely alive in this worktree">
                <span aria-hidden="true" style={{
                  width: 5, height: 5, borderRadius: 999, marginRight: 2, background: "var(--ready)",
                  animation: mayAnimate ? "pulse-dot 1.8s ease-in-out infinite" : "none",
                }} />
                process running
              </Chip>
            )
            : (
              <Chip color={row.claimedBy ? "var(--conflict)" : "var(--idle)"} icon="wifiOff"
                title="No process was detected in this worktree">
                no process
              </Chip>
            )}
          {row.claimedBy && row.agent && row.claimedBy !== row.agent && (
            <Chip color="var(--dirty)" icon="alertTriangle"
              title="The task record and the live process name different agents">
              record says {row.claimedBy}
            </Chip>
          )}
        </div>
        <p style={{ margin: 0, fontSize: "var(--fs-12)", color: "var(--text-secondary)", lineHeight: "var(--lh-snug)" }}>
          {who.line}
        </p>
      </Section>
    ),

    /* 4 — WORK IN FLIGHT. A null counter reads "unknown", never 0. */
    work: (
      <Section key="work">
        <SectionTitle>Work in flight</SectionTitle>
        {row.ahead !== null && row.behind !== null && (
          <SyncChips ahead={row.ahead} behind={row.behind} size="sm" />
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {work.map((f) => (
            <Chip key={f.key} color={f.urgent ? "var(--conflict)" : "var(--idle)"} title={f.tip}>
              <span className="mono" style={{ fontWeight: "var(--fw-semibold)" }}>{f.value}</span> {f.label}
            </Chip>
          ))}
        </div>
        {row.wipRef && (
          <div className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)", wordBreak: "break-all" }}>
            snapshotted to {row.wipRef}
          </div>
        )}
      </Section>
    ),

    /* 5 — WHAT IT SAID IT WAS DOING. The progress ledger. "Said nothing" is
           a real answer here and gets its own sentence. */
    progress: (
      <Section key="progress">
        <SectionTitle>What it said it was doing</SectionTitle>
        {!isTask
          ? (
            <span style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>
              {row.kind === "orphan"
                ? "No task owns this worktree, so there is no progress ledger to read."
                : "Baton did not create this worktree, so there is no progress ledger to read."}
            </span>
          )
          : progress.error && !view
          ? (
            <span style={{ fontSize: "var(--fs-12)", color: "var(--dirty-text)" }}>
              Couldn&apos;t read the progress ledger — {failureReason(progress.error)}.
            </span>
          )
          : !view
            ? <span style={{ fontSize: "var(--fs-12)", color: "var(--text-quaternary)" }}>Reading the ledger…</span>
            : (
              <>
                <span style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}>
                  {progressHeadline(view)}
                </span>
                {view.flagged && (
                  <p style={{
                    margin: 0, padding: "8px 10px", borderRadius: "var(--r-sm)",
                    background: "var(--conflict-soft)", border: "1px solid var(--conflict-border)",
                    color: "var(--conflict-text)", fontSize: "var(--fs-12)", lineHeight: "var(--lh-snug)",
                  }}>
                    {/* The overclaim marker, verbatim. The daemon is emphatic
                        that this is never filtered or softened. */}
                    {view.flagged}
                  </p>
                )}
                {view.plan.length > 0 && (
                  <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 3 }}>
                    {view.plan.map((item, i) => (
                      <li key={`${i}-${item.content}`} style={{
                        display: "flex", gap: 6, alignItems: "flex-start",
                        fontSize: "var(--fs-12)", lineHeight: "var(--lh-snug)",
                        color: item.status === "completed" ? "var(--text-quaternary)" : "var(--text-secondary)",
                      }}>
                        <Icon name={item.status === "completed" ? "checkCircle" : item.status === "in_progress" ? "play" : "dot"}
                          size={12} style={{ flex: "none", marginTop: 2, color: item.status === "completed" ? "var(--clean)" : "var(--text-quaternary)" }} />
                        <span style={{ textDecoration: item.status === "completed" ? "line-through" : undefined }}>{item.content}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {view.next && (
                  <div style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)", lineHeight: "var(--lh-snug)" }}>
                    <span style={{ color: "var(--text-quaternary)" }}>Next: </span>{view.next}
                  </div>
                )}
                {view.notes.map((n, i) => (
                  <p key={i} style={{ margin: 0, fontSize: "var(--fs-12)", color: "var(--text-tertiary)", lineHeight: "var(--lh-snug)" }}>{n}</p>
                ))}
                {view.updatedAt && (
                  <div className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-quaternary)" }}>
                    checkpointed {new Date(view.updatedAt).toLocaleString()}
                  </div>
                )}
              </>
            )}
      </Section>
    ),

    /* 6 — IDENTITY. Last of the readable sections on purpose. */
    identity: (
      <Section key="identity">
        <SectionTitle>Identity</SectionTitle>
        {/* Only a task has a slug. Any other row's id is a derived key
            (src/worktrees.ts:worktreeId); the path below names it. */}
        {isTask && <CopyField label="Slug" value={row.slug} />}
        <CopyField label="Branch" value={row.branch ?? "(no branch)"} />
        <CopyField label="Path" value={row.worktreePath} />
        {(row.planId || row.phase !== null) && (
          <div style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)" }}>
            {row.planId ? `plan ${row.planId}` : "no plan"}{row.phase !== null ? ` · phase ${row.phase}` : ""}
            {row.dependsOn.length > 0 ? ` · waits on ${row.dependsOn.join(", ")}` : ""}
          </div>
        )}
      </Section>
    ),

    /* 7 — ACTIONS. */
    actions: (
      <Section key="actions">
        <SectionTitle>Actions</SectionTitle>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {/* MERGE NAMES ITS TARGET IN THE LABEL, not just in the dialog. From
              a canvas showing a dozen worktrees, "Merge" alone does not say
              where — and where is the whole question (flow/panel.ts:mergeGate).
              When the gate could not name a branch the label stays a bare
              "Merge" and the button is disabled, because a label naming a
              branch the merge will not use is worse than no branch at all. */}
          <GatedButton gate={merge} className={merge.enabled ? "btn btn-sm btn-primary fr" : "btn btn-sm fr"}
            busy={busy && dialog === "merge"}
            onClick={() => { setRefusal(null); setDialog("merge"); }}>
            <Icon name="gitMerge" size={12} />
            {merge.enabled
              ? <>Merge into <span className="mono">{merge.target}</span></>
              : "Merge"}
          </GatedButton>
          <GatedButton gate={takeover} className="btn btn-sm btn-primary fr"
            onClick={() => { setAgent(""); setRefusal(null); setDialog("takeover"); }}>
            <Icon name="cornerUpRight" size={12} /> Take over
          </GatedButton>
          <GatedButton gate={paws} onClick={() => { setReason(""); setRefusal(null); setDialog("pause"); }}>
            <Icon name="pause" size={12} /> Pause
          </GatedButton>
          <GatedButton gate={handoff} onClick={() => props.onHandoff(row.slug)}>
            <Icon name="share" size={12} /> Hand off
          </GatedButton>
          <GatedButton gate={inspect} onClick={() => props.onLive(row.slug)}>
            <Icon name="terminal" size={12} /> Open Live
          </GatedButton>
          <GatedButton gate={inspect} onClick={() => props.onOpenDiff(row.slug)}>
            <Icon name="columns" size={12} /> Diff
          </GatedButton>
          {/* Copy prompt copies what the DAEMON wrote, or a CLI command.
              `resolveCopyPrompt` has the only answers there are. */}
          <CopyButton value={copyPrompt.text} label={copyPrompt.label}
            className="btn btn-sm" title={copyPrompt.tip} />
        </div>
        {/* A REFUSAL IS SAID OUT LOUD, not warned about and not left in a
            tooltip on a disabled button. `refused` is set for the phase
            barrier, an unresolved conflict, a half-finished git operation and
            a target that cannot be named — the cases where somebody is about
            to go looking for the reason. The sentence is the gate's, and where
            the pipeline issued one it is the pipeline's, verbatim. */}
        {!merge.enabled && merge.refused && (
          <p role="status" style={{
            margin: 0, padding: "8px 10px", borderRadius: "var(--r-sm)",
            background: "var(--dirty-soft)", border: "1px solid var(--dirty-border)",
            color: "var(--dirty-text)", fontSize: "var(--fs-12)", lineHeight: "var(--lh-snug)",
            animation: mayAnimate ? "fade-in var(--dur-2) ease-out" : "none",
          }}>
            <strong style={{ fontWeight: "var(--fw-semibold)" }}>Merge refused: </strong>{merge.tip}
          </p>
        )}
        {landed?.slug === row.slug && (
          <p role="status" style={{
            margin: 0, fontSize: "var(--fs-11)", color: "var(--clean-text)",
            lineHeight: "var(--lh-snug)",
            animation: mayAnimate ? "fade-in var(--dur-2) ease-out" : "none",
          }}>
            Landed on <span className="mono">{landed.into}</span>. The worktree is still
            here — <span className="mono">baton rm {row.slug}</span> removes it.
            {landed.archivedRef && <> History preserved at <span className="mono">{landed.archivedRef}</span>.</>}
          </p>
        )}
        {copyPrompt.kind === "pickup" && (
          <span style={{ fontSize: "var(--fs-11)", color: "var(--text-quaternary)", lineHeight: "var(--lh-snug)" }}>
            No open handoff brief for this worktree, so there is no prompt to copy.
            {writeEnabled ? " Hand off writes one." : ""}
          </span>
        )}
        {!writeEnabled && (
          <span style={{ fontSize: "var(--fs-11)", color: "var(--text-quaternary)" }}>{READ_ONLY_TIP}</span>
        )}
      </Section>
    ),
  };

  return (
    <>
      <header style={{
        display: "flex", alignItems: "center", gap: 8, padding: "11px 12px 11px 16px",
        borderBottom: "1px solid var(--border-default)", flex: "none",
      }}>
        <span className="mono" title={row.slug} style={{
          flex: 1, minWidth: 0, fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{displayName(row)}</span>
        <button className="btn btn-sm btn-ghost btn-icon fr" onClick={onClose} aria-label="Close worktree panel">
          <Icon name="x" size={14} />
        </button>
      </header>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {PANEL_SECTION_ORDER.map((id) => sections[id])}
      </div>

      {/* THE CONFIRMATION NAMES THE CONSEQUENCE IN MONO — the convention
          features/Board.tsx:304 and features/Recover.tsx already follow. What
          is different here is that the target branch is READ, not written into
          the copy: Board's dialog says the word "main" literally, and on this
          canvas that would be a sentence about a branch the merge may not be
          on. Both numbers below come from the daemon: the branch from
          /api/meta, the commit count from the worktree row's `ahead`. */}
      <ConfirmDialog
        open={dialog === "merge" && merge.enabled}
        onClose={() => { if (!busy) setDialog(null); }}
        onConfirm={() => { void doMerge(); }}
        busy={busy}
        tone={merge.enabled && merge.behind > 0 ? "warn" : "default"}
        icon="gitMerge"
        title={merge.enabled ? `Merge into ${merge.target}?` : "Merge"}
        confirmLabel="Merge branch"
        body={merge.enabled && (
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <span>
              Squash <span className="mono" style={{ color: "var(--text-primary)" }}>{merge.commits}</span>{" "}
              commit{merge.commits === 1 ? "" : "s"} from{" "}
              <span className="mono" style={{ color: "var(--text-primary)" }}>{row.branch}</span>{" "}
              into <span className="mono" style={{ color: "var(--text-primary)" }}>{merge.target}</span>.
            </span>
            <span style={{ color: "var(--text-tertiary)" }}>
              {/* Not a flourish: the branch this lands on is the one the DAEMON
                  is standing on, not the task's own base. Someone reading a
                  canvas of a dozen worktrees cannot see that from here, so it
                  is said. */}
              That is the branch the daemon reports it is on — not this task&apos;s
              base branch. Full history is kept at{" "}
              <span className="mono">refs/baton/archive/{row.slug}</span>, and the
              worktree is left in place.
            </span>
            {merge.commits === 0 && (
              <span style={{ color: "var(--text-tertiary)" }}>
                This branch has no commits{" "}
                <span className="mono">{merge.target}</span> does not already have, so
                the merge would land nothing.
              </span>
            )}
            {merge.behind > 0 && (
              <span style={{ color: "var(--dirty-text)" }}>
                It is {merge.behind} commit{merge.behind === 1 ? "" : "s"} behind{" "}
                <span className="mono">{merge.target}</span>, so the merge may halt on
                conflicts — in which case nothing lands and the panel says so.
              </span>
            )}
            {refusal && <span style={{ color: "var(--conflict-text)" }}>{refusal}</span>}
          </div>
        )}
      />

      <ConfirmDialog
        open={dialog === "takeover"}
        onClose={() => setDialog(null)}
        onConfirm={() => { if (agent.trim()) doTakeover(); }}
        busy={busy || !agent.trim()}
        tone="danger"
        icon="cornerUpRight"
        title={`Take over ${row.slug}?`}
        confirmLabel="Take over"
        body={
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <span>
              {/* Not softened: this is a data-loss operation on somebody's
                  dirty worktree, and the daemon says so. */}
              Handing over a worktree with uncommitted work in it is a data-loss
              operation, not a retry. The daemon refuses it unless the holder is
              genuinely stalled.
            </span>
            {row.unprotected.atRisk && (
              <span style={{ color: "var(--conflict-text)" }}>
                {row.unprotected.lines} uncommitted lines here exist nowhere else.
              </span>
            )}
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "var(--fs-12)" }}>
              Agent adopting this worktree
              {/* `data-autofocus` rather than `autoFocus`: the shared focus
                  trap deliberately prefers that attribute and would otherwise
                  pull focus onto the confirm button 40ms later, sending the
                  agent name nowhere (hooks/useFocusTrap.ts:31). */}
              <input data-autofocus list="baton-takeover-agents" value={agent}
                placeholder="claude" onChange={(e) => setAgent(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !busy && agent.trim()) doTakeover(); }}
                style={{
                  height: 32, padding: "0 10px", background: "var(--bg-input)", color: "var(--text-primary)",
                  border: "1px solid var(--border-default)", borderRadius: "var(--r-sm)",
                  fontSize: "var(--fs-13)", fontFamily: "inherit", outline: "none",
                }} />
              <datalist id="baton-takeover-agents">
                {AGENT_REGISTRY.filter((a) => a.id != null).map((a) => <option key={a.id} value={a.id!} />)}
              </datalist>
            </label>
            {refusal && <span style={{ color: "var(--conflict-text)" }}>{refusal}</span>}
          </div>
        }
      />

      <ConfirmDialog
        open={dialog === "pause"}
        onClose={() => setDialog(null)}
        onConfirm={doPause}
        busy={busy}
        icon="pause"
        title={`Hand ${row.slug} back?`}
        confirmLabel="Pause"
        body={
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <span>
              Ownership is dropped. The worktree, the branch and every
              uncommitted line stay exactly where they are.
            </span>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "var(--fs-12)" }}>
              Why it stopped <span style={{ color: "var(--text-quaternary)" }}>(optional, but a stop with no reason looks like a crash)</span>
              <input data-autofocus value={reason}
                placeholder="out of context" onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !busy) doPause(); }}
                style={{
                  height: 32, padding: "0 10px", background: "var(--bg-input)", color: "var(--text-primary)",
                  border: "1px solid var(--border-default)", borderRadius: "var(--r-sm)",
                  fontSize: "var(--fs-13)", fontFamily: "inherit", outline: "none",
                }} />
            </label>
            {refusal && <span style={{ color: "var(--conflict-text)" }}>{refusal}</span>}
          </div>
        }
      />
    </>
  );
}
