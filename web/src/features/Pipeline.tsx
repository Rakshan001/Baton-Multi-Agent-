/* ============================================================
   BATON — Pipeline screen (spec §10, phase 7)

   Phase swimlanes, the plan document, and cancellation with a blast
   radius. Mirrors GET /api/pipeline · GET /api/pipeline/plans/:id ·
   POST /api/pipeline/cancel (src/pipeline-view.ts, src/server.ts).

   The screen answers ONE question the board cannot: why is work not
   starting? A lane is locked, a dependency is unmet, a phase is finished
   but unintegrated, a task is waiting on a human. Every one of those
   answers comes from the daemon in the row's `blocker` field and is
   rendered verbatim — this screen never decides eligibility itself. Two
   implementations of the phase barrier would disagree exactly when it
   mattered, and the browser's copy would be the one that is wrong.

   Cancellation is the only write here, and it is deliberately two steps:
   the preview is a real dry run against the live board, not a guess
   assembled from what the browser last polled.
   ============================================================ */
import { useCallback, useMemo, useState } from "react";
import { Icon, type IconName } from "../components/Icon";
import { CardSkeleton, ConfirmDialog, EmptyState, ErrorState, Sheet } from "../components/primitives";
import { AgentGlyph, getAgent } from "../lib/registry";
import { ScreenHeader } from "./shared";
import { BatonAPI } from "../lib/api";
import { usePoll } from "../hooks/usePoll";
import { showToast } from "../lib/toast";
import type { CancelResult, CancelScopeInput, Lane, LaneStatus, LaneTask, PipelineView, TaskState } from "../types";

/* ---------- lane + state vocabulary ---------- */

const LANE_META: Record<LaneStatus, { label: string; color: string; icon: IconName; blurb: string }> = {
  ungated: { label: "Ungated", color: "var(--idle)", icon: "layers", blurb: "Hand-made tasks — not part of a plan, never held by a phase." },
  complete: { label: "Complete", color: "var(--ok)", icon: "checkCircle", blurb: "Every task finished and landed on the base." },
  holding: { label: "Holding", color: "var(--dirty)", icon: "gitMerge", blurb: "Finished, but the branches have not landed — this is what is locking the next phase. Run: baton integrate" },
  open: { label: "Open", color: "var(--accent)", icon: "play", blurb: "Agents may start work here now." },
  locked: { label: "Locked", color: "var(--idle)", icon: "lock", blurb: "Waiting on an earlier phase to finish and land." },
};

const STATE_COLOR: Record<TaskState, string> = {
  queued: "var(--idle)",
  claimed: "var(--accent)",
  active: "var(--accent)",
  paused: "var(--dirty)",
  review: "var(--dirty)",
  blocked: "var(--conflict)",
  done: "var(--ok)",
  cancelled: "var(--idle)",
};

/* ---------- small pieces ---------- */

function StatePill({ state }: { state: TaskState }) {
  const c = STATE_COLOR[state] ?? "var(--idle)";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5, height: 20, padding: "0 8px",
      borderRadius: 999, fontSize: "var(--fs-11)", fontWeight: "var(--fw-medium)", letterSpacing: "var(--ls-snug)",
      color: c, background: `color-mix(in srgb, ${c} 13%, transparent)`,
      border: `1px solid color-mix(in srgb, ${c} 30%, transparent)`,
      textDecoration: state === "cancelled" ? "line-through" : "none",
    }}>
      {state === "active" && <span style={{ width: 5, height: 5, borderRadius: 999, background: c, animation: "pulse 1.8s ease-in-out infinite" }} />}
      {state}
    </span>
  );
}

