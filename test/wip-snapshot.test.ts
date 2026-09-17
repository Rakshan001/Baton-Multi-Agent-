// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, gitTry } from '../src/util/exec.js';
import {
  enteredRisk,
  snapshotWip,
  wipRefFor,
  WIP_MAX_FILE_BYTES,
  WIP_MAX_TOTAL_BYTES,
} from '../src/wip-snapshot.js';

/** A repo with one commit, a .gitignore, and git identity — same shape as test/git.test.ts. */
async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'baton-wip-'));
  await git(['init', '-q'], root);
  await git(['config', 'user.email', 'test@baton.dev'], root);
  await git(['config', 'user.name', 'Baton Test'], root);
  await git(['checkout', '-q', '-b', 'main'], root);
  await writeFile(join(root, 'a.txt'), 'committed\n', 'utf-8');
  await writeFile(join(root, '.gitignore'), '.env\nnode_modules/\n', 'utf-8');
  await git(['add', '.'], root);
  await git(['commit', '-q', '-m', 'initial'], root);
  return root;
}

/** Full ref list as git itself sees it — the check that we wrote exactly one. */
async function refs(repo: string, prefix = 'refs/baton/wip/'): Promise<string[]> {
  const r = await gitTry(['-C', repo, 'for-each-ref', '--format=%(refname)', prefix]);
  return r.ok && r.stdout ? r.stdout.split('\n').filter(Boolean) : [];
}

async function show(repo: string, rev: string): Promise<string | null> {
  const r = await gitTry(['-C', repo, 'show', rev]);
  return r.ok ? r.stdout : null;
}

