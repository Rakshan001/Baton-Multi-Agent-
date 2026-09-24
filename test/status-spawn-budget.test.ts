// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The git spawn budget of one warm poll tick (`collectStatus`), and the
 * ceiling the global limiter puts on how many of those run at once.
 *
 * Every git call goes through a bash shim on PATH that appends `START`/`END`
 * to an O_APPEND log around a run of the REAL git (an absolute path, so the
 * shim never finds itself). Peak concurrency is read from the ORDER of those
 * lines, not from timestamps: BSD `date` has no `%N`, and order is exact.
 *
 * The count is pinned exactly, on purpose. It is a change-detector: a new
 * per-task spawn on the 2s tick should fail here and be a deliberate choice,
 * not something found later on a 50-worktree hub.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';

const skip = process.platform === 'win32';

// exec.ts caches git's env on its FIRST call, so PATH, GITLOG, HOME and
// XDG_CONFIG_HOME must be in place before anything below runs git. Module scope
// runs before any hook. A private HOME keeps the developer's global git config
// (aliases, status settings, hooks) out of the count.
//
// The shim must run git by ABSOLUTE path: a bare `git` would resolve through
// PATH back to the shim and recurse forever. /usr/bin/git first, since that is
// the system git; otherwise the first real git on the original PATH.
const saved = { PATH: process.env.PATH, GITLOG: process.env.GITLOG, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
const realGit = existsSync('/usr/bin/git')
  ? '/usr/bin/git'
  : (process.env.PATH ?? '').split(delimiter).map((d) => join(d, 'git')).find((p) => existsSync(p));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'baton-spawn-')));
const logFile = join(scratch, 'git.log');
if (!skip && realGit) {
  const bin = join(scratch, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), [
    '#!/bin/sh',
    'echo START >> "$GITLOG"',
    `${JSON.stringify(realGit)} "$@"`,
    'rc=$?',
    'echo END >> "$GITLOG"',
    'exit $rc',
    '',
  ].join('\n'));
  chmodSync(join(bin, 'git'), 0o755);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
  process.env.GITLOG = logFile;
  process.env.HOME = scratch;
  process.env.XDG_CONFIG_HOME = scratch;
}

function restoreEnv(): void {
  for (const [k, v] of Object.entries(saved)) {
    // Assigning undefined would store the STRING "undefined"; delete instead.
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// More tasks than GIT_MAX_CONCURRENT, so the cap is actually exercised:
// uncapped, this fixture measured a peak of 12 (= N); capped, exactly 8.
const TASKS = 12;
const DIRTY = 3;

describe.skipIf(skip || !realGit)('collectStatus git spawn budget', () => {
  let root: string;

  beforeAll(async () => {
    const { git } = await import('../src/util/exec.js');
    const { saveTasks } = await import('../src/store.js');
    root = realpathSync(await mkdtemp(join(tmpdir(), 'baton-budget-')));
    await git(['init', '-q', '-b', 'main'], root);
    await git(['config', 'user.email', 't@t.dev'], root);
    await git(['config', 'user.name', 't'], root);
    await writeFile(join(root, 'a.ts'), 'export const a = 1;\n', 'utf-8');
    await git(['add', '.'], root);
    await git(['commit', '-qm', 'init'], root);
    const base = await git(['rev-parse', 'HEAD'], root);
    await mkdir(join(root, '.baton', 'wt'), { recursive: true });
    const tasks = [];
    for (let i = 0; i < TASKS; i++) {
      const slug = `t${i}`;
      const wt = join(root, '.baton', 'wt', slug);
      await git(['worktree', 'add', '-q', '-b', `baton/${slug}`, wt, 'main'], root);
      if (i < DIRTY) await writeFile(join(wt, 'a.ts'), `export const a = ${i + 2};\n`, 'utf-8');
      tasks.push({
        slug, task: slug, branch: `baton/${slug}`, worktreePath: wt, baseBranch: 'main',
        baseCommit: base, createdAt: new Date().toISOString(), repoRoot: root,
      });
    }
    await saveTasks(root, tasks as never);
  });

  afterAll(async () => {
    restoreEnv();
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });

  it('spends an exact, pinned number of spawns, never more than the cap at once', async () => {
    const { collectStatus } = await import('../src/board.js');
    const { GIT_MAX_CONCURRENT } = await import('../src/util/exec.js');
    await collectStatus(root);           // warm: the cold tick adds one-time lookups
    writeFileSync(logFile, '');          // truncate; the shim appends
    const rows = await collectStatus(root);
    expect(rows.filter((r) => r.status === 'dirty')).toHaveLength(DIRTY);

    const lines = readFileSync(logFile, 'utf-8').split('\n').filter(Boolean);
    let active = 0;
    let peak = 0;
    for (const l of lines) {
      active += l === 'START' ? 1 : -1;
      peak = Math.max(peak, active);
    }
    const spawns = lines.filter((l) => l === 'START').length;
    expect(active).toBe(0);              // every START has its END
    // 51 = 4 per task × 12 + 1 per dirty task × 3. Per task: `status`,
    // `rev-list --left-right`, and two `diff --name-only` for conflicts; plus
    // `diff --numstat` only when dirty. Nothing per tick outside the tasks.
    // Change this number only on purpose.
    expect(spawns).toBe(51);
    expect(peak).toBeLessThanOrEqual(GIT_MAX_CONCURRENT);
    expect(peak).toBeGreaterThan(1);     // the log really saw overlap
  });
});