function Chip({ children, tone = "default", title }: { children: React.ReactNode; tone?: "default" | "warn"; title?: string }) {
  const c = tone === "warn" ? "var(--conflict)" : "var(--text-tertiary)";
  return (
    <span title={title} style={{
      display: "inline-flex", alignItems: "center", gap: 4, height: 19, padding: "0 7px", borderRadius: "var(--r-sm)",
      fontSize: "var(--fs-11)", fontFamily: "var(--font-mono)", color: c,
      background: "var(--bg-input)", border: "1px solid var(--border-subtle)", maxWidth: "100%",
      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

function TaskCard({ task, onCancel, canCancel }: { task: LaneTask; onCancel: () => void; canCancel: boolean }) {
  const agentId = task.holder?.agent ?? task.assignee ?? null;
  const agent = agentId ? getAgent(agentId as never) : null;
  const dimmed = task.state === "cancelled" || task.state === "done";
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 8, padding: "11px 12px", minWidth: 0,
      background: "var(--bg-surface)", border: "1px solid var(--border-default)", borderRadius: "var(--r-md)",
      opacity: dimmed ? 0.62 : 1,
      borderLeft: `3px solid ${STATE_COLOR[task.state] ?? "var(--idle)"}`,
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: "var(--fs-13)", fontWeight: "var(--fw-medium)", lineHeight: "var(--lh-snug)",
            textDecoration: task.state === "cancelled" ? "line-through" : "none",
          }}>{task.title}</div>
          <div style={{ fontSize: "var(--fs-11)", fontFamily: "var(--font-mono)", color: "var(--text-tertiary)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {task.slug}
          </div>
        </div>
        {agent && (
          <span title={task.holder ? `${agent.label} is on it now` : `reserved for ${agent.label}`}
            style={{ flex: "none", opacity: task.holder ? 1 : 0.55 }}>
            <AgentGlyph id={agent.id} size={20} />
          </span>
        )}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}>
        <StatePill state={task.state} />
        {task.dependsOn.map((d) => (
          <Chip key={d} title={`depends on ${d}`}>↳ {d}</Chip>
        ))}
      </div>

      {/*
        The blocker, in the pipeline's own words. Rendered as-is on purpose:
        this is the string `baton next` prints, so someone who reads it here
        and types it there is talking about the same thing.
      */}
      {task.blocker && task.state !== "active" && task.state !== "done" && (
        <div style={{
          display: "flex", gap: 6, alignItems: "flex-start", fontSize: "var(--fs-11)",
          color: task.state === "blocked" ? "var(--conflict)" : "var(--text-tertiary)", lineHeight: "var(--lh-snug)",
        }}>
          <Icon name={task.state === "blocked" ? "alertTriangle" : "lock"} size={12} style={{ flex: "none", marginTop: 1 }} />
          <span>{task.blocker}</span>
        </div>
      )}

      {task.cancelledBy && (
        <div style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)" }}>
          cancelled by {task.cancelledBy.actor}
          {task.cancelledBy.reason ? ` — ${task.cancelledBy.reason}` : ""}
          {/* Says what did NOT happen, because that is the part people doubt. */}
          <div style={{ marginTop: 2, opacity: 0.8 }}>branch <code>{task.branch}</code> kept</div>
        </div>
      )}

      {canCancel && task.state !== "done" && task.state !== "cancelled" && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button className="btn fr" onClick={onCancel} style={{ height: 24, padding: "0 8px", fontSize: "var(--fs-11)" }}>
            <Icon name="square" size={11} /> Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function LaneHeader({ lane, onCancelPhase, canCancel }: { lane: Lane; onCancelPhase: () => void; canCancel: boolean }) {
  const meta = LANE_META[lane.status];
  const pct = lane.total ? Math.round((lane.done / lane.total) * 100) : 0;
  const stoppable = lane.tasks.some((t) => t.state !== "done" && t.state !== "cancelled");
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 11, flexWrap: "wrap", marginBottom: 9 }}>
      <div style={{
        display: "inline-flex", alignItems: "center", gap: 7, height: 26, padding: "0 10px", borderRadius: 999,
        color: meta.color, background: `color-mix(in srgb, ${meta.color} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${meta.color} 32%, transparent)`,
      }}>
        <Icon name={meta.icon} size={13} />
        <span style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)" }}>
          {lane.phase === 0 ? "Ungated" : `Phase ${lane.phase}`}
        </span>
        <span style={{ fontSize: "var(--fs-11)", opacity: 0.85 }}>· {meta.label}</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 120 }}>
        <div style={{ width: 78, height: 4, borderRadius: 999, background: "var(--bg-input)", overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: meta.color, transition: "width var(--dur-3) var(--ease-out)" }} />
        </div>
        <span style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)", fontVariantNumeric: "tabular-nums" }}>
          {lane.done}/{lane.total}
        </span>
      </div>

      <span style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)", flex: "1 1 200px", minWidth: 0 }}>
        {meta.blurb}
      </span>

      {canCancel && stoppable && (
        <button className="btn fr" onClick={onCancelPhase} style={{ height: 26, padding: "0 9px", fontSize: "var(--fs-11)" }}>
          <Icon name="square" size={11} /> Cancel phase
        </button>
      )}
    </div>
  );
}

/* ---------- the plan document ---------- */

