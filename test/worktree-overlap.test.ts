// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Phase 5, §3: cross-worktree overlap — the same path changed in ≥2 task
 * worktrees, computed once over rows already in memory (`attachOverlaps`),
 * zero new git spawns. Task rows only; orphan/main/external are never a
 * source or target (their `files` is `null`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { createTask } from '../src/commands/new.js';
import { collectWorktrees, type WorktreeRow } from '../src/worktrees.js';

async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@t.t'], ['config', 'user.name', 'T'],
    ['config', 'core.hooksPath', '/dev/null']]) {
    await execa('git', a, { cwd: dir });
  }
  await writeFile(join(dir, 'app.ts'), 'base\n', 'utf-8');
  await execa('git', ['add', '-A'], { cwd: dir });
  await execa('git', ['commit', '-qm', 'init'], { cwd: dir });
}

const git = (cwd: string, ...args: string[]) => execa('git', args, { cwd });
const byKind = (rows: WorktreeRow[], kind: string) => rows.filter((r) => r.kind === kind);
const fileOf = (r: WorktreeRow, path: string) => r.files?.find((f) => f.path === path);

describe('cross-worktree overlap', { timeout: 60_000 }, () => {
  let base: string;
  let root: string;

  beforeAll(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), 'baton-overlap-')));
    root = join(base, 'repo');
    await initRepo(root);
  });
  afterAll(async () => { await rm(base, { recursive: true, force: true }); });

  it('two tasks editing the same path get overlaps naming the OTHER slug, not themselves', async () => {
    const a = await createTask('alpha', root);
    const b = await createTask('bravo', root);
    await writeFile(join(a.worktreePath, 'app.ts'), 'alpha edit\n', 'utf-8');
    await writeFile(join(b.worktreePath, 'app.ts'), 'bravo edit\n', 'utf-8');

    const rows = await collectWorktrees(root);
    const rowA = byKind(rows, 'task').find((r) => r.slug === 'alpha')!;
    const rowB = byKind(rows, 'task').find((r) => r.slug === 'bravo')!;
    expect(fileOf(rowA, 'app.ts')?.overlaps).toEqual(['bravo']);
    expect(fileOf(rowB, 'app.ts')?.overlaps).toEqual(['alpha']);
    expect(rowA.overlapCount).toBe(1);
    expect(rowB.overlapCount).toBe(1);
  });

  it('three tasks on one path each list the other two', async () => {
    const c = await createTask('charlie', root);
    await writeFile(join(c.worktreePath, 'app.ts'), 'charlie edit\n', 'utf-8');

    const rows = await collectWorktrees(root);
    const tasks = byKind(rows, 'task');
    for (const slug of ['alpha', 'bravo', 'charlie']) {
      const row = tasks.find((r) => r.slug === slug)!;
      const others = ['alpha', 'bravo', 'charlie'].filter((s) => s !== slug);
      expect(fileOf(row, 'app.ts')?.overlaps?.sort()).toEqual(others.sort());
    }
  });

  it('a file only one task touches carries no overlaps key at all (undefined, not [])', async () => {
    const d = await createTask('delta', root);
    await writeFile(join(d.worktreePath, 'solo.ts'), 'only delta\n', 'utf-8');

    const rows = await collectWorktrees(root);
    const rowD = byKind(rows, 'task').find((r) => r.slug === 'delta')!;
    const solo = fileOf(rowD, 'solo.ts')!;
    expect(solo.overlaps).toBeUndefined();
    expect('overlaps' in solo).toBe(false);
  });

  it('a rename on one side overlapping an edit of the new path on the other matches on the NEW path only', async () => {
    // Both sides branch from a base that already has `old.ts` (new.ts does not exist yet).
    await writeFile(join(root, 'old.ts'), 'old base\n', 'utf-8');
    await git(root, 'add', '-A');
    await git(root, 'commit', '-qm', 'seed old.ts');

    const e = await createTask('echo', root);
    const f = await createTask('foxtrot', root);
    // echo renames old.ts -> new.ts.
    await git(e.worktreePath, 'mv', 'old.ts', 'new.ts');
    // foxtrot never touches old.ts — it independently creates its OWN new.ts,
    // landing on the same path echo's rename produced, by coincidence.
    await writeFile(join(f.worktreePath, 'new.ts'), 'foxtrot new file\n', 'utf-8');

    const rows = await collectWorktrees(root);
    const tasks = byKind(rows, 'task');
    const rowE = tasks.find((r) => r.slug === 'echo')!;
    const rowF = tasks.find((r) => r.slug === 'foxtrot')!;
    expect(fileOf(rowE, 'new.ts')?.overlaps).toEqual(['foxtrot']);
    // The OLD path is never a match target — it isn't even in echo's file list.
    expect(fileOf(rowE, 'old.ts')).toBeUndefined();
    expect(fileOf(rowF, 'new.ts')?.overlaps).toEqual(['echo']);
    expect(fileOf(rowF, 'old.ts')).toBeUndefined();
  });

  it('an orphan/main/external row is never a source or target of an overlap', async () => {
    await git(root, 'worktree', 'add', '-q', '-b', 'plain', join(base, 'plain'));
    await writeFile(join(base, 'plain', 'app.ts'), 'plain edit, same path as the task rows\n', 'utf-8');

    const rows = await collectWorktrees(root);
    const nonTask = rows.find((r) => r.kind !== 'task')!;
    expect(nonTask.files).toBeNull();
    expect(nonTask.overlapCount).toBe(0);
    // And it never shows up in a task row's overlaps, since it was never read.
    const rowA = byKind(rows, 'task').find((r) => r.slug === 'alpha')!;
    expect(fileOf(rowA, 'app.ts')?.overlaps).not.toContain(nonTask.slug);
  });
});