describe('snapshotWip', () => {
  let root: string;
  beforeEach(async () => {
    root = await initRepo();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes nothing for a clean worktree', async () => {
    expect(await snapshotWip('clean-task', root)).toBeNull();
    expect(await refs(root)).toEqual([]);
  });

  it('writes a dangling commit under refs/baton/wip/<slug>, invisible to git branch', async () => {
    await writeFile(join(root, 'a.txt'), 'work in progress\n', 'utf-8');
    const snap = await snapshotWip('feat-x', root);
    expect(snap).not.toBeNull();
    expect(snap!.ref).toBe('refs/baton/wip/feat-x');
    expect(wipRefFor('feat-x')).toBe(snap!.ref);
    expect(await refs(root)).toEqual(['refs/baton/wip/feat-x']);
    // The ref is a commit git can show, and it carries the working-tree content.
    expect(await show(root, `${snap!.ref}:a.txt`)).toBe('work in progress');
    // ...and no branch was created.
    const branches = await git(['-C', root, 'branch', '--list', '--all']);
    expect(branches).not.toContain('feat-x');
  });

  it('captures untracked work but never a gitignored path', async () => {
    await writeFile(join(root, 'new.ts'), 'export const x = 1;\n', 'utf-8');
    await writeFile(join(root, '.env'), 'OPENAI_API_KEY=sk-live-do-not-capture\n', 'utf-8');
    const snap = await snapshotWip('feat-y', root);
    expect(snap).not.toBeNull();
    const tree = await git(['-C', root, 'ls-tree', '-r', '--name-only', snap!.ref]);
    expect(tree.split('\n')).toContain('new.ts');
    expect(tree).not.toContain('.env');
    expect(await show(root, `${snap!.ref}:.env`)).toBeNull();
  });

  it('survives removal of the worktree directory', async () => {
    const wt = join(root, '..', `wt-${Date.now()}`);
    await git(['-C', root, 'worktree', 'add', '-q', '-b', 'feat/gone', wt], root);
    await writeFile(join(wt, 'a.txt'), 'hours of unsaved work\n', 'utf-8');
    const snap = await snapshotWip('gone', wt);
    expect(snap).not.toBeNull();

    await git(['-C', root, 'worktree', 'remove', '--force', wt]);
    await rm(wt, { recursive: true, force: true });
    await git(['-C', root, 'branch', '-D', 'feat/gone']);
    await git(['-C', root, 'gc', '--prune=now', '--quiet']);

    // The directory and the branch are gone; the snapshot is not.
    expect(await refs(root)).toEqual(['refs/baton/wip/gone']);
    expect(await show(root, 'refs/baton/wip/gone:a.txt')).toBe('hours of unsaved work');
  });

  it('is idempotent on content: two snapshots with no change leave one ref at one sha', async () => {
    await writeFile(join(root, 'a.txt'), 'same bytes\n', 'utf-8');
    const first = await snapshotWip('idem', root);
    const second = await snapshotWip('idem', root);
    expect(first!.updated).toBe(true);
    expect(second!.updated).toBe(false);
    expect(second!.sha).toBe(first!.sha);
    expect(await refs(root)).toEqual(['refs/baton/wip/idem']);
  });

  it('moves the ref when the content changes', async () => {
    await writeFile(join(root, 'a.txt'), 'first\n', 'utf-8');
    const first = await snapshotWip('moves', root);
    await writeFile(join(root, 'a.txt'), 'second\n', 'utf-8');
    const second = await snapshotWip('moves', root);
    expect(second!.updated).toBe(true);
    expect(second!.sha).not.toBe(first!.sha);
    expect(await refs(root)).toEqual(['refs/baton/wip/moves']);
    expect(await show(root, 'refs/baton/wip/moves:a.txt')).toBe('second');
  });

  it('records a file the agent deleted', async () => {
    await rm(join(root, 'a.txt'));
    const snap = await snapshotWip('deleted', root);
    expect(snap).not.toBeNull();
    const tree = await git(['-C', root, 'ls-tree', '-r', '--name-only', snap!.ref]);
    expect(tree.split('\n')).not.toContain('a.txt');
  });

  it('skips a file over the per-file cap and still captures the rest', async () => {
    await writeFile(join(root, 'small.txt'), 'keep me\n', 'utf-8');
    await writeFile(join(root, 'huge.bin'), 'x'.repeat(4096), 'utf-8');
    const snap = await snapshotWip('capped', root, { maxFileBytes: 1024 });
    expect(snap).not.toBeNull();
    expect(snap!.skipped).toContain('huge.bin');
    const tree = await git(['-C', root, 'ls-tree', '-r', '--name-only', snap!.ref]);
    expect(tree.split('\n')).toContain('small.txt');
    expect(tree).not.toContain('huge.bin');
  });

  it('stops at the total cap instead of swallowing the whole worktree', async () => {
    for (const n of ['1', '2', '3']) {
      await writeFile(join(root, `f${n}.txt`), 'y'.repeat(400), 'utf-8');
    }
    const snap = await snapshotWip('total-cap', root, { maxTotalBytes: 500 });
    expect(snap).not.toBeNull();
    expect(snap!.skipped.length).toBeGreaterThan(0);
    expect(snap!.bytes).toBeLessThanOrEqual(500);
  });

  it('ships caps that are enforced by default', () => {
    expect(WIP_MAX_FILE_BYTES).toBeGreaterThan(0);
    expect(WIP_MAX_TOTAL_BYTES).toBeGreaterThanOrEqual(WIP_MAX_FILE_BYTES);
  });

  it('refuses a slug that is not a safe ref component', async () => {
    await writeFile(join(root, 'a.txt'), 'dirty\n', 'utf-8');
    expect(await snapshotWip('../../evil', root)).toBeNull();
    expect(await snapshotWip('has space', root)).toBeNull();
    expect(await refs(root, 'refs/baton/')).toEqual([]);
  });

  it('returns null for a path that is not a git worktree', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'baton-notgit-'));
    try {
      expect(await snapshotWip('nope', dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('enteredRisk', () => {
  const dirty = { agent: null, status: 'dirty' as const };

  it('fires when the agent disappears while the work is uncommitted', () => {
    expect(enteredRisk({ agent: 'claude', status: 'dirty' }, dirty)).toBe(true);
  });

  it('fires when a still-held worktree first becomes dirty after the agent left', () => {
    expect(enteredRisk({ agent: null, status: 'clean' }, dirty)).toBe(true);
  });

  it('does not fire while the agent is still attached', () => {
    expect(enteredRisk({ agent: 'claude', status: 'dirty' }, { agent: 'claude', status: 'dirty' })).toBe(false);
  });

  it('does not fire again when the row was already at risk last tick', () => {
    expect(enteredRisk(dirty, dirty)).toBe(false);
  });

  it('does not fire for a clean worktree', () => {
    expect(enteredRisk({ agent: 'claude', status: 'clean' }, { agent: null, status: 'clean' })).toBe(false);
  });

  it('does not fire for a worktree that is already gone', () => {
    expect(enteredRisk({ agent: 'claude', status: 'dirty' }, { agent: null, status: 'missing' })).toBe(false);
  });
});
