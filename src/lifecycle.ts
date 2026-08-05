/**
 * Task lifecycle transitions: claim, take over, pause, block.
 *
 * Every function here is a PURE (tasks, args) → (tasks | refusal). The caller
 * runs them inside `mutateTasks`, which re-reads under the lock — so the check
 * and the write happen against the same list, and two agents claiming one task
 * at the same instant cannot both win. That is the whole compare-and-swap: it
 * lives here as a pure decision precisely so the race is a unit test rather than
 * a thing we hope about.
 *
 * The rule that shapes the rest: an interruption must never be recorded as a
 * completion. A session that hits its limit, loses the network, or is killed
 * leaves the task exactly where it was — owned, with its worktree and its
 * contributor record intact. Only `done` writes done.
 */
import { eligibleFor, isStalled, phaseOf, stateOf, type EligibilityOpts, type PipelineTask, type StallOpts } from './pipeline.js';
import type { Task } from './store.js';

export interface Who {
  agent: string;
  sessionSlug: string;
}

export type Refusal =
  | { code: 'missing'; message: string }
  | { code: 'held'; message: string }
  | { code: 'not-eligible'; message: string }
  | { code: 'not-yours'; message: string }
  | { code: 'not-stalled'; message: string }
  | { code: 'wrong-state'; message: string };

export type Outcome =
  | { ok: true; tasks: Task[]; task: Task }
  | { ok: false; refusal: Refusal };

const fail = (code: Refusal['code'], message: string): Outcome => ({ ok: false, refusal: { code, message } });

function replace(tasks: readonly Task[], next: Task): Task[] {
  return tasks.map((t) => (t.slug === next.slug ? next : t));
}

/** Open the current agent's stretch of work. Closed by whoever displaces them. */
function openStretch(t: Task, who: Who, now: string): Task['contributors'] {
  const prior = (t.contributors ?? []).map((c) => (c.to ? c : { ...c, to: now }));
  return [...prior, { agent: who.agent, from: now }];
}

/**
 * Claim a queued task.
 *
 * Re-checks eligibility rather than trusting what the caller was shown: the
 * board an agent read a second ago may already be stale, and the barrier is only
 * worth anything if it is enforced at the moment of the write.
 */
export function claim(
  tasks: readonly Task[],
  slug: string,
  who: Who,
  now: string,
  opts: EligibilityOpts = {},
): Outcome {
  const t = tasks.find((x) => x.slug === slug);
  if (!t) return fail('missing', `No task '${slug}'.`);

  const state = stateOf(t);
  if (state !== 'queued') {
    const holder = t.claimedBy ? ` (${t.claimedBy.agent})` : '';
    return fail('held', `'${slug}' is ${state}${holder} — nothing to claim.`);
  }
  if (t.assignee != null && t.assignee !== who.agent) {
    return fail('not-yours', `'${slug}' is assigned to ${t.assignee}.`);
  }
  // The barrier and the dependency rule, re-derived here rather than read from
  // a flag: `eligibleFor` is the one definition, and a second copy would drift.
  if (!eligibleFor(who.agent, tasks as readonly PipelineTask[], opts).some((e) => e.slug === slug)) {
    return fail('not-eligible', `'${slug}' is not startable yet — see: baton next`);
  }

  const next: Task = {
    ...t,
    state: 'claimed',
    claimedBy: { agent: who.agent, sessionSlug: who.sessionSlug, at: now },
    contributors: openStretch(t, who, now),
  };
  return { ok: true, tasks: replace(tasks, next), task: next };
}

/**
 * Claim succeeded but the worktree could not be created — put the task back.
 *
 * Without this a failed materialization leaves a task `claimed` forever with no
 * worktree behind it: invisible to `next` (not queued), useless to its holder
 * (nothing to work in), and holding its phase against everyone else.
 */
export function releaseClaim(tasks: readonly Task[], slug: string, who: Who): Outcome {
  const t = tasks.find((x) => x.slug === slug);
  if (!t) return fail('missing', `No task '${slug}'.`);
  if (t.claimedBy?.sessionSlug !== who.sessionSlug) {
    return fail('not-yours', `'${slug}' is no longer held by this session.`);
  }
  const contributors = (t.contributors ?? []).slice(0, -1);
  const next: Task = {
    ...t,
    state: 'queued',
    claimedBy: undefined,
    ...(contributors.length ? { contributors } : { contributors: undefined }),
  };
  return { ok: true, tasks: replace(tasks, next), task: next };
}

/** The worktree exists and the agent is in it. */
export function activate(tasks: readonly Task[], slug: string, who: Who, materialized: Pick<Task, 'branch' | 'worktreePath' | 'baseBranch' | 'baseCommit' | 'repoRoot'>): Outcome {
  const t = tasks.find((x) => x.slug === slug);
  if (!t) return fail('missing', `No task '${slug}'.`);
  if (t.claimedBy?.sessionSlug !== who.sessionSlug) {
    return fail('not-yours', `'${slug}' was claimed by another session while the worktree was being created.`);
  }
  const next: Task = { ...t, ...materialized, state: 'active' };
  return { ok: true, tasks: replace(tasks, next), task: next };
}

