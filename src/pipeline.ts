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

/** Finished for good: no longer holds a phase, and never rewound by a re-apply. */
export function isTerminal(state: TaskState): boolean {
  return TERMINAL.has(state);
}

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
  /** From the plan. Absent means ON — opting out has to be written down. */
  requireReview?: boolean;
  /** Files the finished diff touched outside `scope`. Recorded, never refused. */
  outOfScope?: string[];
  /** Branch head when the done gate accepted it — what a reviewer reviews. */
  finishedSha?: string;
  /** Team mode: proof the work is on the shared remote, not just this disk. */
  pushedSha?: string;
  /** The last verdict. `notes` is the rejection's reason — the one thing the
   *  agent picking the work back up actually needs. */
  reviewedBy?: { actor: string; at: string; verdict: 'approve' | 'reject'; notes?: string };
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
 * The lowest phase with unfinished work, or Infinity when every phased task is
 * finished. Phase 0 is skipped: it is the ungated bucket, not a real phase.
 */
function lowestUnfinished(tasks: readonly PipelineTask[]): number {
  let open = Infinity;
  for (const t of tasks) {
    const p = phaseOf(t);
    if (p >= 1 && !TERMINAL.has(stateOf(t)) && p < open) open = p;
  }
  return open;
}

/**
 * The phase whose tasks are all finished but whose branches have not landed on
 * the base — and which is therefore still holding the barrier. Null when
 * nothing is held.
 *
 * A phase is not over when its last task is marked done; it is over when its
 * work is *on the base branch*. Between those two moments the branches exist
 * only side by side, never combined, so two of them can each be correct and
 * still not compose. Opening the next phase there hands every agent in it a
 * base that is missing the phase before — and the conflict surfaces later, in
 * someone else's task, as a merge nobody can attribute.
 *
 * Only phases below the next unfinished one are checked: with no later phase
 * waiting there is nothing to lock, and reporting a hold would turn "your plan
 * is finished" into a false alarm.
 */
export function integrationHold(
  tasks: readonly PipelineTask[],
  opts: EligibilityOpts = {},
): number | null {
  const { integrated } = opts;
  if (!integrated) return null;                 // solo default: no barrier to hold
  const next = lowestUnfinished(tasks);
  if (next === Infinity) return null;
  for (let p = 1; p < next; p++) if (phaseComplete(tasks, p) && !integrated(p)) return p;
  return null;
}

/**
 * The highest phase an agent may start work in. Held at an unintegrated phase
 * when one exists, otherwise the lowest phase with work left.
 */
