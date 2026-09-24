// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The front doors in front of a store that cannot be read: `baton new` must
 * refuse before it makes a worktree, and `baton doctor` must report the store
 * as its finding and keep going instead of dying on the junk audit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { createTask } from '../src/commands/new.js';
import { doctorCmd } from '../src/commands/doctor.js';
import { tasksFile } from '../src/store.js';

describe('an unreadable tasks.json at the front doors', () => {
  let root: string;
  let cwd: string;
  let out: string[];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-strict-'));
    for (const a of [['init', '-q'], ['config', 'user.email', 't@t.t'], ['config', 'user.name', 'T'], ['commit', '--allow-empty', '-qm', 'init']]) {
      await execa('git', a, { cwd: root });
    }
    await mkdir(join(root, '.baton'), { recursive: true });
    await writeFile(tasksFile(root), '[{"slug":"a",', 'utf-8');
    cwd = process.cwd();
    process.chdir(root);
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
    process.exitCode = undefined;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    process.exitCode = undefined;
    await rm(root, { recursive: true, force: true });
  });

  it('baton new refuses before creating a worktree', async () => {
    await expect(createTask('new work', root)).rejects.toThrow(/tasks\.json/);
    const wt = join(root, '.baton', 'wt');
    expect(existsSync(wt) ? await readdir(wt) : []).toEqual([]);
  });

  it('baton doctor reports it, exits non-zero, and does not suggest clean --fix', async () => {
    await doctorCmd();
    const said = out.join('\n');
    expect(said).toMatch(/junk audit skipped: tasks\.json/);
    expect(said).not.toContain('Reclaim with');
    expect(process.exitCode).toBe(1);
  });
});