/**
 * A deliberately small markdown renderer — headings, checkboxes, code, text.
 *
 * It builds React elements and never touches innerHTML. That is the whole
 * design: a plan is a file any contributor can commit, and `baton/plans` is
 * tracked, so "who can open a PR" would otherwise become "who can run script
 * in the operator's dashboard". React escapes text nodes by construction, so
 * the safety here is structural rather than a sanitiser someone has to
 * maintain. Anything it does not understand is shown as plain text, which is
 * the correct failure: a plan you can read beats a plan that renders prettily.
 */
function PlanMarkdown({ text }: { text: string }) {
  const blocks = useMemo(() => {
    const out: React.ReactNode[] = [];
    const lines = text.split("\n");
    let fence: string[] | null = null;
    lines.forEach((line, i) => {
      if (line.trim().startsWith("```")) {
        if (fence) {
          out.push(<pre key={i} style={{ margin: "8px 0", padding: 10, background: "var(--bg-input)", border: "1px solid var(--border-subtle)", borderRadius: "var(--r-sm)", fontSize: "var(--fs-12)", overflowX: "auto" }}>{fence.join("\n")}</pre>);
          fence = null;
        } else fence = [];
        return;
      }
      if (fence) { fence.push(line); return; }

      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        const level = h[1].length;
        out.push(
          <div key={i} style={{
            fontSize: level === 1 ? "var(--fs-16)" : level === 2 ? "var(--fs-14)" : "var(--fs-13)",
            fontWeight: "var(--fw-semibold)", marginTop: out.length ? 16 : 0, marginBottom: 4,
            color: level <= 2 ? "var(--text-primary)" : "var(--text-secondary)",
          }}>{h[2]}</div>,
        );
        return;
      }

      const box = /^\s*-\s*\[( |x|X)\]\s+(.*)$/.exec(line);
      if (box) {
        const checked = box[1].toLowerCase() === "x";
        out.push(
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "3px 0", fontSize: "var(--fs-13)" }}>
            <Icon name={checked ? "checkCircle" : "square"} size={14}
              style={{ flex: "none", marginTop: 2, color: checked ? "var(--ok)" : "var(--text-tertiary)" }} />
            <span style={{ color: checked ? "var(--text-tertiary)" : "var(--text-secondary)", textDecoration: checked ? "line-through" : "none" }}>
              {box[2]}
            </span>
          </div>,
        );
        return;
      }

      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      if (bullet) {
        out.push(<div key={i} style={{ display: "flex", gap: 8, fontSize: "var(--fs-13)", color: "var(--text-secondary)", padding: "2px 0" }}><span style={{ color: "var(--text-tertiary)" }}>·</span><span>{bullet[1]}</span></div>);
        return;
      }

      if (!line.trim()) { out.push(<div key={i} style={{ height: 6 }} />); return; }
      out.push(<div key={i} style={{ fontSize: "var(--fs-13)", color: "var(--text-secondary)", lineHeight: "var(--lh-normal)", padding: "2px 0" }}>{line}</div>);
    });
    return out;
  }, [text]);

  return <div>{blocks}</div>;
}

