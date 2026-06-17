import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import {
  aheadBehind,
  archiveBranch,
  branchExists,
  createWorktree,
  currentBranch,
  headCommit,
  listWorktrees,
  mergeBranch,
  removeWorktree,
  worktreeStatus,
} from '../src/git.js';

async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'baton-git-'));
  await git(['init', '-q'], root);
  await git(['config', 'user.email', 'test@baton.dev'], root);
  await git(['config', 'user.name', 'Baton Test'], root);
  await git(['checkout', '-q', '-b', 'main'], root);
  await writeFile(join(root, 'README.md'), '# test\n', 'utf-8');
  // Baton's worktrees live under .baton/ which is gitignored in real repos;
  // mirror that here so the parent worktree's status isn't polluted by them.
  await writeFile(join(root, '.gitignore'), '.baton/\n', 'utf-8');
  await git(['add', '.'], root);
  await git(['commit', '-q', '-m', 'initial'], root);
  return root;
}

describe('git worktree lifecycle', () => {
  let root: string;
  beforeEach(async () => {
    root = await initRepo();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reports the base branch and a head commit', async () => {
    expect(await currentBranch(root)).toBe('main');
    expect(await headCommit(root)).not.toBeNull();
  });

  it('currentBranch tolerates an unborn HEAD (fresh git init, no commits)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'baton-unborn-'));
    try {
      await git(['init', '-q'], dir);
      await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir);
      expect(await currentBranch(dir)).toBe('main'); // does not throw
      expect(await headCommit(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('creates a worktree, tracks status, merges, and removes', async () => {
    const wt = join(root, '.baton', 'wt', 'feat');
    await createWorktree(wt, 'baton/feat', 'HEAD', root);

    // fresh worktree is clean
    expect((await worktreeStatus(wt)).state).toBe('clean');

    // make + commit a change in the worktree (unique WIP message we can assert on)
    await writeFile(join(wt, 'feature.txt'), 'hello\n', 'utf-8');
    expect((await worktreeStatus(wt)).state).toBe('dirty');
    await git(['add', '.'], wt);
    await git(['commit', '-q', '-m', 'WIPMARKER nav change'], wt);
    expect((await worktreeStatus(wt)).state).toBe('clean');

    // branch is now ahead of main by 1
    expect(await aheadBehind('baton/feat', 'main', root)).toEqual({ ahead: 1, behind: 0 });

    // SQUASH-merge into main: the file lands, ONE clean commit is made, and the
    // branch's WIP commit does NOT appear in main's history.
    const res = await mergeBranch('baton/feat', 'SQUASHMSG done', {}, root);
    expect(res.success).toBe(true);
    expect(existsSync(join(root, 'feature.txt'))).toBe(true);
    const log = await git(['log', '--oneline'], root);
    expect(log).toContain('SQUASHMSG');
    expect(log).not.toContain('WIPMARKER');

    // archive preserves the full branch history under a hidden ref
    await archiveBranch('feat', 'baton/feat', root);
    const archived = await git(['log', '--oneline', 'refs/baton/archive/feat'], root);
    expect(archived).toContain('WIPMARKER');

    // remove worktree + branch (commits still reachable via the archive ref)
    await removeWorktree(wt, 'baton/feat', root);
    const worktrees = await git(['worktree', 'list', '--porcelain'], root);
    expect(worktrees).not.toContain('feat');
    const branches = await git(['branch'], root);
    expect(branches).not.toContain('baton/feat');
  });

  it('detects merge conflicts and aborts', async () => {
    const wt = join(root, '.baton', 'wt', 'conflict');
    await createWorktree(wt, 'baton/conflict', 'HEAD', root);

    // diverge: same file edited differently on both branches
    await writeFile(join(wt, 'README.md'), '# from-branch\n', 'utf-8');
    await git(['commit', '-q', '-am', 'branch edit'], wt);
    await writeFile(join(root, 'README.md'), '# from-main\n', 'utf-8');
    await git(['commit', '-q', '-am', 'main edit'], root);

    const res = await mergeBranch('baton/conflict', 'merge attempt', {}, root);
    expect(res.success).toBe(false);
    expect(res.conflicts.map((c) => c.path)).toContain('README.md');
    // conflicts carry a human label, not just a path
    expect(res.conflicts.find((c) => c.path === 'README.md')?.label).toBe('both modified');

    // merge was aborted → main is clean and unchanged
    expect((await worktreeStatus(root)).state).toBe('clean');
  });

  it('branchExists and listWorktrees reflect created worktrees', async () => {
    const wt = join(root, '.baton', 'wt', 'wtest');
    expect(await branchExists('baton/wtest', root)).toBe(false);
    await createWorktree(wt, 'baton/wtest', 'HEAD', root);
    expect(await branchExists('baton/wtest', root)).toBe(true);
    const list = await listWorktrees(root);
    expect(list.some((w) => w.branch === 'baton/wtest')).toBe(true);
  });

  it('removeWorktree prunes cleanly when the worktree dir is gone', async () => {
    const wt = join(root, '.baton', 'wt', 'orphan');
    await createWorktree(wt, 'baton/orphan', 'HEAD', root);

    // simulate the worktree being deleted out from under baton
    await rm(wt, { recursive: true, force: true });

    // should not throw, should prune stale metadata and delete the branch
    await removeWorktree(wt, 'baton/orphan', root);
    const worktrees = await git(['worktree', 'list', '--porcelain'], root);
    expect(worktrees).not.toContain('orphan');
    const branches = await git(['branch'], root);
    expect(branches).not.toContain('baton/orphan');
  });
});
