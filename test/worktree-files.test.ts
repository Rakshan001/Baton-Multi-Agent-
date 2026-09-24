// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Phase 5, §2: `WorktreeRow.files` — the changed-file list threaded through
 * `board.ts` → `worktrees.ts` with no new git spawn, capped at
 * `WORKTREE_FILES_CAP` for the steady-state poll payload.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { createTask } from '../src/commands/new.js';
import { collectWorktrees, WORKTREE_FILES_CAP, type WorktreeRow } from '../src/worktrees.js';

async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@t.t'], ['config', 'user.name', 'T'],
    ['config', 'core.hooksPath', '/dev/null']]) {
    await execa('git', a, { cwd: dir });
  }
  await writeFile(join(dir, 'README.md'), 'base\n', 'utf-8');
  await execa('git', ['add', '-A'], { cwd: dir });
  await execa('git', ['commit', '-qm', 'init'], { cwd: dir });
}

const git = (cwd: string, ...args: string[]) => execa('git', args, { cwd });
const byKind = (rows: WorktreeRow[], kind: string) => rows.filter((r) => r.kind === kind);

describe('WorktreeRow.files', { timeout: 60_000 }, () => {
  let base: string;
  let root: string;

  beforeAll(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), 'baton-wfiles-')));
    root = join(base, 'repo');
    await initRepo(root);
  });
  afterAll(async () => { await rm(base, { recursive: true, force: true }); });

  it('lists a task worktree\'s add/modify/rename with status and oldPath', async () => {
    const t = await createTask('alpha', root);
    await writeFile(join(t.worktreePath, 'README.md'), 'edited\n', 'utf-8');
    await writeFile(join(t.worktreePath, 'to-rename.ts'), 'export {};\n', 'utf-8');
    await git(t.worktreePath, 'add', 'to-rename.ts');
    await git(t.worktreePath, 'commit', '-qm', 'seed to-rename.ts');
    await git(t.worktreePath, 'add', 'README.md');
    await git(t.worktreePath, 'mv', 'to-rename.ts', 'renamed.ts');

    const rows = await collectWorktrees(root);
    const row = byKind(rows, 'task').find((r) => r.slug === 'alpha')!;
    expect(row.files).not.toBeNull();
    expect(row.files!.map((f) => ({ path: f.path, status: f.status, oldPath: f.oldPath })).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'README.md', status: 'modified', oldPath: undefined },
      { path: 'renamed.ts', status: 'renamed', oldPath: 'to-rename.ts' },
    ]);
    expect(row.filesTruncated).toBe(false);
  });

  it('caps a huge untracked file list at WORKTREE_FILES_CAP and reports filesTruncated', async () => {
    const t = await createTask('bravo', root);
    const dir = join(t.worktreePath, 'many');
    await mkdir(dir, { recursive: true });
    const n = WORKTREE_FILES_CAP + 5;
    for (let i = 0; i < n; i++) await writeFile(join(dir, `f${i}.txt`), 'x\n', 'utf-8');

    const rows = await collectWorktrees(root);
    const row = byKind(rows, 'task').find((r) => r.slug === 'bravo')!;
    expect(row.files).toHaveLength(WORKTREE_FILES_CAP);
    expect(row.filesTruncated).toBe(true);
    // The count itself is not capped — only the listed paths.
    expect(row.filesChanged).toBe(n);
  });

  it('reports files: null and filesTruncated: false for a non-task row', async () => {
    await git(root, 'worktree', 'add', '-q', '-b', 'plain', join(base, 'plain'));
    await writeFile(join(base, 'plain', 'x.txt'), 'x\n', 'utf-8');

    const rows = await collectWorktrees(root);
    const external = rows.find((r) => r.kind !== 'task')!;
    expect(external).toBeDefined();
    expect(external.files).toBeNull();
    expect(external.filesTruncated).toBe(false);
  });
});
