// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The claim half of `baton take`: win a queued task, then build its worktree.
 *
 * Order matters and is not negotiable. The claim is written FIRST, under the
 * lock, so two agents racing for one task cannot both start — then the worktree
 * is created, which is slow and cannot be done under a lock. If that second step
 * fails the claim is rolled back, because a task stuck `claimed` with no
 * worktree is worse than one that was never claimed: invisible to `next`,
 * useless to its holder, and holding its phase against everyone else.
 */
import { branchExists, createWorktree, currentBranch, headCommit } from '../git.js';
import { installCommitHook } from '../hooks-git.js';
import { resolveGate } from '../gate.js';
import { ArbiterRefused, claimUpstream, isTeamMode, releaseUpstream } from '../pipeline-claims.js';
import { batonDir, isMaterialized, loadTasks, mutateTasks, type Task } from '../store.js';
import { activate, claim, releaseClaim, takeover, type Outcome, type Who } from '../lifecycle.js';
import { livenessProbe } from '../liveness.js';
import { join } from 'node:path';

export interface ClaimResult {
  task: Task;
  /** True when this call created the branch and worktree. */
  materialized: boolean;
  /** Set when we adopted someone else's stalled work. */
  adoptedFrom?: string;
}

function unwrap(o: Outcome): Task {
  if (o.ok) return o.task;
  throw new ClaimRefused(o.refusal.message, o.refusal.code);
}

export class ClaimRefused extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'ClaimRefused';
    this.code = code;
  }
}

/**
 * Write the hub's granted row into this machine's tasks.json.
 *
 * The hub is the writer of the CLAIM; it is not the authority on this disk. Its
 * row carries `worktreePath` and `repoRoot` pointing into the operator's
 * filesystem, and adopting those verbatim would send `git worktree add` at a
 * path that belongs to another machine. So the pipeline fields come from the
 * hub and the materialization fields stay local — including when the local row
 * is already built, which is a task being picked back up rather than started.
 */
async function recordGrant(root: string, granted: Task): Promise<Task> {
  return mutateTasks(root, (tasks) => {
    const local = tasks.find((t) => t.slug === granted.slug);
    const next: Task = {
      ...granted,
      worktreePath: local && isMaterialized(local) ? local.worktreePath : join(batonDir(root), 'wt', granted.slug),
      ...(local && isMaterialized(local)
        ? { branch: local.branch, baseCommit: local.baseCommit, repoRoot: local.repoRoot }
        : { repoRoot: undefined }),
    };
    const tasksNext = local ? tasks.map((t) => (t.slug === granted.slug ? next : t)) : [...tasks, next];
    return { tasks: tasksNext, result: next };
  });
}

/**
 * Claim `slug` for `who`, materializing the worktree if this is its first start.
 *
 * @param resume adopt the task even though someone holds it — allowed only when
 *               the pipeline's own liveness rule says it has stalled.
 */
export async function claimTask(
  root: string,
  slug: string,
  who: Who,
  opts: { resume?: boolean } = {},
): Promise<ClaimResult> {
  const now = new Date().toISOString();
  let adoptedFrom: string | undefined;

  /*
   * Takeover is a judgement this machine cannot make for another one.
   *
   * `--resume` is allowed only when the pipeline's liveness rule says the holder
   * has stalled, and that rule reads the holder's WORKTREE MTIMES (see
   * liveness.ts) — files on their disk, which we do not have. Probing our own
   * root would answer a question about the wrong machine and answer it
   * confidently. Refusing is the honest outcome until the hub can judge
   * staleness from member heartbeats; a stuck task is the operator's to clear.
   */
  if (opts.resume && await isTeamMode(root)) {
    throw new ClaimRefused(
      `'${slug}' cannot be taken over from here.\n`
      + '  Stall detection reads the holder\'s worktree, which is on their machine, not this one.\n'
      + '  Ask the operator to release it on the hub.',
      'resume-needs-hub',
    );
  }

  /*
   * Team mode: the hub decides, and a hub we cannot reach is a refusal.
   *
   * The local lock below is a compare-and-swap over THIS machine's tasks.json,
   * which settles every race between agents here and nothing at all between two
   * laptops — each holds its own lock, reads its own file, and concludes it won.
   * §1.1 names the hub as the arbiter in team mode for exactly that reason, and
   * §7.6 makes this direction fail closed while reads degrade open: an
   * unanswered read costs a cautious agent, an unarbitrated claim costs two
   * agents one worktree.
   */
  const upstream = await claimUpstream(root, slug, who).catch((e: unknown) => {
    if (e instanceof ArbiterRefused) throw new ClaimRefused(e.message, e.code);
    throw e;
  });
  if (upstream.task) {
    // Granted by the hub — recorded here, then materialized below exactly as a
    // solo claim is. `claim()` is deliberately NOT re-run locally: it would find
    // the row already held (by us) and refuse. One writer means one write.
    const task = await recordGrant(root, upstream.task);
    return materialize(root, slug, who, task, adoptedFrom);
  }

  // The gate's git half, resolved before the lock because it talks to git and
  // nothing slow may run inside a mutation. Every path into the pipeline comes
  // through here, so this is where the barrier stops being advice: without it
  // `baton next` refuses a locked task and `baton take <slug>` claims the very
  // same one. The predicates are keyed by phase number and commit sha, not by
  // task identity, so they stay true against the fresh read below.
  const gate = await resolveGate(root, await loadTasks(root));

  // Step 1 — win it. Inside the lock, decided against freshly read state.
  const won = await mutateTasks(root, (tasks) => {
    const existing = tasks.find((t) => t.slug === slug);
    if (opts.resume && existing && existing.state === 'active') {
      adoptedFrom = existing.claimedBy?.agent;
      const probe = livenessProbe(root);
      const out = takeover(tasks, slug, who, now, { now: Date.now(), livenessOf: probe });
      return { tasks: out.ok ? out.tasks : null, result: out };
    }
    const out = claim(tasks, slug, who, now, gate);
    return { tasks: out.ok ? out.tasks : null, result: out };
  });
  const task = unwrap(won);
  return materialize(root, slug, who, task, adoptedFrom);
}

