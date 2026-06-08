/**
 * `baton merge <slug>` — merge a task's branch into the current branch.
 *
 * Default: SQUASH into one clean commit (keeps the agent's WIP commits out of
 * the real history) and ARCHIVE the full branch history to a hidden ref
 * (refs/baton/archive/<slug>) — preserved, never pushed, bisectable. Also
 * records the task's commits/files into the local history index for tracing.
 */
import { archiveBranch, branchCommits, currentBranch, gitRoot, mergeBranch } from '../git.js';
import { detectAgents } from '../agents.js';
import { recordMerge } from '../history.js';
import { getTask } from '../store.js';

export async function mergeCmd(
  slug: string,
  opts: { squash?: boolean; archive?: boolean } = {},
): Promise<void> {
  const root = await gitRoot();
  const task = await getTask(root, slug);
  if (!task) {
    console.error(`No task '${slug}'. See: baton ls`);
    process.exitCode = 1;
    return;
  }

  const squash = opts.squash !== false; // default true
  const archive = opts.archive !== false; // default true
  const into = await currentBranch(root);

  // Capture the branch's commits BEFORE merging (squash would otherwise hide them).
  const commits = await branchCommits(task.branch, task.baseBranch, root);
  const agents = await detectAgents([task.worktreePath]);

  const { success, conflicts } = await mergeBranch(task.branch, task.task, { squash }, root);

  if (!success) {
    console.error(`✗ merge of ${task.branch} → ${into} hit conflicts (merge aborted):`);
    for (const f of conflicts) console.error(`    ${f}`);
    console.error('  Resolve in the worktree, commit, then merge again.');
    process.exitCode = 1;
    return;
  }

  // Preserve full agent history out of the visible log, then index it.
  let archivedRef: string | null = null;
  if (archive) {
    const ok = await archiveBranch(slug, task.branch, root);
    if (ok) archivedRef = `refs/baton/archive/${slug}`;
  }
  recordMerge(root, {
    slug,
    agent: agents.get(task.worktreePath) ?? null,
    mergedAt: new Date().toISOString(),
    archivedRef,
    commits,
  });

  console.log(`✓ merged ${task.branch} → ${into}${squash ? ' (squashed to one commit)' : ''}`);
  if (archivedRef) {
    console.log(`  history preserved at ${archivedRef} (hidden; view: git log ${archivedRef})`);
  }
  console.log(`  remove the worktree with: baton rm ${slug}`);
}
