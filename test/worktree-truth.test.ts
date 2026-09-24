// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `collectWorktrees` against a real repo, for the two rows that used to say
 * "safe" about work nobody had looked at: a task whose base branch does not
 * resolve (commits counted as 0), and an orphan worktree (stubbed as clean).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { createTask } from '../src/commands/new.js';
import { createWorktree } from '../src/git.js';
import { loadTasks, saveTasks } from '../src/store.js';
import { collectWorktrees } from '../src/worktrees.js';

describe('collectWorktrees does not call unseen work safe', { timeout: 20_000 }, () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-truth-'));
    for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@t.t'], ['config', 'user.name', 'T'],
      ['commit', '--allow-empty', '-qm', 'init']]) await execa('git', a, { cwd: root });
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  async function taskWithOneCommit(name: string, baseBranch: string): Promise<string> {
    const t = await createTask(name, root);
    await writeFile(join(t.worktreePath, `${t.slug}.txt`), 'work\n');
    await execa('git', ['add', '-A'], { cwd: t.worktreePath });
    await execa('git', ['commit', '-qm', 'work'], { cwd: t.worktreePath });
    await saveTasks(root, (await loadTasks(root)).map((x) => (x.slug === t.slug ? { ...x, baseBranch } : x)));
    return t.slug;
  }

  it('does not count commits as safe when the base branch does not resolve', async () => {
    const slug = await taskWithOneCommit('unresolvable base', 'no-such-base');
    const row = (await collectWorktrees(root)).find((r) => r.slug === slug)!;
    expect(row.unprotected.commits).toBeNull();
    expect(row.unprotected.atRisk).toBe(true);
  });

  // Not just a local branch name: a detached-HEAD task and a remote-tracking
  // base must keep a real count, or the fix trades false safety for false alarms.
  for (const base of ['main', 'HEAD', 'origin/main']) {
    it(`still counts them when the base (${base}) does resolve`, async () => {
      await execa('git', ['update-ref', 'refs/remotes/origin/main', 'main'], { cwd: root });
      const slug = await taskWithOneCommit(`resolvable base ${base.replace('/', ' ')}`, base);
      const row = (await collectWorktrees(root)).find((r) => r.slug === slug)!;
      expect(row.unprotected.commits).toBe(1);
      expect(row.unprotected.atRisk).toBe(true);
    });
  }

  it('reports an orphan worktree as uncounted, not clean', async () => {
    const path = join(root, '.baton', 'wt', 'ghost');
    await createWorktree(path, 'baton/ghost', 'HEAD', root); // no task owns it
    await writeFile(join(path, 'unsaved.txt'), 'nobody committed this');
    const row = (await collectWorktrees(root)).find((r) => r.orphan && r.branch === 'baton/ghost')!;
    expect(row.health).toBe('orphan-disk');
    expect(row.filesChanged).toBeNull();
    expect(row.ahead).toBeNull();
    expect(row.repoState).toBeNull();
    expect(row.unprotected.atRisk).toBe(true);
  });
});
