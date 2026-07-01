/**
 * `baton rm <slug>` — remove a task's worktree + branch and drop it from the store.
 */
import { resolve } from 'node:path';
import { removeWorktree, worktreeStatus } from '../git.js';
import { getTask, removeTask, resolveBatonRoot, TaskNotFoundError } from '../store.js';
import { killSessionFor } from '../util/tmux.js';
import { bus } from '../events.js';

/** Thrown when removing the repo's own main worktree is attempted. */
export class MainWorktreeError extends Error {
  constructor(root: string) {
    super(`refusing to remove the main worktree (${root})`);
    this.name = 'MainWorktreeError';
  }
}
/** Thrown when a worktree has uncommitted changes and `force` wasn't set. */
export class DirtyWorktreeError extends Error {
  state: string;
  constructor(slug: string, state: string) {
    super(`${slug} has uncommitted changes (${state})`);
    this.name = 'DirtyWorktreeError';
    this.state = state;
  }
}

/**
 * Core remove logic, shared by the CLI (`baton rm`) and the HTTP API
 * (`DELETE /api/tasks/:slug`). Throws TaskNotFoundError / MainWorktreeError /
 * DirtyWorktreeError.
 */
export async function removeTaskWorktree(
  slug: string,
  opts: { force?: boolean } = {},
  root?: string,
): Promise<{ removed: string; branch: string }> {
  const repoRoot = root ?? (await resolveBatonRoot());
  const task = await getTask(repoRoot, slug);
  if (!task) throw new TaskNotFoundError(slug);
  // In a hub the worktree/branch belong to the sub-project's repo, not the hub root.
  const gitRepo = task.repoRoot ?? repoRoot;

  // Defense-in-depth: never remove the main worktree (the repo root itself).
  if (resolve(task.worktreePath) === resolve(repoRoot)) throw new MainWorktreeError(repoRoot);

  if (!opts.force) {
    const status = await worktreeStatus(task.worktreePath);
    if (status.state !== 'clean') throw new DirtyWorktreeError(slug, status.state);
  }

  // Kill any interactive agent session BEFORE deleting its working directory —
  // via tmux directly (deterministic session name), so this works no matter
  // which process owns the terminal (CLI rm vs daemon-owned session). The
  // owning daemon's control client sees the session die and cleans itself up.
  await killSessionFor(repoRoot, slug);

  await removeWorktree(task.worktreePath, task.branch, gitRepo);
  await removeTask(repoRoot, slug);
  bus.publish({ type: 'task.removed', slug });
  return { removed: slug, branch: task.branch };
}

export async function rmCmd(slug: string, opts: { force?: boolean } = {}): Promise<void> {
  try {
    const r = await removeTaskWorktree(slug, opts);
    console.log(`✓ removed ${r.branch} and its worktree`);
  } catch (e) {
    if (e instanceof TaskNotFoundError) console.error(`No task '${slug}'. See: baton ls`);
    else if (e instanceof MainWorktreeError) console.error(`✗ ${e.message}.`);
    else if (e instanceof DirtyWorktreeError) console.error(`✗ ${e.message}. Commit/merge first, or use --force.`);
    else console.error((e as Error).message);
    process.exitCode = 1;
  }
}