/**
 * Everything after the claim is won: build the worktree, or mark an existing
 * one active again. Shared by both arbiters — the work is identical once the
 * question of who owns the task is settled, and a second copy would be a second
 * rollback path to get wrong.
 */
async function materialize(
  root: string,
  slug: string,
  who: Who,
  task: Task,
  adoptedFrom: string | undefined,
): Promise<ClaimResult> {

  // Already has a worktree — an adopted task, or one that was paused and picked
  // back up. Nothing to build; just mark it active again.
  if (isMaterialized(task)) {
    const active = await mutateTasks(root, (tasks) => {
      const out = activate(tasks, slug, who, {
        branch: task.branch, worktreePath: task.worktreePath,
        baseBranch: task.baseBranch, baseCommit: task.baseCommit, repoRoot: task.repoRoot,
      });
      return { tasks: out.ok ? out.tasks : null, result: out };
    });
    return { task: unwrap(active), materialized: false, adoptedFrom };
  }

  // Step 2 — build it. Slow, and deliberately OUTSIDE the lock.
  const repo = task.repoRoot ?? root;
  try {
    let branch = task.branch;
    // The plan named this branch when the task was queued; the world may have
    // moved since. Never reuse a branch we did not create — it may hold someone
    // else's work.
    if (await branchExists(branch, repo)) {
      let n = 2;
      while (await branchExists(`${branch}-${n}`, repo)) n++;
      branch = `${branch}-${n}`;
    }
    const worktreePath = task.worktreePath || join(batonDir(root), 'wt', slug);
    const baseBranch = task.baseBranch && task.baseBranch !== 'HEAD'
      ? task.baseBranch
      : (await currentBranch(repo)) || 'HEAD';
    await createWorktree(worktreePath, branch, 'HEAD', repo);
    // Lineage in git, so losing .baton/ costs nothing permanent. Best-effort by
    // design: a task that cannot be claimed is a real failure, a commit without
    // a trailer is a smaller one.
    await installCommitHook(repo, process.argv[1] ?? '');
    const baseCommit = await headCommit(worktreePath);

    const active = await mutateTasks(root, (tasks) => {
      const out = activate(tasks, slug, who, { branch, worktreePath, baseBranch, baseCommit, repoRoot: repo });
      return { tasks: out.ok ? out.tasks : null, result: out };
    });
    return { task: unwrap(active), materialized: true, adoptedFrom };
  } catch (e) {
    // Put it back. The agent sees the git error and the task stays startable by
    // anyone, rather than becoming a row nobody can reach.
    await mutateTasks(root, (tasks) => {
      const out = releaseClaim(tasks, slug, who);
      return { tasks: out.ok ? out.tasks : null, result: out };
    }).catch(() => undefined);
    // And upstream, where it matters more: the hub granting a claim this
    // machine could not act on takes the task out of circulation for the whole
    // team, not just for us. No-op when solo.
    await releaseUpstream(root, slug, who);
    throw new ClaimRefused(
      `could not create the worktree for '${slug}': ${e instanceof Error ? e.message : String(e)}\n  The claim was released — the task is queued again.`,
      'materialize-failed',
    );
  }
}
