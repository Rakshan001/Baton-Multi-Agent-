import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { branchExists } from '../src/git.js';
import { loadTasks } from '../src/store.js';
import { createTask, EmptyTaskError } from '../src/commands/new.js';

async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'baton-create-'));
  await git(['init', '-q'], root);
  await git(['config', 'user.email', 'test@baton.dev'], root);
  await git(['config', 'user.name', 'Baton Test'], root);
  await git(['checkout', '-q', '-b', 'main'], root);
  await writeFile(join(root, '.gitignore'), '.baton/\n', 'utf-8');
  await git(['add', '.'], root);
  await git(['commit', '-q', '-m', 'initial', '--allow-empty'], root);
  return root;
}

describe('createTask (POST /api/tasks core)', () => {
  let root: string;
  beforeEach(async () => { root = await initRepo(); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('creates a branch + worktree and records the task', async () => {
    const task = await createTask('Refactor auth middleware to support API keys', root);
    expect(task.slug).toBe('refactor-auth-middleware-to-support-api');
    expect(task.branch).toBe('baton/refactor-auth-middleware-to-support-api');
    expect(task.baseBranch).toBe('main');
    expect(task.baseCommit).toBeTruthy();
    expect(existsSync(task.worktreePath)).toBe(true);
    expect(await branchExists(task.branch, root)).toBe(true);
    const tasks = await loadTasks(root);
    expect(tasks.map((t) => t.slug)).toContain(task.slug);
  });

  it('dedupes slugs across repeated task names', async () => {
    const a = await createTask('Add dark mode', root);
    const b = await createTask('Add dark mode', root);
    expect(a.slug).toBe('add-dark-mode');
    expect(b.slug).toBe('add-dark-mode-2');
    expect(await branchExists(b.branch, root)).toBe(true);
  });

  it('rejects an empty task description', async () => {
    await expect(createTask('   ', root)).rejects.toBeInstanceOf(EmptyTaskError);
  });
});