function PlanSheet({ planId, onClose }: { planId: string; onClose: () => void }) {
  const plan = usePoll(() => BatonAPI.getPlan(planId), { interval: 0, deps: [planId] });
  return (
    <Sheet open onClose={onClose} width={620} labelledBy="plan-title">
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", borderBottom: "1px solid var(--border-subtle)" }}>
        <Icon name="list" size={16} style={{ color: "var(--accent)" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 id="plan-title" style={{ margin: 0, fontSize: "var(--fs-15)", fontWeight: "var(--fw-semibold)" }}>{planId}</h2>
          <div style={{ fontSize: "var(--fs-11)", fontFamily: "var(--font-mono)", color: "var(--text-tertiary)" }}>
            {plan.data?.path ?? `baton/plans/${planId}.md`}
          </div>
        </div>
        <button className="btn fr" onClick={onClose} aria-label="Close"><Icon name="x" size={14} /></button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 18px 28px" }}>
        {plan.error
          ? <ErrorState title="Could not read the plan" desc={(plan.error as Error).message} onRetry={plan.refetch} />
          : plan.data
            ? <PlanMarkdown text={plan.data.markdown} />
            : <CardSkeleton />}
      </div>
    </Sheet>
  );
}

/* ---------- the cancel confirmation ---------- */

/**
 * The blast radius, rendered from a REAL dry run.
 *
 * `stranding` leads, because it is the consequence nobody predicts: a
 * cancelled task never reaches `done`, so anything depending on it can never
 * start. The rest of the dialog is the reassurance — nothing is deleted, and
 * the stop is not instant.
 */
function RadiusBody({ preview }: { preview: CancelResult }) {
  const { radius, agentsStopped } = preview;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
      <div>
        Cancelling <strong>{preview.scope}</strong> stops <strong>{radius.stopping.length}</strong>{" "}
        task{radius.stopping.length === 1 ? "" : "s"}
        {agentsStopped > 0 && <> and <strong>{agentsStopped}</strong> working agent{agentsStopped === 1 ? "" : "s"}</>}.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 3, maxHeight: 150, overflowY: "auto" }}>
        {radius.stopping.map((s) => (
          <div key={s.slug} style={{ display: "flex", gap: 7, alignItems: "center", fontSize: "var(--fs-12)" }}>
            <span style={{ width: 5, height: 5, borderRadius: 999, background: STATE_COLOR[s.state] ?? "var(--idle)", flex: "none" }} />
            <span style={{ fontFamily: "var(--font-mono)" }}>{s.slug}</span>
            <span style={{ color: "var(--text-tertiary)" }}>
              {s.state}{s.holder ? ` — ${s.holder} is on it now` : ""}
            </span>
          </div>
        ))}
      </div>

      {radius.alreadyFinished.length > 0 && (
        <div style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>
          {radius.alreadyFinished.length} already finished, untouched.
        </div>
      )}

      {radius.stranding.length > 0 && (
        <div style={{
          padding: "9px 11px", borderRadius: "var(--r-sm)", background: "color-mix(in srgb, var(--conflict) 10%, transparent)",
          border: "1px solid color-mix(in srgb, var(--conflict) 32%, transparent)", color: "var(--conflict)",
          display: "flex", flexDirection: "column", gap: 4,
        }}>
          <strong style={{ fontSize: "var(--fs-12)" }}>
            {radius.stranding.length} task{radius.stranding.length === 1 ? "" : "s"} will be stranded — they depend on this and can never start:
          </strong>
          {radius.stranding.map((s) => (
            <div key={s.slug} style={{ fontSize: "var(--fs-12)", fontFamily: "var(--font-mono)" }}>
              {s.slug} → needs {s.dependsOn.join(", ")}
            </div>
          ))}
          <span style={{ fontSize: "var(--fs-11)", opacity: 0.9 }}>Cancel those too, or edit the plan and re-apply.</span>
        </div>
      )}

      <div style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)", lineHeight: "var(--lh-snug)" }}>
        Nothing is deleted — branches, worktrees and checkpoints all stay.
        Agents still running learn on their next tool call and stop there.
      </div>
    </div>
  );
}

/* ---------- screen ---------- */

interface Pending { scope: CancelScopeInput; preview: CancelResult | null; reason: string }

