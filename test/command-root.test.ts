// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Where a CLI command looks for Baton state.
 *
 * Every command that reads or writes `.baton` used to call `gitRoot()`, which
 * answers "the git checkout I am standing in". That is the wrong question in
 * the two places agents actually stand:
 *
 *  - INSIDE a task worktree (`.baton/wt/<slug>`) — `gitRoot()` returns the
 *    worktree, whose `.baton` is an empty shadow store, so `baton take <slug>`
 *    reported "no task" in the very worktree that task owns, and the
 *    `baton pass --auto` hook silently no-op'd because it decided it was not
 *    in a baton worktree at all;
 *  - at the root of a multi-repo HUB, which is often not a git repo — there
 *    `gitRoot()` throws outright and the command dies.
 *
 * `activeBatonRoot()` is the answer to the right question, and these tests pin
 * it in every position a command can be invoked from. They are written against
 * the resolver rather than each command so that adding a command cannot
 * quietly reintroduce the bug in a place no test looks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { activeBatonRoot } from '../src/store.js';
import { createTask } from '../src/commands/new.js';
import { resolveTask } from '../src/commands/pass.js';
import { gitRoot } from '../src/git.js';
import type { Task } from '../src/store.js';

async function initRepo(dir: string): Promise<void> {
  await git(['init', '-q'], dir);
  await git(['config', 'user.email', 'test@baton.dev'], dir);
  await git(['config', 'user.name', 'Baton Test'], dir);
  await git(['config', 'core.hooksPath', '/dev/null'], dir);
  await git(['checkout', '-q', '-b', 'main'], dir);
  await writeFile(join(dir, 'README.md'), '# r\n', 'utf-8');
  await git(['add', '.'], dir);
  await git(['commit', '-q', '-m', 'initial'], dir);
}

/** No BATON_ROOT: the hard case. A baton-spawned agent carries one, but a
 *  human in a terminal — and any agent they started themselves — does not. */
const from = (cwd: string): Promise<string> => activeBatonRoot(cwd, {});

describe('activeBatonRoot — a plain single repo', () => {
  let repo = '', task: Task;

  beforeAll(async () => {
    repo = realpathSync(await mkdtemp(join(tmpdir(), 'baton-cmdroot-plain-')));
    await initRepo(repo);
    await mkdir(join(repo, '.baton'), { recursive: true });
    task = await createTask('Resolve from anywhere', repo);
  }, 60_000);
  afterAll(async () => { if (repo) await rm(repo, { recursive: true, force: true }); });

  it('resolves from the repo root', async () => {
    expect(await from(repo)).toBe(repo);
  });

  it('resolves from INSIDE a task worktree — where the agent runs', async () => {
    expect(await from(task.worktreePath)).toBe(repo);
    // The bug in one line: the worktree's own git root finds no tasks at all.
    expect(await resolveTask(await gitRoot(task.worktreePath), task.slug)).toBeNull();
    expect((await resolveTask(await from(task.worktreePath), task.slug))?.slug).toBe(task.slug);
  });

  it('resolves from a nested sub-directory', async () => {
    const deep = join(repo, 'src', 'a', 'b');
    await mkdir(deep, { recursive: true });
    expect(await from(deep)).toBe(repo);
  });
});

describe('activeBatonRoot — a multi-repo hub', () => {
  let hub = '', projA = '', task: Task;

  beforeAll(async () => {
    hub = realpathSync(await mkdtemp(join(tmpdir(), 'baton-cmdroot-hub-')));
    projA = join(hub, 'proj-a');
    await mkdir(projA, { recursive: true });
    await initRepo(projA);
    await mkdir(join(hub, '.baton'), { recursive: true });
    await writeFile(join(hub, '.baton', 'kb.json'), JSON.stringify({
      root: hub,
      projects: [{ id: 'proj-a', name: 'proj-a', path: projA, graphPath: join(projA, 'g.json') }],
      mergedGraphPath: join(hub, '.baton', 'kb', 'm.json'),
      lastBuiltAt: null,
    }), 'utf-8');
    task = await createTask('Hub side task', hub, 'proj-a');
  }, 60_000);
  afterAll(async () => { if (hub) await rm(hub, { recursive: true, force: true }); });

  it('resolves the hub root, which git cannot answer for at all', async () => {
    await expect(gitRoot(hub)).rejects.toThrow(/Not inside a git repository/);
    expect(await from(hub)).toBe(hub);
  });

  it('resolves the hub from inside a sub-project, not the sub-project itself', async () => {
    // The sub-project IS a git repo, so gitRoot() answers confidently — and
    // confidently wrong: the tasks live in the hub's store.
    expect(await gitRoot(projA)).toBe(projA);
    expect(await from(projA)).toBe(hub);
  });

  it('resolves the hub from inside a task worktree', async () => {
    expect(await from(task.worktreePath)).toBe(hub);
    expect((await resolveTask(await from(task.worktreePath), task.slug))?.slug).toBe(task.slug);
  });

  it('honours an explicit BATON_ROOT from a baton-spawned agent', async () => {
    expect(await activeBatonRoot(task.worktreePath, { BATON_ROOT: hub })).toBe(hub);
  });
});
