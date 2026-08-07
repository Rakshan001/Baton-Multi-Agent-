/**
 * The pipeline as the dashboard draws it — phase 7's swimlanes (§10).
 *
 * A projection, not a rule. Every decision here is already made by the pure
 * functions in `pipeline.ts` (`openPhase`, `blockers`, `phaseComplete`,
 * `isDeadlocked`); this groups their answers into lanes and hands them over in
 * one payload. That direction matters: a dashboard that re-derived "is this
 * phase open" in TypeScript in the browser would be a second implementation of
 * the barrier, and the two would disagree exactly when it mattered — the board
 * saying a task is startable while every agent is refused it.
 *
 * So the view computes nothing the CLI does not. It only decides what to *call*
 * things, which is the one job a view should have.
 *
 * Pure and filesystem-free, so the lane grouping is testable without a server,
 * a browser, or a repo.
 */
import {
  blockers, integrationHold, isDeadlocked, openPhase, phaseComplete, phaseOf, stateOf,
  type EligibilityOpts, type PipelineTask, type TaskState,
} from './pipeline.js';

/**
 * What a lane header says about its phase.
 *
 * `holding` is separate from `complete` on purpose: both mean every task in the
 * phase is finished, but one of them is the reason the next lane cannot start.
 * Collapsing them would leave the board showing a finished phase, a locked
 * phase, and no visible cause for the lock.
 */
export type LaneStatus = 'ungated' | 'complete' | 'holding' | 'open' | 'locked';

export interface LaneTask {
  slug: string;
  title: string;
  phase: number;
  state: TaskState;
  /** Agent id this task is reserved for, or null for the open pool. */
  assignee: string | null;
  /** Who is on it right now. Null when nobody holds it. */
  holder: { agent: string; sessionSlug: string; at: string } | null;
  dependsOn: string[];
  planId: string | null;
  /**
   * Why this task cannot be started right now, in the pipeline's own wording,
   * or null when nothing is stopping it.
   *
   * Taken verbatim from `blockers()` rather than rephrased for the UI. A
   * dashboard that invents its own phrasing for a refusal teaches a vocabulary
   * the CLI does not answer to, and the person reading it goes looking for a
   * command that says the same thing.
   */
  blocker: string | null;
  branch: string;
  /** Set once cancelled — who stopped it and why, for the lane badge. */
  cancelledBy?: { actor: string; at: string; reason?: string };
  stoppedReason?: string;
}

export interface Lane {
  phase: number;
  status: LaneStatus;
  tasks: LaneTask[];
  /** Finished / total, for the lane's progress read-out. */
  done: number;
  total: number;
}

export interface PlanSummary {
  id: string;
  total: number;
  done: number;
  cancelled: number;
}

export interface PipelineView {
  /**
   * The highest phase work may start in — or null when there is none left.
   *
   * `openPhase` returns `Infinity` for a finished plan, and `Infinity` is not
   * representable in JSON: `JSON.stringify` turns it into `null` silently. That
   * conversion is done HERE, deliberately and once, so the client reads an
   * explicit "nothing open" rather than a number that vanished in transit.
   */
  openPhase: number | null;
  /** The phase that is finished but unintegrated, and is holding the barrier. */
  integrationHold: number | null;
  /** Work remains and no agent can start any of it — needs a human. */
  deadlocked: boolean;
  lanes: Lane[];
  plans: PlanSummary[];
  totals: { total: number; done: number; active: number; blocked: number; cancelled: number };
}

const FINISHED: ReadonlySet<TaskState> = new Set<TaskState>(['done', 'cancelled']);

function laneStatus(phase: number, tasks: readonly PipelineTask[], open: number, held: number | null): LaneStatus {
  if (phase === 0) return 'ungated';
  if (held !== null && phase === held) return 'holding';
  if (phaseComplete(tasks, phase)) return 'complete';
  if (phase === open) return 'open';
  return 'locked';
}

/** One row, flattened for transport. */
function toLaneTask(t: PipelineTask & { task?: string; branch?: string }, blocker: string | null): LaneTask {
  return {
    slug: t.slug,
    title: t.task ?? t.slug,
    phase: phaseOf(t),
    state: stateOf(t),
    assignee: t.assignee ?? null,
    holder: t.claimedBy ?? null,
    dependsOn: t.dependsOn ?? [],
    planId: t.planId ?? null,
    blocker,
    branch: t.branch ?? '',
    ...(t.cancelledBy ? { cancelledBy: t.cancelledBy } : {}),
    ...(t.stoppedReason ? { stoppedReason: t.stoppedReason } : {}),
  };
}

/**
 * The whole board, grouped into lanes.
 *
 * `opts` is the same `EligibilityOpts` the CLI passes, so a hub serving a
 * plan with an integration barrier reports the same open phase the agents on
 * it are being held at.
 */
export function pipelineView(
  tasks: readonly (PipelineTask & { task?: string; branch?: string })[],
  opts: EligibilityOpts = {},
): PipelineView {
  const open = openPhase(tasks, opts);
  const held = integrationHold(tasks, opts);
  // Indexed once: blockers() walks every task, and asking it per-row would be
  // quadratic on a board a plan can easily push past a hundred rows.
  const why = new Map(blockers(tasks, opts).map((b) => [b.slug, b.reason]));

  const phases = [...new Set(tasks.map(phaseOf))].sort((a, b) => a - b);
  const lanes: Lane[] = phases.map((phase) => {
    const inPhase = tasks.filter((t) => phaseOf(t) === phase);
    return {
      phase,
      status: laneStatus(phase, tasks, open, held),
      tasks: inPhase.map((t) => toLaneTask(t, why.get(t.slug) ?? null)),
      done: inPhase.filter((t) => FINISHED.has(stateOf(t))).length,
      total: inPhase.length,
    };
  });

  const planIds = [...new Set(tasks.map((t) => t.planId).filter((p): p is string => !!p))].sort();
  const plans: PlanSummary[] = planIds.map((id) => {
    const rows = tasks.filter((t) => t.planId === id);
    return {
      id,
      total: rows.length,
      done: rows.filter((t) => stateOf(t) === 'done').length,
      cancelled: rows.filter((t) => stateOf(t) === 'cancelled').length,
    };
  });

  return {
    openPhase: Number.isFinite(open) ? open : null,
    integrationHold: held,
    deadlocked: isDeadlocked(tasks, opts),
    lanes,
    plans,
    totals: {
      total: tasks.length,
      done: tasks.filter((t) => stateOf(t) === 'done').length,
      active: tasks.filter((t) => stateOf(t) === 'active').length,
      blocked: tasks.filter((t) => stateOf(t) === 'blocked').length,
      cancelled: tasks.filter((t) => stateOf(t) === 'cancelled').length,
    },
  };
}
