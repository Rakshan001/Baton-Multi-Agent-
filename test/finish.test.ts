// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { loadTasks, saveTasks, type Task } from '../src/store.js';
import { claimTask } from '../src/commands/claim.js';
import { doneCmd } from '../src/commands/take.js';

/** The done gate against a real repo, real commits, real worktree. */
describe('the done gate', () => {
  let root: string;
  let wt: string;
  let out: string[];
  let err: string[];
  let cwd: string;
  const env = { ...process.env };
  const claude = { agent: 'claude', sessionSlug: 's1' };

  const row = (over: Partial<Task> = {}): Task => ({
    slug: 'auth-schema', task: 'add the tables', branch: 'baton/auth-schema',
    worktreePath: '', baseBranch: 'HEAD', baseCommit: null,
    createdAt: '2026-08-05T10:00:00.000Z', phase: 1, dependsOn: [], assignee: null,
    scope: ['src/db/**'], expects: [], state: 'queued', requireReview: true,
    ...over,
  });

  async function setup(over: Partial<Task> = {}): Promise<void> {
    await saveTasks(root, [{ ...row(over), worktreePath: join(root, '.baton', 'wt', 'auth-schema') }]);
    const r = await claimTask(root, 'auth-schema', claude);
    wt = r.task.worktreePath;
  }
  const commit = async (path: string, body: string, msg: string): Promise<void> => {
    await mkdir(join(wt, path.split('/').slice(0, -1).join('/')), { recursive: true });
    await writeFile(join(wt, path), body, 'utf-8');
    await git(['add', '-A'], wt);
    await git(['commit', '-qm', msg], wt);
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-done-'));
    await git(['init', '-q', '-b', 'main'], root);
    await git(['config', 'user.email', 't@t.dev'], root);
    await git(['config', 'user.name', 't'], root);
    await mkdir(join(root, 'src', 'db'), { recursive: true });
    await mkdir(join(root, 'src', 'auth'), { recursive: true });
    await writeFile(join(root, 'src', 'db', 'a.ts'), 'x\n', 'utf-8');
    await writeFile(join(root, 'src', 'auth', 'b.ts'), 'y\n', 'utf-8');
    await git(['add', '-A'], root);
    await git(['commit', '-qm', 'init'], root);
    await mkdir(join(root, '.baton'), { recursive: true });
    cwd = process.cwd();
    process.chdir(root);
    process.env.BATON_AGENT = 'claude';
    process.env.BATON_SLUG = 's1';
    out = []; err = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
    process.exitCode = undefined;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    process.env = { ...env };
    process.exitCode = undefined;
    await rm(root, { recursive: true, force: true });
  });

  /**
   * The most expensive failure in a five-agent pipeline: an agent that ran out
   * of context and reported success. Every downstream phase builds on nothing.
   */
  it('refuses done with no commits, and leaves the task with its owner', async () => {
    await setup();
    await doneCmd('auth-schema', {});
    expect(out.join('\n')).toContain('no commits');
    expect(process.exitCode).toBe(1);
    const [t] = await loadTasks(root);
    expect(t.state).toBe('active');
    expect(t.claimedBy?.agent).toBe('claude');
  });

  it('refuses while work is still uncommitted', async () => {
    await setup();
    await writeFile(join(wt, 'src', 'db', 'users.sql'), 'CREATE TABLE users;\n', 'utf-8');
    await doneCmd('auth-schema', { attest: true });
    expect(out.join('\n')).toContain('uncommitted');
    expect((await loadTasks(root))[0].state).toBe('active');
  });

  it('holds the task until the agent attests to what the plan expects', async () => {
    await setup({ expects: ['migration runs up and down'] });
    await commit('src/db/users.sql', 'CREATE TABLE users;\n', 'add users');
    await doneCmd('auth-schema', {});
    expect(err.join('\n')).toContain('needs an attestation');
    expect((await loadTasks(root))[0].state).toBe('active');
  });

  it('lands in review once the evidence holds', async () => {
    await setup({ expects: ['migration runs up and down'] });
    await commit('src/db/users.sql', 'CREATE TABLE users;\n', 'add users');
    await doneCmd('auth-schema', { attest: true });
    const [t] = await loadTasks(root);
    expect(t.state).toBe('review');
    expect(t.finishedSha).toBeTruthy();
    expect(t.contributors?.every((c) => c.to)).toBe(true);      // the stretch is closed
    expect(out.join('\n')).toContain('not verified by baton');  // attestation labelled honestly
  });

  it('goes straight to done when the plan opted out of review', async () => {
    await setup({ requireReview: false });
    await commit('src/db/users.sql', 'CREATE TABLE users;\n', 'add users');
    await doneCmd('auth-schema', {});
    expect((await loadTasks(root))[0].state).toBe('done');
  });

  /** Recorded, not refused — refusing would teach agents to declare `**`. */
  it('records out-of-scope files without blocking', async () => {
    await setup();
    await commit('src/db/users.sql', 'CREATE TABLE users;\n', 'add users');
    await commit('src/auth/b.ts', 'y\n// tweak\n', 'tweak auth');
    await doneCmd('auth-schema', {});
    const [t] = await loadTasks(root);
    expect(t.state).toBe('review');
    expect(t.outOfScope).toEqual(['src/auth/b.ts']);
  });

  /** --force is about the attestation, never about the facts. */
  it('does not let --force buy past a real refusal', async () => {
    await setup();
    await doneCmd('auth-schema', { force: true });
    expect(process.exitCode).toBe(1);
    expect((await loadTasks(root))[0].state).toBe('active');
  });

  it('refuses to close a task held by someone else', async () => {
    await setup();
    await commit('src/db/users.sql', 'x\n', 'work');
    const tasks = await loadTasks(root);
    await saveTasks(root, tasks.map((t) => ({ ...t, claimedBy: { agent: 'cursor', sessionSlug: 's9', at: t.createdAt } })));
    await doneCmd('auth-schema', { attest: true });
    expect(err.join('\n')).toContain('held by cursor');
    expect((await loadTasks(root))[0].state).toBe('active');
  });

  it('refuses a second done once it is in review', async () => {
    await setup();
    await commit('src/db/users.sql', 'x\n', 'work');
    await doneCmd('auth-schema', {});
    process.exitCode = undefined;
    await doneCmd('auth-schema', {});
    expect(err.join('\n')).toContain('in review');
    expect(process.exitCode).toBe(1);
  });

  it('flags conflict markers left in a committed file', async () => {
    await setup();
    await commit('src/db/users.sql', '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> other\n', 'bad merge');
    await doneCmd('auth-schema', {});
    expect(out.join('\n')).toContain('conflict markers');
    expect((await loadTasks(root))[0].state).toBe('active');
  });
});
