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
import { blockers, eligibleFor, isContributor, isStalled, isTerminal, phaseOf, stateOf, type EligibilityOpts, type PipelineTask, type StallOpts } from './pipeline.js';
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
  | { code: 'self-review'; message: string }
  | { code: 'open-findings'; message: string }
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
    // The cause, not just the verdict. "Not startable yet" sends someone to
    // `baton next` to be told the phase has not landed or a dependency has not
    // been pushed — both of which name a command, and neither of which anyone
    // guesses. The same reason string the board and `next` already print.
    const why = blockers(tasks as readonly PipelineTask[], opts).find((b) => b.slug === slug)?.reason;
    return fail('not-eligible', `'${slug}' is not startable yet${why ? ` — ${why}` : ' — see: baton next'}`);
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
 * Stop work (§8). Cooperative, and destructive of nothing.
 *
 * Baton cannot halt an agent mid-thought. Cancellation writes state the agent
 * observes on its very next tool call (`groundMovedNotice` in mcp-pipeline.ts
 * already reads it); between the click and that call it keeps writing, and that
 * window is real and cannot be engineered away.
 *
 * What it must NOT do is delete anything. The branch, the worktree and every
 * checkpoint stay exactly where they are: cancelling is the reversal of a
 * decision, not a wastebasket, and the commits are frequently the most valuable
 * output of an approach that turned out to be wrong. Contributor stretches are
 * closed, because that work genuinely ended.
 *
 * Takes the slugs `blastRadius` resolved rather than a scope of its own — one
 * definition of "what this touches", so the preview a human confirmed and the
 * write that follows cannot disagree.
 */
export function cancelTasks(
  tasks: readonly Task[],
  slugs: readonly string[],
  actor: string,
  now: string,
  reason?: string,
): { tasks: Task[]; cancelled: string[] } {
  const target = new Set(slugs);
  const cancelled: string[] = [];
  const next = tasks.map((t) => {
    if (!target.has(t.slug) || isTerminal(stateOf(t as PipelineTask))) return t;
    cancelled.push(t.slug);
    return {
      ...t,
      state: 'cancelled' as const,
      // Dropped, so the board stops showing a live holder for work that
      // stopped. The contributor record below is what preserves who did it.
      claimedBy: undefined,
      cancelledBy: { actor, at: now, ...(reason ? { reason } : {}) },
      contributors: (t.contributors ?? []).map((c) => (c.to ? c : { ...c, to: now })),
    };
  });
  return { tasks: next, cancelled };
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

/** Shared by both verdicts: the task must be awaiting one, and the agent giving
 *  it must not be the agent who wrote the code. */
function gateReview(tasks: readonly Task[], slug: string, who: Who): Task | Outcome {
  const t = tasks.find((x) => x.slug === slug);
  if (!t) return fail('missing', `No task '${slug}'.`);
  const state = stateOf(t);
  if (state !== 'review') {
    return fail('wrong-state', `'${slug}' is ${state} — only work awaiting a verdict can be reviewed.`);
  }
  if (isContributor(t as PipelineTask, who.agent)) {
    // The one rule that makes the gate worth having. An author reviewing their
    // own work re-runs the same judgement that produced it, with the same blind
    // spots — the second opinion has to come from a second party or it is not
    // one. Identity is by agent id, so a fresh session does not launder it.
    return fail('self-review', `'${slug}' was written by ${who.agent} — a reviewer must not be a contributor.`);
  }
  return t;
}

const isOutcome = (x: Task | Outcome): x is Outcome => 'ok' in x;

export interface VerdictOpts {
  /** Open findings on the recorded review, injected — lifecycle stays pure. */
  openFindings?: number;
  /** Approve past open findings anyway. Applies ONLY to findings: no flag gets
   *  past the contributor rule, because that one is about who you are. */
  force?: boolean;
  notes?: string;
}

/**
 * Approve: the work is right, as far as a second agent can tell.
 *
 * Stated plainly, because the design does: a reviewing agent can hallucinate
 * too. This reduces the chance of wrong code landing; it does not eliminate it.
 */
export function approve(tasks: readonly Task[], slug: string, who: Who, now: string, opts: VerdictOpts = {}): Outcome {
  const gated = gateReview(tasks, slug, who);
  if (isOutcome(gated)) return gated;

  const open = opts.openFindings ?? 0;
  if (open > 0 && !opts.force) {
    // Approving over a recorded review's own open findings leaves two pieces of
    // shared state contradicting each other, and the next agent believes
    // whichever it happens to read.
    return fail('open-findings', `'${slug}' has ${open} open finding${open === 1 ? '' : 's'} — resolve them (baton review resolve ${slug} <n>), or approve anyway with --force.`);
  }

  const next: Task = {
    ...gated,
    state: 'done',
    reviewedBy: { actor: who.agent, at: now, verdict: 'approve', ...(opts.notes ? { notes: opts.notes } : {}) },
  };
  return { ok: true, tasks: replace(tasks, next), task: next };
}

/**
 * Reject: back to `active`, with the reason attached.
 *
 * Not back to `queued`, and never a cancellation — the branch, the worktree and
 * the contributor chain all survive, because the work exists and needs another
 * pass rather than a fresh start. `finishedSha` is dropped: it recorded the head
 * the gate accepted, and nothing is accepted now.
 */
export function reject(tasks: readonly Task[], slug: string, who: Who, notes: string, now: string): Outcome {
  const gated = gateReview(tasks, slug, who);
  if (isOutcome(gated)) return gated;
  if (!notes.trim()) {
    // Same rule as `block`: a verdict with no reason sends the agent back to
    // work with nothing to change, which is how a rejection loop starts.
    return fail('wrong-state', 'A rejection needs a reason — the agent has to know what to fix.');
  }

  const next: Task = {
    ...gated,
    state: 'active',
    finishedSha: undefined,
    reviewedBy: { actor: who.agent, at: now, verdict: 'reject', notes: notes.trim() },
  };
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