export function openPhase(tasks: readonly PipelineTask[], opts: EligibilityOpts = {}): number {
  return integrationHold(tasks, opts) ?? lowestUnfinished(tasks);
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
  /**
   * Have phase N's branches landed on the base? Injected because answering it
   * means asking git, and this module stays pure. Omit and the barrier behaves
   * as it always has — a phase lifts the moment its last task is marked done.
   */
  integrated?: (phase: number) => boolean;
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
  const open = openPhase(tasks, opts);
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

/**
 * Did this agent write any of it? Both handles count: the current holder, and
 * every closed stretch in the contributor chain. Identity is by agent id, not
 * by session — the same agent in a fresh session is still the author, and
 * "review it yourself tomorrow" is precisely the check being made.
 */
export function isContributor(t: PipelineTask, agent: string): boolean {
  if (t.claimedBy?.agent === agent) return true;
  return (t.contributors ?? []).some((c) => c.agent === agent);
}

/**
 * Work awaiting a verdict that THIS agent is allowed to give.
 *
 * Reviewing is work, and an agent with nothing else to do should be handed it
 * rather than told the pipeline is quiet — a task sitting in `review` holds its
 * phase exactly like an unfinished one, so an idle fleet staring past it is how
 * a plan silently stops advancing.
 */
export function reviewableBy(agent: string, tasks: readonly PipelineTask[]): PipelineTask[] {
  return tasks.filter((t) => stateOf(t) === 'review' && !isContributor(t, agent));
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
  const held = integrationHold(tasks, opts);
  const open = held ?? openPhase(tasks, opts);
  const bySlug = new Map(tasks.map((t) => [t.slug, t]));
  const out: Blocker[] = [];
  for (const t of tasks) {
    const st = stateOf(t);
    if (TERMINAL.has(st)) continue;
    if (st === 'blocked') {
      out.push({ slug: t.slug, reason: t.stoppedReason ? `blocked — ${t.stoppedReason}` : 'blocked, needs a decision' });
      continue;
    }
    // Nobody is working on a task in review, so "review (claude)" would read as
    // work in flight. It is waiting on a person or another agent — say which.
    if (st === 'review') {
      out.push({ slug: t.slug, reason: 'awaiting review — a different agent must judge it' });
      continue;
    }
    if (st !== 'queued') {
      out.push({ slug: t.slug, reason: `${st}${t.claimedBy ? ` (${t.claimedBy.agent})` : ''}` });
      continue;
    }
    if (phaseOf(t) > open) {
      // "locked behind phase 1" reads as "phase 1 is still being worked on",
      // which sends someone looking for an agent who finished hours ago. When
      // the hold is integration, the work is done and the branches are the
      // thing outstanding — say that, and name the command that clears it.
      out.push({
        slug: t.slug,
        reason: held !== null
          ? `phase ${phaseOf(t)} locked — phase ${held} is finished but not integrated (baton integrate)`
          : `phase ${phaseOf(t)} locked behind phase ${open}`,
      });
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
  agents.add('\u0000any'); // a name no agent has — exercises the open-pool path
  return [...agents].every((a) => eligibleFor(a, tasks, opts).length === 0);
}

/** Every task in `phase` is done or cancelled — so the barrier may lift. */
export function phaseComplete(tasks: readonly PipelineTask[], phase: number): boolean {
  const inPhase = tasks.filter((t) => phaseOf(t) === phase);
  return inPhase.length > 0 && inPhase.every((t) => TERMINAL.has(stateOf(t)));
}

/* ------------------------------------------------------------------ */
/* Cancellation (§8)                                                   */
/* ------------------------------------------------------------------ */

/** What to stop. One task, a whole phase, or an entire plan. */
export type CancelScope =
  | { kind: 'task'; slug: string }
  | { kind: 'phase'; phase: number }
  | { kind: 'plan'; planId: string };

export interface BlastRadius {
  /** Tasks that would move to `cancelled`, with who is on each right now. */
  stopping: Array<{ slug: string; state: TaskState; holder: string | null }>;
  /**
   * Matched the scope but is already `done` or `cancelled`. Named rather than
   * silently dropped: "cancel phase 2" on a phase that is mostly finished
   * should say so, not report a number the user cannot reconcile.
   */
  alreadyFinished: string[];
  /**
   * Tasks OUTSIDE the scope that depend on something inside it — and are
   * therefore about to become permanently unstartable.
   *
   * The consequence nobody predicts, and the reason this is computed rather
   * than eyeballed. `depBlocker` refuses a dependency that was cancelled
   * ("depends on 'x', which was cancelled"), and nothing ever clears that: the
   * dependency will never reach `done`. So these tasks are not merely delayed,
   * they are STRANDED, and the only exits are cancelling them too or editing
   * the plan. Cancelling one task can quietly kill a phase downstream of it,
   * which a confirmation prompt has to say out loud.
   */
  stranding: Array<{ slug: string; dependsOn: string[] }>;
}

function inScope(t: PipelineTask, scope: CancelScope): boolean {
  if (scope.kind === 'task') return t.slug === scope.slug;
  if (scope.kind === 'phase') return phaseOf(t) === scope.phase;
  return t.planId === scope.planId;
}

/**
 * Everything a cancellation would touch, before any of it happens.
 *
 * Pure, and separate from the write on purpose: this is the number a human is
 * shown before they confirm ("cancelling phase 2 stops 3 active agents"), and a
 * preview computed by different code from the write is a preview that can lie.
 * `cancelTasks` consumes exactly this.
 */
export function blastRadius(tasks: readonly PipelineTask[], scope: CancelScope): BlastRadius {
  const stopping: BlastRadius['stopping'] = [];
  const alreadyFinished: string[] = [];

  for (const t of tasks) {
    if (!inScope(t, scope)) continue;
    const state = stateOf(t);
    if (TERMINAL.has(state)) { alreadyFinished.push(t.slug); continue; }
    stopping.push({ slug: t.slug, state, holder: t.claimedBy?.agent ?? null });
  }

  /*
   * Stranding is TRANSITIVE, and computing only the direct dependents
   * undercounts it.
   *
   * If A is cancelled, B (which needs A) can never start — and C, which needs
   * B, can never start either, because B will never reach `done`. A one-hop
   * answer reports "2 tasks stranded" for a chain that actually kills 3, and
   * this number sits in a confirmation dialog under the word STRANDED. Of the
   * two directions to be wrong in, understating the damage is the bad one.
   *
   * A fixpoint rather than a recursive walk: a plan's dependency graph is
   * acyclic by validation, but this must terminate even if one ever is not.
   */
  const doomed = new Set(stopping.map((s) => s.slug));
  const alive = tasks.filter((t) => !doomed.has(t.slug) && !TERMINAL.has(stateOf(t)));
  const strandedBy = new Map<string, string[]>();
  for (let changed = true; changed;) {
    changed = false;
    for (const t of alive) {
      if (strandedBy.has(t.slug)) continue;
      // Named by the dependency that actually strands it — the one the reader
      // has to do something about, not the whole `dependsOn` list.
      const cause = (t.dependsOn ?? []).filter((d) => doomed.has(d) || strandedBy.has(d));
      if (cause.length) { strandedBy.set(t.slug, cause); changed = true; }
    }
  }
  // Rebuilt in board order so the dialog lists tasks the way the board does,
  // not in the order a fixpoint happened to settle them.
  const stranding = alive
    .filter((t) => strandedBy.has(t.slug))
    .map((t) => ({ slug: t.slug, dependsOn: strandedBy.get(t.slug)! }));

  return { stopping, alreadyFinished, stranding };
}

/** How many live agents a cancellation would stop — the headline number. */
export function agentsStopped(radius: BlastRadius): number {
  return radius.stopping.filter((s) => s.holder && (s.state === 'active' || s.state === 'claimed')).length;
}