export function PipelineScreen({ writeEnabled }: { writeEnabled: boolean }) {
  const pipeline = usePoll<PipelineView>(() => BatonAPI.getPipeline(), { interval: 5000 });
  const [planOpen, setPlanOpen] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  const view = pipeline.data;
  const canCancel = writeEnabled;

  /*
   * The preview is a dry run against the LIVE board, not a radius assembled
   * from the last poll. Between the click and the confirmation an agent can
   * claim, finish or block a task — and a confirmation computed from stale
   * data would name work the person never agreed to stop.
   */
  const openCancel = useCallback(async (scope: CancelScopeInput) => {
    setPending({ scope, preview: null, reason: "" });
    try {
      const preview = await BatonAPI.cancelPipeline(scope, { dryRun: true });
      if (!preview.radius.stopping.length) {
        setPending(null);
        showToast({ kind: "ok", title: "Nothing to cancel", desc: `${preview.scope} has no unfinished tasks.` });
        return;
      }
      setPending((p) => (p ? { ...p, preview } : p));
    } catch (e) {
      setPending(null);
      showToast({ kind: "error", title: "Could not preview", desc: (e as Error).message });
    }
  }, []);

  const confirmCancel = useCallback(async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const res = await BatonAPI.cancelPipeline(pending.scope, { reason: pending.reason.trim() || undefined });
      setPending(null);
      showToast({
        kind: "ok",
        title: `Cancelled ${res.cancelled.length} task${res.cancelled.length === 1 ? "" : "s"}`,
        desc: "Branches and worktrees kept. Running agents stop on their next tool call.",
      });
      pipeline.refetch();
    } catch (e) {
      showToast({ kind: "error", title: "Cancel failed", desc: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, [pending, pipeline]);

  if (pipeline.error && !view) {
    return <ErrorState title="Could not load the pipeline" desc={(pipeline.error as Error).message} onRetry={pipeline.refetch} />;
  }

  const subtitle = !view ? undefined
    : view.openPhase === null
      ? "Every phase is finished."
      : `Phase ${view.openPhase} is open · ${view.totals.done}/${view.totals.total} done`;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <ScreenHeader title="Pipeline" subtitle={subtitle}>
        {(view?.plans ?? []).map((p) => (
          <button key={p.id} className="btn fr" onClick={() => setPlanOpen(p.id)}>
            <Icon name="list" size={13} /> {p.id}
            <span style={{ color: "var(--text-tertiary)", fontVariantNumeric: "tabular-nums" }}>{p.done}/{p.total}</span>
          </button>
        ))}
      </ScreenHeader>

      <div style={{ flex: 1, overflowY: "auto", padding: "14px 20px 32px", display: "flex", flexDirection: "column", gap: 18 }}>
        {/*
          Deadlock is a distinct outcome from "finished", and the distinction is
          the whole point: one is success, the other is waiting for a person and
          will wait forever unless someone is told.
        */}
        {view?.deadlocked && (
          <div style={{
            display: "flex", gap: 9, alignItems: "flex-start", padding: "11px 13px", borderRadius: "var(--r-md)",
            background: "color-mix(in srgb, var(--conflict) 10%, transparent)",
            border: "1px solid color-mix(in srgb, var(--conflict) 32%, transparent)", color: "var(--conflict)",
          }}>
            <Icon name="alertOctagon" size={16} style={{ flex: "none", marginTop: 1 }} />
            <div style={{ fontSize: "var(--fs-13)", lineHeight: "var(--lh-snug)" }}>
              <strong>Nothing can start.</strong> Work remains, but every remaining task is waiting on a
              decision — no agent can pick anything up until one of the blockers below is resolved.
            </div>
          </div>
        )}

        {view?.integrationHold != null && (
          <div style={{
            display: "flex", gap: 9, alignItems: "flex-start", padding: "11px 13px", borderRadius: "var(--r-md)",
            background: "color-mix(in srgb, var(--dirty) 10%, transparent)",
            border: "1px solid color-mix(in srgb, var(--dirty) 32%, transparent)", color: "var(--dirty)",
          }}>
            <Icon name="gitMerge" size={16} style={{ flex: "none", marginTop: 1 }} />
            <div style={{ fontSize: "var(--fs-13)", lineHeight: "var(--lh-snug)" }}>
              <strong>Phase {view.integrationHold} is finished but has not landed.</strong>{" "}
              Its branches exist side by side and have never been combined, so the next phase is held
              until they do. Run <code>baton integrate</code>.
            </div>
          </div>
        )}

        {!view && <CardSkeleton />}

        {view && view.lanes.length === 0 && (
          <EmptyState icon="layers" title="No tasks yet"
            desc="Apply a plan to fill the pipeline, or create a single task." command="baton plan apply <file>" />
        )}

        {view?.lanes.map((lane) => (
          <section key={lane.phase}>
            <LaneHeader lane={lane} canCancel={canCancel} onCancelPhase={() => openCancel({ phase: lane.phase })} />
            <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fill, minmax(232px, 1fr))" }}>
              {lane.tasks.map((task) => (
                <TaskCard key={task.slug} task={task} canCancel={canCancel} onCancel={() => openCancel({ slug: task.slug })} />
              ))}
            </div>
          </section>
        ))}
      </div>

      {planOpen && <PlanSheet planId={planOpen} onClose={() => setPlanOpen(null)} />}

      <ConfirmDialog
        open={!!pending}
        onClose={() => !busy && setPending(null)}
        onConfirm={confirmCancel}
        busy={busy || !pending?.preview}
        tone="danger"
        icon="alertTriangle"
        title="Cancel work?"
        confirmLabel="Cancel this work"
        body={pending?.preview
          ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <RadiusBody preview={pending.preview} />
              <input
                value={pending.reason}
                onChange={(e) => setPending((p) => (p ? { ...p, reason: e.target.value } : p))}
                placeholder="Reason (optional) — recorded on every cancelled task"
                aria-label="Reason for cancelling"
                style={{
                  height: 32, padding: "0 10px", background: "var(--bg-input)", color: "var(--text-primary)",
                  border: "1px solid var(--border-default)", borderRadius: "var(--r-sm)",
                  fontSize: "var(--fs-13)", fontFamily: "inherit", outline: "none",
                }} />
            </div>
          )
          : "Checking what this would touch…"}
      />
    </div>
  );
}
