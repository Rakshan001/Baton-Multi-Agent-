/**
 * The task pipeline: ordering, assignment, and lifecycle.
 *
 * Everything here is PURE — no filesystem, no git, no clock of its own. That is
 * deliberate: this is the logic that decides which agent may touch which work,
 * and it has to be provable by unit test rather than by running a fleet. The
 * two facts it cannot compute itself (is a dependency's work fetchable, and
 * when was this agent last alive) arrive as injected functions.
 *
 * Design: docs/superpowers/specs/2026-08-05-task-pipeline-design.md
 */

/**
 * Stored lifecycle states.
 *
 * `stalled` and `locked` are deliberately NOT here. They are COMPUTED from
 * heartbeat age and phase position every time they are read, never written —
 * which is what lets the pipeline work with no daemon running, and what makes
 * it impossible for a crashed process to leave a board that lies.
 */
export type TaskState =
  | 'queued'     // planned, nobody has it
  | 'claimed'    // won the claim; worktree being materialized
  | 'active'     // an agent is working
  | 'blocked'    // the agent reported it cannot proceed; still owned
  | 'review'     // evidence passed, awaiting a verdict
  | 'done'
  | 'cancelled'; // stopped by a human, or deliberately dropped

export const TASK_STATES: readonly TaskState[] = [
  'queued', 'claimed', 'active', 'blocked', 'review', 'done', 'cancelled',
];

/**
 * States that no longer hold up a phase. `cancelled` counts alongside `done` on
 * purpose: without it, one deliberately dropped task wedges the barrier — and
 * therefore the whole plan — permanently.
 */
const TERMINAL: ReadonlySet<TaskState> = new Set<TaskState>(['done', 'cancelled']);

/** Default silence before an `active` task is offered to someone else. */
export const STALL_GRACE_MS = 45 * 60_000;

/** The pipeline half of a Task. Every field optional, so records written before
 *  the pipeline existed still load and still behave. */
export interface PipelineFields {
  planId?: string;
  /** 1-based. Absent means "not part of a plan" — see `phaseOf`. */
  phase?: number;
  dependsOn?: string[];
  /** Agent id, or null/absent for the open pool that anyone may claim. */
  assignee?: string | null;
  skills?: string[];
  principles?: string[];
  expects?: string[];
  state?: TaskState;
  claimedBy?: { agent: string; sessionSlug: string; at: string };
  contributors?: Array<{ agent: string; from: string; to?: string }>;
  stoppedReason?: string;
  cancelledBy?: { actor: string; at: string; reason?: string };
  /** Team mode: proof the work is on the shared remote, not just this disk. */
  pushedSha?: string;
  reviewedBy?: { actor: string; at: string; verdict: 'approve' | 'reject' };
}

/** The minimum a task must expose for the pipeline to reason about it. */
export interface PipelineTask extends PipelineFields {
  slug: string;
}

/**
 * A task with no recorded state is `queued`. Records that predate the pipeline
 * also have no phase, and `phaseOf` keeps those out of the gating entirely — so
 * defaulting to queued here cannot wedge anything.
 */
export function stateOf(t: PipelineTask): TaskState {
  return t.state ?? 'queued';
}

/**
 * Phase 0 means "ungated". A task carries a phase only when a plan gave it one;
 * everything else — a task made by hand, or one recorded before plans existed —
 * sits at 0, is always eligible, and never holds the barrier against phase 1.
 * Without that, a single stale legacy task would lock every plan forever.
 */
export function phaseOf(t: PipelineTask): number {
  return t.phase && t.phase > 0 ? t.phase : 0;
}

/**
 * The lowest phase still holding work, or Infinity when every phased task is
 * finished. Phase 0 is skipped: it is the ungated bucket, not a real phase.
 */
export function openPhase(tasks: readonly PipelineTask[]): number {
  let open = Infinity;
  for (const t of tasks) {
    const p = phaseOf(t);
    if (p >= 1 && !TERMINAL.has(stateOf(t)) && p < open) open = p;
  }
  return open;
}

/** Why one dependency is not satisfied, or null when it is. */
function depBlocker(
  dep: PipelineTask | undefined,
  slug: string,
  isFetchable?: (sha: string | undefined) => boolean,
): string | null {
  if (!dep) return `depends on unknown task '${slug}'`;
  const st = stateOf(dep);
  if (st === 'cancelled') return `depends on '${slug}', which was cancelled`;
  if (st !== 'done') return `depends on '${slug}' (${st})`;
  // Team mode only. `done` on a teammate's laptop does not mean the commits are
  // reachable here — starting against them would build on code that exists
  // nowhere this machine can see.
  if (isFetchable && !isFetchable(dep.pushedSha)) return `waiting for '${slug}' to be pushed`;
  return null;
}

export interface EligibilityOpts {
  /**
   * Team mode: given a dependency's recorded sha, can this machine actually
   * fetch it? Omit entirely in solo mode, where `done` already implies local.
   */
  isFetchable?: (sha: string | undefined) => boolean;
}

