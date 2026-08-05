/**
 * `baton done <slug>` for a pipeline task: gather the evidence, judge it, and
 * move the task to `review` (or `done` when the plan opted out of review).
 *
 * The gathering is here; the judging is in src/evidence.ts, which is pure. That
 * split is the point — what counts as "finished" is a rule set anyone can read
 * and every one of them is a unit test, rather than a condition buried in a
 * command that only fires against a real repo.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { branchCommits, headCommit, worktreeStatus } from '../git.js';
import { mutateTasks, type Task } from '../store.js';
import { isTerminal, stateOf } from '../pipeline.js';
import { verdictFor, renderChecks, type Evidence, type Verdict } from '../evidence.js';
import type { Who } from '../lifecycle.js';

const CONFLICT_MARKER = /^(<{7}|={7}|>{7})(\s|$)/m;

/** Files in the diff that still carry merge conflict markers. */
async function conflictMarkers(worktreePath: string, files: readonly string[]): Promise<string[]> {
  const hits: string[] = [];
  // Bounded: this reads files, and a huge branch should not turn `done` into a
  // full-tree scan. Beyond the cap the working-tree conflict state still applies.
  for (const f of files.slice(0, 200)) {
    try {
      if (CONFLICT_MARKER.test(await readFile(join(worktreePath, f), 'utf-8'))) hits.push(f);
    } catch { /* deleted in the branch, or binary — no marker to find */ }
  }
  return hits;
}

export async function collectEvidence(task: Task, attested: boolean): Promise<Evidence> {
  const repo = task.repoRoot ?? task.worktreePath;
  const commits = await branchCommits(task.branch, task.baseCommit ?? task.baseBranch, repo);
  const files = [...new Set(commits.flatMap((c) => c.files))];
  const status = await worktreeStatus(task.worktreePath);
  return {
    commits: commits.length,
    // The worktree can be gone while the branch is intact — `branchCommits` is
    // newest-first and answers from the repo, so it still knows the head.
    headSha: (await headCommit(task.worktreePath)) ?? commits[0]?.sha.slice(0, 7) ?? null,
    files,
    scope: task.scope ?? [],
    worktreeMissing: status.state === 'missing',
    dirtyFiles: status.changedFiles,
    conflictFiles: [...new Set([...status.conflictFiles, ...(await conflictMarkers(task.worktreePath, files))])],
    expects: task.expects ?? [],
    attested,
  };
}

export interface FinishResult {
  verdict: Verdict;
  task: Task;
  landedIn: 'review' | 'done' | null;
}

/**
 * Judge and record. Returns without writing when the gate refuses — the task
 * stays exactly where it was, which is the whole point: a failed `done` must
 * leave the agent still holding the work, not in some half-finished state.
 */
export async function finishTask(
  root: string,
  task: Task,
  who: Who,
  opts: { attest?: boolean; force?: boolean } = {},
): Promise<FinishResult> {
  const evidence = await collectEvidence(task, Boolean(opts.attest));
  const verdict = verdictFor(evidence);

  // --force can buy past an unmet attestation, never past a refusal: those are
  // facts about the repository, not judgements about the work.
  const blocked = verdict.refusals.length > 0 || (!verdict.pass && !opts.force);
  if (blocked) return { verdict, task, landedIn: null };

  const now = new Date().toISOString();
  // Review is on unless the plan wrote down that it is off. The gate above
  // proves work happened; only review targets whether it is right.
  const next = task.requireReview === false ? 'done' : 'review';

  const updated = await mutateTasks(root, (tasks) => {
    const cur = tasks.find((t) => t.slug === task.slug);
    if (!cur || isTerminal(stateOf(cur))) return { tasks: null, result: cur ?? task };
    const merged: Task = {
      ...cur,
      state: next,
      contributors: (cur.contributors ?? []).map((c) => (c.to ? c : { ...c, to: now })),
      ...(verdict.outOfScope.length ? { outOfScope: verdict.outOfScope } : {}),
      ...(evidence.headSha ? { finishedSha: evidence.headSha } : {}),
    };
    return { tasks: tasks.map((t) => (t.slug === task.slug ? merged : t)), result: merged };
  });

  return { verdict, task: updated, landedIn: next };
}

/** Print a gate result the way a person reads it: checks, then the consequence. */
export function reportFinish(slug: string, r: FinishResult): void {
  for (const line of renderChecks(r.verdict.checks)) console.log(line);
  if (r.landedIn === null) {
    console.error(
      r.verdict.refusals.length
        ? `\n✗ ${slug} is not done. The task is untouched — it is still yours.`
        : `\n✗ ${slug} needs an attestation for what the plan expects. Run it, then: baton done ${slug} --attest`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(r.landedIn === 'review'
    ? `\n→ ${slug} is in review. A different agent decides it: baton review approve ${slug}`
    : `\n✓ ${slug} done.`);
  if (r.verdict.outOfScope.length) {
    console.log(`  ${r.verdict.outOfScope.length} out-of-scope file(s) recorded on the task.`);
  }
}
