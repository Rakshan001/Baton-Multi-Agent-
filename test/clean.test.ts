import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { parseWorktreePorcelain, decideWorktree, surveyRepoWorktrees, applyClean } from '../src/commands/clean.js';

/**
 * W1 — worktree GC. A real production hub accumulated 60+ agent-created
 * worktrees (~13GB), ~90% for branches ALREADY MERGED via GitHub PRs — pure
 * dead weight that also poisons searches (60 copies of every file). `baton
 * clean` surveys every registered worktree, removes only merged+clean ones,
 * and never touches main/dirty/unmerged/locked trees. Branches are never
 * deleted — only working trees.
 */

describe('parseWorktreePorcelain — git worktree list --porcelain', () => {
  it('parses main, branch, detached, locked and prunable entries', () => {
    const out = [
      'worktree /repo',
      'HEAD aaa1111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /repo/wt-feature',
      'HEAD bbb2222222222222222222222222222222222222',
      'branch refs/heads/feat/x',
      '',
      'worktree /repo/wt-detached',
      'HEAD ccc3333333333333333333333333333333333333',
      'detached',
      '',
      'worktree /repo/wt-locked',
      'HEAD ddd4444444444444444444444444444444444444',
      'branch refs/heads/wip',
      'locked agent says keep',
      '',
      'worktree /repo/wt-gone',
      'HEAD eee5555555555555555555555555555555555555',
      'branch refs/heads/old',
      'prunable gitdir file points to non-existent location',
    ].join('\n');
    const entries = parseWorktreePorcelain(out);
    expect(entries).toHaveLength(5);
    expect(entries[0]).toMatchObject({ path: '/repo', branch: 'main', locked: false, prunable: false });
    expect(entries[1]).toMatchObject({ path: '/repo/wt-feature', branch: 'feat/x' });
    expect(entries[2]).toMatchObject({ path: '/repo/wt-detached', branch: null });
    expect(entries[3]).toMatchObject({ path: '/repo/wt-locked', locked: true });
    expect(entries[4]).toMatchObject({ path: '/repo/wt-gone', prunable: true });
  });

  it('returns [] for empty output', () => {
    expect(parseWorktreePorcelain('')).toEqual([]);
  });
});

describe('decideWorktree — the safety matrix', () => {
  const base = { isMain: false, merged: true, dirty: false, locked: false, prunable: false };
  it('only merged + clean + unlocked non-main trees are removable', () => {
    expect(decideWorktree(base)).toBe('removable');
  });
  it('never the main checkout, even when "merged"', () => {
    expect(decideWorktree({ ...base, isMain: true })).toBe('keep-main');
  });
  it('never a dirty tree (uncommitted work is sacred)', () => {
    expect(decideWorktree({ ...base, dirty: true })).toBe('skip-dirty');
  });
  it('never an unmerged branch (unshipped commits)', () => {
    expect(decideWorktree({ ...base, merged: false })).toBe('skip-unmerged');
  });
  it('never a locked tree (someone said keep)', () => {
    expect(decideWorktree({ ...base, locked: true })).toBe('skip-locked');
  });
  it('a prunable entry (folder already gone) is prune-only', () => {
    expect(decideWorktree({ ...base, prunable: true })).toBe('prunable');
  });
});

describe('surveyRepoWorktrees + applyClean — against real git repos', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'baton-clean-'));
    await git(['init', '-q', '-b', 'main'], repo);
    await git(['config', 'user.email', 't@t.dev'], repo);
    await git(['config', 'user.name', 't'], repo);
    await writeFile(join(repo, 'a.ts'), 'export const a = 1;\n', 'utf-8');
    await git(['add', '.'], repo);
    await git(['commit', '-q', '-m', 'init'], repo);
  });
  afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

  async function addWorktree(name: string, branch: string): Promise<string> {
    const p = join(repo, name);
    await git(['worktree', 'add', '-q', '-b', branch, p], repo);
    return p;
  }

  it('classifies a merged clean worktree removable, and applyClean removes ONLY it', async () => {
    // merged: branch created at HEAD → ancestor of main
    const mergedWt = await addWorktree('wt-merged', 'feat/merged');
    // unmerged: has its own commit main doesn't have
    const unmergedWt = await addWorktree('wt-unmerged', 'feat/unmerged');
    await writeFile(join(unmergedWt, 'b.ts'), 'export const b = 1;\n', 'utf-8');
    await git(['add', '.'], unmergedWt);
    await git(['commit', '-q', '-m', 'wip'], unmergedWt);
    // dirty: merged position but uncommitted edits
    const dirtyWt = await addWorktree('wt-dirty', 'feat/dirty');
    await writeFile(join(dirtyWt, 'a.ts'), 'export const a = 2;\n', 'utf-8');

    const survey = await surveyRepoWorktrees(repo);
    const bySuffix = (s: string) => survey.find((e) => e.path.endsWith(s));
    expect(bySuffix('wt-merged')?.decision).toBe('removable');
    expect(bySuffix('wt-unmerged')?.decision).toBe('skip-unmerged');
    expect(bySuffix('wt-dirty')?.decision).toBe('skip-dirty');
    // git canonicalizes paths (macOS /var → /private/var), so match by position:
    // porcelain guarantees the main worktree is listed first.
    expect(survey[0]?.decision).toBe('keep-main');

    const result = await applyClean(repo, survey);
    expect(result.removed.map((p) => p.split('/').pop())).toEqual(['wt-merged']);
    expect(existsSync(mergedWt)).toBe(false);
    expect(existsSync(unmergedWt)).toBe(true); // untouched
    expect(existsSync(dirtyWt)).toBe(true); // untouched
    // the branch itself survives — we only remove working trees
    const branches = await git(['branch', '--list', 'feat/merged'], repo);
    expect(branches).toContain('feat/merged');
  });

  it('prefers origin/<default> as the merge target when a remote exists', async () => {
    // A branch merged into origin/main but NOT into the local main checkout
    // must still count as merged (the PR-merge workflow).
    const remote = await mkdtemp(join(tmpdir(), 'baton-clean-remote-'));
    await git(['init', '-q', '--bare', remote], remote);
    await git(['remote', 'add', 'origin', remote], repo);
    const wt = await addWorktree('wt-pr', 'feat/pr');
    await writeFile(join(wt, 'c.ts'), 'export const c = 1;\n', 'utf-8');
    await git(['add', '.'], wt);
    await git(['commit', '-q', '-m', 'pr work'], wt);
    // simulate the PR merge landing on origin/main without local main moving
    await git(['push', '-q', 'origin', 'feat/pr:main'], repo);
    await git(['fetch', '-q', 'origin'], repo);

    const survey = await surveyRepoWorktrees(repo);
    expect(survey.find((e) => e.path.endsWith('wt-pr'))?.decision).toBe('removable');
    await rm(remote, { recursive: true, force: true });
  });

  it('a repo with no commits or no worktrees fails safe (empty survey, apply no-ops)', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'baton-clean-empty-'));
    const survey = await surveyRepoWorktrees(bare); // not even a git repo
    expect(survey).toEqual([]);
    const result = await applyClean(bare, survey);
    expect(result.removed).toEqual([]);
    await rm(bare, { recursive: true, force: true });
  });
});
