/**
 * `baton new "<task>"` — scaffold a branch + worktree for a task, record it,
 * and print the path to cd into and launch your own agent.
 *
 * Branch/base-commit recording pattern adapted from rover's TaskSetup.initial()
 * (.refs/rover/packages/cli/src/lib/task-setup.ts, Apache-2.0). See NOTICE.
 */
import { join } from 'node:path';
import { branchExists, createWorktree, currentBranch, gitRoot, headCommit } from '../git.js';
import { recordTask } from '../history.js';
import { addTask, batonDir, loadTasks, slugify, type Task } from '../store.js';
import { bus } from '../events.js';

/**
 * Core create logic, shared by the CLI (`baton new`) and the HTTP API
 * (`POST /api/tasks`). Scaffolds a branch + worktree, records the task, and
 * returns it. Throws `EmptyTaskError` when the description is blank.
 */
export class EmptyTaskError extends Error {
  constructor() {
    super('Task description is required');
    this.name = 'EmptyTaskError';
  }
}

export async function createTask(taskText: string, root?: string): Promise<Task> {
  const text = taskText?.trim();
  if (!text) throw new EmptyTaskError();

  const repoRoot = root ?? (await gitRoot());
  const existing = await loadTasks(repoRoot);
  // Dedupe against recorded tasks first, then against actual git branches so we
  // never collide with a `baton/<slug>` branch baton didn't record.
  const taken = existing.map((t) => t.slug);
  let slug = slugify(text, taken);
  while (await branchExists(`baton/${slug}`, repoRoot)) {
    taken.push(slug);
    slug = slugify(text, taken);
  }
  const branch = `baton/${slug}`;
  const worktreePath = join(batonDir(repoRoot), 'wt', slug);
  const baseBranch = await currentBranch(repoRoot);

  await createWorktree(worktreePath, branch, 'HEAD', repoRoot);
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
  await addTask(repoRoot, task);
  recordTask(repoRoot, { slug, task: text, branch, baseBranch, createdAt: task.createdAt });
  bus.publish({ type: 'task.created', slug, task: text });
  return task;
}

export async function newCmd(taskText: string): Promise<void> {
  if (!taskText?.trim()) {
    console.error('Usage: baton new "<task description>"');
    process.exitCode = 1;
    return;
  }

  const task = await createTask(taskText);

  console.log(`✓ created ${task.branch}`);
  console.log(`  worktree: ${task.worktreePath}`);
  console.log('');
  console.log('  Launch your agent there:');
  console.log(`    cd ${task.worktreePath}`);
}
