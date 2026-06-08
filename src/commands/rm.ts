/**
 * `baton rm <slug>` — remove a task's worktree + branch and drop it from the store.
 */
import { gitRoot, removeWorktree, worktreeStatus } from '../git.js';
import { getTask, removeTask } from '../store.js';

export async function rmCmd(slug: string, opts: { force?: boolean } = {}): Promise<void> {
  const root = await gitRoot();
  const task = await getTask(root, slug);
  if (!task) {
    console.error(`No task '${slug}'. See: baton ls`);
    process.exitCode = 1;
    return;
  }

  if (!opts.force) {
    const status = await worktreeStatus(task.worktreePath);
    if (status.state !== 'clean') {
      console.error(
        `✗ ${slug} has uncommitted changes (${status.state}). Commit/merge first, or use --force.`,
      );
      process.exitCode = 1;
      return;
    }
  }

  await removeWorktree(task.worktreePath, task.branch, root);
  await removeTask(root, slug);
  console.log(`✓ removed ${task.branch} and its worktree`);
}
