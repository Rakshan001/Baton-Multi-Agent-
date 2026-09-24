// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, gitTry } from '../src/util/exec.js';
import { hasUnsavedWork, worktreeStatus } from '../src/git.js';
import { collectDiff } from '../src/diff.js';
import { saveTasks, type Task } from '../src/store.js';
import { removeTaskWorktree, DirtyWorktreeError } from '../src/commands/rm.js';
import { surveyRepoWorktrees, applyClean } from '../src/commands/clean.js';
import { usePrivateHome } from './helpers/private-home.js';

/**
 * One private HOME for the whole file, so the developer's global git config
 * (showUntrackedFiles, renames, ignoreSubmodules…) cannot steer these tests.
 * exec.ts caches git's env on the FIRST git call, so git keeps the first test's
 * HOME for the rest of the file; the helper removes that dir afterwards, which
 * still leaves git with no user config — the property these tests need.
 * GIT_CONFIG_NOSYSTEM is not set: the helper does not manage it.
 */
usePrivateHome('baton-counts-home-');

/** Multi-line, so a rename plus a one-line edit stays well above 50% similarity. */
const BODY = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

async function initRepo(prefix: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), prefix));
  await git(['init', '-q', '-b', 'main'], repo);
  await git(['config', 'user.email', 't@t.dev'], repo);
  await git(['config', 'user.name', 't'], repo);
  // Pin the defaults these tests depend on, whatever the machine says.
  await git(['config', 'status.renames', 'true'], repo);
  await git(['config', 'diff.renames', 'true'], repo);
  return repo;
}

function task(root: string, wt: string, over: Partial<Task> = {}): Task {
  return {
    slug: 'wt-task', task: 'x', branch: 'baton/wt-task', worktreePath: wt,
    baseBranch: 'main', baseCommit: null, createdAt: '2026-09-21T10:00:00.000Z', phase: 1,
    dependsOn: [], assignee: null, scope: [], expects: [], state: 'queued', requireReview: true,
    ...over,
  } as Task;
}

/**
 * Split-out 1 (data loss). A user's `status.showUntrackedFiles=no` or
 * `diff.ignoreSubmodules=all` made `git status` omit work, so a worktree
 * holding only new files, or only submodule edits, read as clean — and the
 * removal paths (which pass `--force`) deleted it.
 */
describe('work that config hid from git status still counts as unsaved', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await initRepo('baton-counts-');
    await writeFile(join(repo, 'a.ts'), BODY, 'utf-8');
    await git(['add', '-A'], repo);
    await git(['commit', '-qm', 'init'], repo);
  });
  afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

  async function addWorktree(name: string, branch: string): Promise<string> {
    const p = join(repo, name);
    await git(['worktree', 'add', '-q', '-b', branch, p], repo);
    return p;
  }

  it('worktreeStatus reads a worktree holding only untracked files as dirty under showUntrackedFiles=no', async () => {
    await git(['config', 'status.showUntrackedFiles', 'no'], repo);
    const wt = await addWorktree('wt-new', 'baton/wt-task');
    await writeFile(join(wt, 'new.ts'), 'export const n = 1;\n', 'utf-8');

    const st = await worktreeStatus(wt);
    expect(st.state).toBe('dirty');
    expect(st.changedFiles).toEqual(['new.ts']);
    expect(hasUnsavedWork(st)).toBe(true);
  });

  it('baton rm refuses it, and the file survives', async () => {
    await git(['config', 'status.showUntrackedFiles', 'no'], repo);
    const wt = await addWorktree('wt-new', 'baton/wt-task');
    await writeFile(join(wt, 'new.ts'), 'export const n = 1;\n', 'utf-8');
    await mkdir(join(repo, '.baton'), { recursive: true });
    await saveTasks(repo, [task(repo, wt)]);

    await expect(removeTaskWorktree('wt-task', {}, repo)).rejects.toBeInstanceOf(DirtyWorktreeError);
    expect(existsSync(join(wt, 'new.ts'))).toBe(true);
  });

  it('baton clean skips it, and git itself refuses a non-forced remove', async () => {
    await git(['config', 'status.showUntrackedFiles', 'no'], repo);
    const wt = await addWorktree('wt-new', 'feat/new');
    await writeFile(join(wt, 'new.ts'), 'export const n = 1;\n', 'utf-8');

    const survey = await surveyRepoWorktrees(repo);
    expect(survey.find((e) => e.path.endsWith('wt-new'))?.decision).toBe('skip-dirty');
    expect((await applyClean(repo, survey)).removed).toEqual([]);

    // The hardened `-c status.showUntrackedFiles=normal` reaches git's own check.
    const r = await gitTry(['worktree', 'remove', wt], repo);
    expect(r.ok).toBe(false);
    expect(existsSync(join(wt, 'new.ts'))).toBe(true);
  });

  describe('submodule edits under diff.ignoreSubmodules=all', () => {
    let sub: string;
    beforeEach(async () => {
      sub = await initRepo('baton-counts-sub-');
      await writeFile(join(sub, 'f.txt'), 'x\n', 'utf-8');
      await git(['add', '-A'], sub);
      await git(['commit', '-qm', 'sub'], sub);
      await git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sub'], repo);
      await git(['commit', '-qm', 'add sub'], repo);
    });
    afterEach(async () => { await rm(sub, { recursive: true, force: true }); });

    async function editedSubmoduleWorktree(name: string, branch: string): Promise<string> {
      const wt = await addWorktree(name, branch);
      await git(['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q'], wt);
      await appendFile(join(wt, 'sub', 'f.txt'), 'edited\n', 'utf-8');
      await git(['config', 'diff.ignoreSubmodules', 'all'], repo);
      return wt;
    }

    it('reads as dirty, so rm refuses', async () => {
      const wt = await editedSubmoduleWorktree('wt-sub', 'baton/wt-task');
      const st = await worktreeStatus(wt);
      expect(st.state).toBe('dirty');
      expect(st.changedFiles).toEqual(['sub']);
      expect(hasUnsavedWork(st)).toBe(true);

      await mkdir(join(repo, '.baton'), { recursive: true });
      await saveTasks(repo, [task(repo, wt)]);
      await expect(removeTaskWorktree('wt-task', {}, repo)).rejects.toBeInstanceOf(DirtyWorktreeError);
      expect(existsSync(join(wt, 'sub', 'f.txt'))).toBe(true);
    });

    it('baton clean skips it', async () => {
      await editedSubmoduleWorktree('wt-sub', 'feat/sub');
      const survey = await surveyRepoWorktrees(repo);
      expect(survey.find((e) => e.path.endsWith('wt-sub'))?.decision).toBe('skip-dirty');
    });
  });
});