/**
 * The work `agent` may start right now.
 *
 * Four conditions, and each exists because of a specific failure:
 *   queued          — not already owned by someone
 *   assignee match  — null is the open pool, which is how an idle agent helps
 *                     finish a phase full of another agent's tasks
 *   phase <= open   — the barrier. Later phases stay locked so nobody builds on
 *                     foundations that are still moving
 *   deps satisfied  — and in team mode, actually fetchable
 */
export function eligibleFor(
  agent: string,
  tasks: readonly PipelineTask[],
  opts: EligibilityOpts = {},
): PipelineTask[] {
  const open = openPhase(tasks);
  const bySlug = new Map(tasks.map((t) => [t.slug, t]));
  return tasks.filter((t) => {
    if (stateOf(t) !== 'queued') return false;
    if (t.assignee != null && t.assignee !== agent) return false;
    if (phaseOf(t) > open) return false;
    return (t.dependsOn ?? []).every((d) => depBlocker(bySlug.get(d), d, opts.isFetchable) === null);
  });
}

export interface StallOpts {
  now: number;
  /** Epoch ms this task last showed life. In practice the NEWER of the agent's
   *  MCP heartbeat and its worktree's newest mtime — an agent running a long
   *  build makes no tool calls but is very much alive. */
  livenessOf: (t: PipelineTask) => number;
  graceMs?: number;
}

/** Computed, never stored: active but silent past the grace window. */
export function isStalled(t: PipelineTask, opts: StallOpts): boolean {
  if (stateOf(t) !== 'active') return false;
  return opts.now - opts.livenessOf(t) > (opts.graceMs ?? STALL_GRACE_MS);
}

/**
 * Stalled work another agent may adopt. Not filtered by assignee: the point of
 * takeover is that whoever is free finishes it, and the contributor chain keeps
 * attribution honest afterwards.
 */
export function takeable(tasks: readonly PipelineTask[], opts: StallOpts): PipelineTask[] {
  return tasks.filter((t) => isStalled(t, opts));
}

export interface Blocker {
  slug: string;
  reason: string;
}

/**
 * Why nothing is eligible.
 *
 * An agent told only "no work" learns nothing, and five agents each told that
 * look identical to a finished plan. So every empty answer carries its cause,
 * and a pipeline that genuinely cannot advance says so rather than going quiet.
 */
export function blockers(
  tasks: readonly PipelineTask[],
  opts: EligibilityOpts = {},
): Blocker[] {
  const open = openPhase(tasks);
  const bySlug = new Map(tasks.map((t) => [t.slug, t]));
  const out: Blocker[] = [];
  for (const t of tasks) {
    const st = stateOf(t);
    if (TERMINAL.has(st)) continue;
    if (st === 'blocked') {
      out.push({ slug: t.slug, reason: t.stoppedReason ? `blocked — ${t.stoppedReason}` : 'blocked, needs a decision' });
      continue;
    }
    if (st !== 'queued') {
      out.push({ slug: t.slug, reason: `${st}${t.claimedBy ? ` (${t.claimedBy.agent})` : ''}` });
      continue;
    }
    if (phaseOf(t) > open) {
      out.push({ slug: t.slug, reason: `phase ${phaseOf(t)} locked behind phase ${open}` });
      continue;
    }
    for (const d of t.dependsOn ?? []) {
      const why = depBlocker(bySlug.get(d), d, opts.isFetchable);
      if (why) { out.push({ slug: t.slug, reason: why }); break; }
    }
  }
  return out;
}

/**
 * True when work remains but no agent can start any of it — every remaining
 * task is waiting on a human. Distinct from "the plan is finished", and the
 * distinction is the whole point: one is success, the other needs you.
 */
export function isDeadlocked(tasks: readonly PipelineTask[], opts: EligibilityOpts = {}): boolean {
  const remaining = tasks.filter((t) => !TERMINAL.has(stateOf(t)));
  if (remaining.length === 0) return false;                       // finished, not stuck
  if (remaining.some((t) => stateOf(t) !== 'queued' && stateOf(t) !== 'blocked')) return false; // someone is working
  // Nobody is working. Could anyone start? Assignees are the only agents that
  // could possibly qualify, plus one unassigned probe for the open pool.
  const agents = new Set<string>();
  for (const t of remaining) if (t.assignee) agents.add(t.assignee);
  agents.add(' any'); // a name no agent has — exercises the open-pool path
  return [...agents].every((a) => eligibleFor(a, tasks, opts).length === 0);
}

/** Every task in `phase` is done or cancelled — so the barrier may lift. */
export function phaseComplete(tasks: readonly PipelineTask[], phase: number): boolean {
  const inPhase = tasks.filter((t) => phaseOf(t) === phase);
  return inPhase.length > 0 && inPhase.every((t) => TERMINAL.has(stateOf(t)));
}
