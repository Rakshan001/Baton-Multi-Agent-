/**
 * `baton new "<task>"` — scaffold a branch + worktree for a task, record it,
 * and print the path to cd into and launch your own agent.
 *
 * Branch/base-commit recording pattern adapted from rover's TaskSetup.initial()
 * (.refs/rover/packages/cli/src/lib/task-setup.ts, Apache-2.0). See NOTICE.
 */
import { join } from 'node:path';
import { createWorktree, currentBranch, gitRoot, headCommit } from '../git.js';
import { recordTask } from '../history.js';
import { addTask, batonDir, loadTasks, slugify, type Task } from '../store.js';

export async function newCmd(taskText: string): Promise<void> {
  const text = taskText?.trim();
  if (!text) {
    console.error('Usage: baton new "<task description>"');
    process.exitCode = 1;
    return;
  }

  const root = await gitRoot();
  const existing = await loadTasks(root);
  const slug = slugify(text, existing.map((t) => t.slug));
  const branch = `baton/${slug}`;
  const worktreePath = join(batonDir(root), 'wt', slug);
  const baseBranch = await currentBranch(root);

  await createWorktree(worktreePath, branch, 'HEAD', root);
  const baseCommit = await headCommit(worktreePath);

  const task: Task = {
    slug,
    task: text,
    branch,
    worktreePath,
    baseBranch,
    baseCommit,
    createdAt: new Date().toISOString(),
  };
  await addTask(root, task);
  recordTask(root, { slug, task: text, branch, baseBranch, createdAt: task.createdAt });

  console.log(`✓ created ${branch}`);
  console.log(`  worktree: ${worktreePath}`);
  console.log('');
  console.log('  Launch your agent there:');
  console.log(`    cd ${worktreePath}`);
}
