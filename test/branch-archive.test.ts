// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Deleting a `baton/*` branch must never be the last copy of its commits.
 *
 * `branch -D` used to run on every clean/rm path with no check that the tip
 * lived anywhere else — so an orphan branch holding unmerged work was gone for
 * good. Now a tip no DURABLE ref holds (a tag, a non-baton branch, an archive
 * ref) is archived under refs/baton/archive/ first. Remotes, the stash and wip
 * snapshots do not count: each can vanish on its own.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { ArchiveFailedError, branchExists, createWorktree, deleteBranch, removeWorktree } from '../src/git.js';

async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'baton-arch-'));
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@t.t'], ['config', 'user.name', 'T']]) await git(a, root);
  await writeFile(join(root, '.gitignore'), '.baton/\n');
  await git(['add', '-A'], root);
  await git(['commit', '-qm', 'init'], root);
  return root;
}

/** A baton branch with one commit of its own; returns its tip sha. */
async function unmergedBranch(root: string, name: string): Promise<string> {
  await git(['checkout', '-q', '-b', name], root);
  await writeFile(join(root, `${name.replace(/\//g, '-')}.txt`), 'work\n');
  await git(['add', '-A'], root);
  await git(['commit', '-qm', `work on ${name}`], root);
  const tip = (await git(['rev-parse', 'HEAD'], root)).trim();
  await git(['checkout', '-q', 'main'], root);
  return tip;
}

const archivesHolding = async (root: string, sha: string) =>
  (await git(['for-each-ref', '--contains', sha, '--format=%(refname)', 'refs/baton/archive'], root))
    .split('\n').filter(Boolean);

describe('deleteBranch keeps an unmerged tip recoverable', () => {
  let root: string;
  beforeEach(async () => { root = await initRepo(); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('archives an unmerged tip before -D', async () => {
    const tip = await unmergedBranch(root, 'baton/stray');
    expect(await deleteBranch('baton/stray', root)).toBe(true);
    expect(await branchExists('baton/stray', root)).toBe(false);
    expect(await archivesHolding(root, tip)).toHaveLength(1);
  });

  it('does not archive a tip a non-baton branch already holds', async () => {
    const tip = await unmergedBranch(root, 'baton/merged');
    await git(['merge', '-q', '--ff-only', 'baton/merged'], root);
    expect(await deleteBranch('baton/merged', root)).toBe(true);
    expect(await archivesHolding(root, tip)).toEqual([]);
  });

  it('still archives a tip only a stash or remote-tracking ref holds', async () => {
    const tip = await unmergedBranch(root, 'baton/fragile');
    await git(['update-ref', 'refs/remotes/origin/baton/fragile', tip], root);
    await git(['update-ref', 'refs/stash', tip], root);
    await deleteBranch('baton/fragile', root);
    expect(await archivesHolding(root, tip)).toHaveLength(1);
  });

  it('keeps both reachable when two baton branches share a tip and both go', async () => {
    const tip = await unmergedBranch(root, 'baton/one');
    await git(['branch', 'baton/two', 'baton/one'], root);
    await deleteBranch('baton/one', root);
    await deleteBranch('baton/two', root);
    expect(await archivesHolding(root, tip)).not.toEqual([]);
  });

  it('is a quiet no-op for a branch that is already gone', async () => {
    await expect(deleteBranch('baton/never-was', root)).resolves.toBe(false);
  });

  it('refuses the delete when the archive cannot be written', async () => {
    await unmergedBranch(root, 'baton/stuck');
    // A file where the archive ref directory must go makes update-ref fail.
    await mkdir(join(root, '.git', 'refs', 'baton'), { recursive: true });
    await writeFile(join(root, '.git', 'refs', 'baton', 'archive'), 'not a directory');
    await expect(deleteBranch('baton/stuck', root)).rejects.toBeInstanceOf(ArchiveFailedError);
    expect(await branchExists('baton/stuck', root)).toBe(true);
  });

  it('can be told not to archive (purge)', async () => {
    const tip = await unmergedBranch(root, 'baton/purged');
    await deleteBranch('baton/purged', root, { archive: false });
    expect(await archivesHolding(root, tip)).toEqual([]);
  });
});

describe('removeWorktree archives before it touches the disk', () => {
  let root: string;
  beforeEach(async () => { root = await initRepo(); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('archives the unmerged branch it deletes', async () => {
    const wt = join(root, '.baton', 'wt', 'job');
    await createWorktree(wt, 'baton/job', 'HEAD', root);
    await writeFile(join(wt, 'x.txt'), 'x\n');
    await git(['add', '-A'], wt);
    await git(['commit', '-qm', 'job'], wt);
    const tip = (await git(['rev-parse', 'HEAD'], wt)).trim();
    await removeWorktree(wt, 'baton/job', root);
    expect(existsSync(wt)).toBe(false);
    expect(await archivesHolding(root, tip)).toHaveLength(1);
  });

  it('leaves the worktree in place when the archive cannot be written', async () => {
    const wt = join(root, '.baton', 'wt', 'job2');
    await createWorktree(wt, 'baton/job2', 'HEAD', root);
    await writeFile(join(wt, 'x.txt'), 'x\n');
    await git(['add', '-A'], wt);
    await git(['commit', '-qm', 'job2'], wt);
    await mkdir(join(root, '.git', 'refs', 'baton'), { recursive: true });
    await writeFile(join(root, '.git', 'refs', 'baton', 'archive'), 'not a directory');
    await expect(removeWorktree(wt, 'baton/job2', root)).rejects.toBeInstanceOf(ArchiveFailedError);
    expect(existsSync(wt)).toBe(true);
  });

  it('does not throw for a detached worktree (no branch)', async () => {
    const wt = join(root, '.baton', 'wt', 'loose');
    await git(['worktree', 'add', '-q', '--detach', wt, 'HEAD'], root);
    await expect(removeWorktree(wt, '', root)).resolves.toBeUndefined();
    expect(existsSync(wt)).toBe(false);
  });
});
