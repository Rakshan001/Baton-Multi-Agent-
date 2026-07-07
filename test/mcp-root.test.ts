import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// git canonicalizes paths (on macOS /var → /private/var), so compare real paths.
const same = async (a: string, b: string) =>
  expect(await realpath(a)).toBe(await realpath(b));
import { git } from '../src/util/exec.js';
import { createTask } from '../src/commands/new.js';
import { resolveMcpRoot } from '../src/store.js';

async function initRepo(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await git(['init', '-q'], root);
  await git(['config', 'user.email', 'test@baton.dev'], root);
  await git(['config', 'user.name', 'Baton Test'], root);
  await git(['checkout', '-q', '-b', 'main'], root);
  await writeFile(join(root, '.gitignore'), '.baton/\n', 'utf-8');
  await mkdir(join(root, '.baton'), { recursive: true }); // the real hub store
  await git(['add', '.'], root);
  await git(['commit', '-q', '-m', 'initial', '--allow-empty'], root);
  return root;
}

describe('resolveMcpRoot — coordination tools must read the hub store, not a worktree shadow', () => {
  let root: string;
  beforeEach(async () => { root = await initRepo('baton-mcproot-'); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('resolves to the repo root when called from inside a task worktree — even after the worktree was polluted with a shadow .baton', async () => {
    const task = await createTask('Fix the auth middleware', root);
    // Reproduce the bug's damage: the old gitRoot()-based code mkdir'd a
    // per-worktree .baton the first time any coordination tool ran in the worktree.
    await mkdir(join(task.worktreePath, '.baton'), { recursive: true });

    await same(await resolveMcpRoot(task.worktreePath, {}), root);
  });

  it('prefers an explicit BATON_ROOT env (how baton-spawned agents are told their hub root)', async () => {
    const task = await createTask('Add dark mode', root);
    await mkdir(join(task.worktreePath, '.baton'), { recursive: true });

    await same(await resolveMcpRoot(task.worktreePath, { BATON_ROOT: root }), root);
  });

  it('resolves a plain (non-worktree) repo checkout to the repo root', async () => {
    await same(await resolveMcpRoot(root, {}), root);
  });
});
