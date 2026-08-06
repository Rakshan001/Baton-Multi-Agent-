/**
 * `baton push [slug]` — publish a task's branch and record that it is reachable.
 *
 * This is the producer for `pushedSha`, the field team mode's dependency gate
 * reads. Without it `isFetchable` would answer "no" for everything, because
 * nothing ever recorded a yes.
 *
 * Push is an explicit act, never a side effect of finishing. Two reasons: a
 * write during a read path is not something this codebase does, and publishing
 * to a shared remote is the kind of thing a person expects to have asked for.
 */
import { loadTasks, mutateTasks, resolveBatonRoot, type Task } from '../store.js';
import { resolveTask } from './pass.js';
import { changedFiles } from '../conflicts.js';
import { clearFetchableCache } from '../fetchable.js';
import { defaultRemote, pushBranch, refSha } from '../git.js';
import { isTerminal, stateOf } from '../pipeline.js';

/**
 * CI configuration a push would hand to a runner.
 *
 * §7.4: a task scoped to CI config, an agent that edits it, and a push together
 * are remote code execution on the runner — the agent writes the workflow, the
 * push runs it, with whatever secrets the runner holds. The guard is on by
 * default and applies to every caller, because `baton push` is a CLI command
 * and agents run CLI commands; a check that only covered some future "auto"
 * mode would miss the way this actually gets invoked.
 */
const CI_PATTERNS: RegExp[] = [
  /^\.github\/workflows\//,
  /^\.github\/actions\//,
  /^\.gitlab-ci\.yml$/,
  /^\.circleci\//,
  /^Jenkinsfile$/,
  /^azure-pipelines\.ya?ml$/,
  /^bitbucket-pipelines\.ya?ml$/,
  /^\.drone\.ya?ml$/,
  /^\.travis\.ya?ml$/,
  /^\.buildkite\//,
];

/** Which of these paths are CI configuration. Pure — the whole guard is a unit test. */
export function ciPaths(files: Iterable<string>): string[] {
  const hits: string[] = [];
  for (const f of files) if (CI_PATTERNS.some((re) => re.test(f))) hits.push(f);
  return hits.sort();
}

export async function pushCmd(
  slug: string | undefined,
  opts: { allowCi?: boolean } = {},
): Promise<void> {
  const root = await resolveBatonRoot();
  const task = await resolveTask(root, slug);
  if (!task) {
    console.error(slug ? `No task '${slug}'. See: baton ls` : 'Not inside a baton worktree — pass a slug: baton push <slug>');
    process.exitCode = 1;
    return;
  }

  // §7.4: re-check state AT PUSH TIME. A task cancelled while the agent was
  // working must not be able to publish — the decision to stop it is only real
  // if it also stops the work leaving this machine.
  if (stateOf(task) === 'cancelled') {
    const by = task.cancelledBy ? ` by ${task.cancelledBy.actor}` : '';
    console.error(`✗ '${task.slug}' was cancelled${by} — refusing to push.`);
    process.exitCode = 1;
    return;
  }

  const repo = task.repoRoot ?? root;
  const remote = await defaultRemote(repo);
  if (!remote) {
    console.log(`No remote on ${repo} — nothing to push to. Dependencies are local, so nothing is gated.`);
    return;
  }

  const ci = ciPaths(await changedFiles(task, root));
  if (ci.length && !opts.allowCi) {
    console.error(`✗ '${task.slug}' changes CI configuration:`);
    for (const f of ci) console.error(`    ${f}`);
    console.error(
      '\nPushing this hands new code to your CI runner, with whatever secrets it holds.'
      + '\nIf you wrote these changes and meant them, re-run with --allow-ci.',
    );
    process.exitCode = 1;
    return;
  }

  const { ok, error } = await pushBranch(remote, task.branch, repo);
  if (!ok) {
    console.error(`✗ push failed: ${error}`);
    process.exitCode = 1;
    return;
  }

  // Read the tip from the REPO, not the worktree: the branch is what was
  // pushed, and a task whose worktree was already cleaned up still has one.
  const sha = await refSha(task.branch, repo);
  await mutateTasks(root, (tasks) => {
    const cur = tasks.find((t) => t.slug === task.slug);
    if (!cur) return { tasks: null, result: null };
    const merged: Task = { ...cur, ...(sha ? { pushedSha: sha } : {}) };
    return { tasks: tasks.map((t) => (t.slug === task.slug ? merged : t)), result: merged };
  });

  // The probe caches per repo; a push we just made must be visible to the very
  // next `baton next` rather than up to a TTL later.
  clearFetchableCache(repo);

  console.log(`✓ pushed ${task.branch} → ${remote}`);
  if (sha) console.log(`  recorded as reachable at ${sha.slice(0, 7)} — dependents may now start`);
  if (ci.length) console.log(`  ⚠ included ${ci.length} CI config file(s) (--allow-ci)`);

  const waiting = (await loadTasks(root)).filter((t) => (t.dependsOn ?? []).includes(task.slug) && !isTerminal(stateOf(t)));
  if (waiting.length) console.log(`  ${waiting.length} task(s) depend on this: ${waiting.map((t) => t.slug).join(', ')}`);
}