/**
 * Adopt a stalled task.
 *
 * Not filtered by assignee: the point of takeover is that whoever is free
 * finishes the work. The displaced agent's stretch is closed rather than
 * overwritten, so "who wrote this" stays answerable afterwards — and so a
 * returning agent can see it was displaced instead of silently double-writing.
 */
export function takeover(
  tasks: readonly Task[],
  slug: string,
  who: Who,
  now: string,
  stall: StallOpts,
): Outcome {
  const t = tasks.find((x) => x.slug === slug);
  if (!t) return fail('missing', `No task '${slug}'.`);
  const state = stateOf(t);
  if (state !== 'active') {
    return fail('wrong-state', `'${slug}' is ${state} — takeover applies to active work that went quiet.`);
  }
  if (t.claimedBy?.sessionSlug === who.sessionSlug) {
    return fail('wrong-state', `'${slug}' is already yours.`);
  }
  if (!isStalled(t as PipelineTask, stall)) {
    const mins = Math.round((stall.now - stall.livenessOf(t as PipelineTask)) / 60_000);
    return fail('not-stalled', `'${slug}' showed activity ${mins}m ago — not stalled. Two agents in one worktree is the failure this prevents.`);
  }

  const next: Task = {
    ...t,
    claimedBy: { agent: who.agent, sessionSlug: who.sessionSlug, at: now },
    contributors: openStretch(t, who, now),
  };
  return { ok: true, tasks: replace(tasks, next), task: next };
}

/**
 * Hand the task back deliberately — out of context, out of time, switching off.
 *
 * The worktree, the branch and the contributor history all survive; only
 * ownership is dropped. This is the honest counterpart to `done`, and having it
 * is what lets a stop be a stop instead of a lie in either direction.
 */
export function pause(tasks: readonly Task[], slug: string, who: Who, now: string, reason?: string): Outcome {
  const t = tasks.find((x) => x.slug === slug);
  if (!t) return fail('missing', `No task '${slug}'.`);
  const state = stateOf(t);
  if (state !== 'active' && state !== 'claimed' && state !== 'blocked') {
    return fail('wrong-state', `'${slug}' is ${state} — nothing to hand back.`);
  }
  if (t.claimedBy && t.claimedBy.agent !== who.agent) {
    return fail('not-yours', `'${slug}' is held by ${t.claimedBy.agent}.`);
  }
  const next: Task = {
    ...t,
    state: 'queued',
    claimedBy: undefined,
    ...(reason ? { stoppedReason: reason } : {}),
    contributors: (t.contributors ?? []).map((c) => (c.to ? c : { ...c, to: now })),
  };
  return { ok: true, tasks: replace(tasks, next), task: next };
}

/**
 * Report that the work cannot proceed.
 *
 * Stays OWNED, unlike `pause`: a blocked task is not free for another agent to
 * pick up and hit the same wall. It surfaces as a named blocker and waits for a
 * human, which is the only thing that can actually resolve it.
 */
export function block(tasks: readonly Task[], slug: string, who: Who, reason: string, now: string): Outcome {
  const t = tasks.find((x) => x.slug === slug);
  if (!t) return fail('missing', `No task '${slug}'.`);
  const state = stateOf(t);
  if (state !== 'active' && state !== 'claimed') {
    return fail('wrong-state', `'${slug}' is ${state} — only work in progress can be blocked.`);
  }
  if (t.claimedBy && t.claimedBy.agent !== who.agent) {
    return fail('not-yours', `'${slug}' is held by ${t.claimedBy.agent}.`);
  }
  if (!reason.trim()) {
    return fail('wrong-state', 'A blocker needs a reason — "blocked" with no cause is indistinguishable from silence.');
  }
  const next: Task = { ...t, state: 'blocked', stoppedReason: reason.trim(), contributors: t.contributors, claimedBy: t.claimedBy };
  return { ok: true, tasks: replace(tasks, next), task: next };
}

/** Pick the task an idle agent should start: lowest phase first, then declared
 *  assignment over the open pool, so an agent takes its own work before helping. */
export function nextFor(agent: string, tasks: readonly Task[], opts: EligibilityOpts = {}): Task | null {
  const eligible = eligibleFor(agent, tasks as readonly PipelineTask[], opts) as Task[];
  if (!eligible.length) return null;
  return [...eligible].sort((a, b) =>
    phaseOf(a) - phaseOf(b)
    || Number(a.assignee == null) - Number(b.assignee == null)
    || a.createdAt.localeCompare(b.createdAt),
  )[0];
}
