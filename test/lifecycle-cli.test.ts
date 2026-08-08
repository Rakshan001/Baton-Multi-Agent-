// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { loadTasks, saveTasks, type Task } from '../src/store.js';
import { claimTask, ClaimRefused } from '../src/commands/claim.js';
import { takeCmd } from '../src/commands/take.js';
import { blockCmd, pauseCmd } from '../src/commands/pause.js';
import { newestMtimeIn } from '../src/liveness.js';

function row(over: Partial<Task> & { slug: string }): Task {
  return {
    task: `do ${over.slug}`, branch: `baton/${over.slug}`, worktreePath: '',
    baseBranch: 'HEAD', baseCommit: null, createdAt: '2026-08-05T10:00:00.000Z',
    phase: 1, dependsOn: [], assignee: null, scope: [], state: 'queued',
    ...over,
  };
}

describe('claimTask — lazy materialization', () => {
  let root: string;
  const claude = { agent: 'claude', sessionSlug: 's1' };
  const cursor = { agent: 'cursor', sessionSlug: 's2' };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-claim-'));
    await git(['init', '-q', '-b', 'main'], root);
    await git(['config', 'user.email', 't@t.dev'], root);
    await git(['config', 'user.name', 't'], root);
    await writeFile(join(root, 'a.ts'), 'x\n', 'utf-8');
    await git(['add', '.'], root);
    await git(['commit', '-qm', 'init'], root);
    await mkdir(join(root, '.baton'), { recursive: true });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('builds the branch and worktree at claim time, not at plan time', async () => {
    await saveTasks(root, [row({ slug: 'a', worktreePath: join(root, '.baton', 'wt', 'a') })]);
    const r = await claimTask(root, 'a', claude);
    expect(r.materialized).toBe(true);
    expect(r.task.state).toBe('active');
    expect(r.task.baseCommit).toBeTruthy();
    await expect(stat(r.task.worktreePath)).resolves.toBeTruthy();
    const branches = await git(['branch', '--list', 'baton/a'], root);
    expect(branches).toContain('baton/a');
  });

  /** The compare-and-swap, through the real lock and the real file. */
  it('lets exactly one of several concurrent claimers win', async () => {
    await saveTasks(root, [row({ slug: 'a', worktreePath: join(root, '.baton', 'wt', 'a') })]);
    const who = (n: number) => ({ agent: `agent${n}`, sessionSlug: `s${n}` });
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => claimTask(root, 'a', who(n))));
    const won = results.filter((r) => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    const tasks = await loadTasks(root);
    expect(tasks[0].state).toBe('active');
    expect(tasks[0].contributors).toHaveLength(1);
  });

  /**
   * A task stuck `claimed` with no worktree is worse than one never claimed:
   * invisible to `next`, useless to its holder, and holding its phase.
   */
  it('rolls the claim back when the worktree cannot be created', async () => {
    // A path under a FILE cannot be created as a directory — git will refuse.
    await writeFile(join(root, 'blocker'), 'not a dir\n', 'utf-8');
    await saveTasks(root, [row({ slug: 'a', worktreePath: join(root, 'blocker', 'wt') })]);

    await expect(claimTask(root, 'a', claude)).rejects.toThrow(ClaimRefused);
    const [t] = await loadTasks(root);
    expect(t.state).toBe('queued');
    expect(t.claimedBy).toBeUndefined();
    expect(t.contributors).toBeUndefined();
  });

  it('never reuses a branch it did not create', async () => {
    await git(['branch', 'baton/a'], root);            // someone else's branch, same name
    await saveTasks(root, [row({ slug: 'a', worktreePath: join(root, '.baton', 'wt', 'a') })]);
    const r = await claimTask(root, 'a', claude);
    expect(r.task.branch).toBe('baton/a-2');
  });

  it('re-activates an existing worktree instead of building a second one', async () => {
    await saveTasks(root, [row({ slug: 'a', worktreePath: join(root, '.baton', 'wt', 'a') })]);
    const first = await claimTask(root, 'a', claude);
    const tasks = await loadTasks(root);
    await saveTasks(root, tasks.map((t) => ({ ...t, state: 'queued' as const, claimedBy: undefined })));

    const second = await claimTask(root, 'a', cursor);
    expect(second.materialized).toBe(false);
    expect(second.task.worktreePath).toBe(first.task.worktreePath);
    expect(second.task.baseCommit).toBe(first.task.baseCommit);
  });
});

describe('take / pause / block through the CLI', () => {
  let root: string;
  let out: string[];
  let err: string[];
  let cwd: string;
  const env = { ...process.env };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-take-'));
    await git(['init', '-q', '-b', 'main'], root);
    await git(['config', 'user.email', 't@t.dev'], root);
    await git(['config', 'user.name', 't'], root);
    await writeFile(join(root, 'a.ts'), 'x\n', 'utf-8');
    await git(['add', '.'], root);
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

  const queued = (over: Partial<Task> & { slug: string }) =>
    row({ ...over, worktreePath: join(root, '.baton', 'wt', over.slug) });

  it('with no slug, claims the next eligible task', async () => {
    await saveTasks(root, [queued({ slug: 'first' }), queued({ slug: 'second', phase: 2 })]);
    await takeCmd(undefined);
    expect(out.join('\n')).toContain('✓ claimed first');
    expect((await loadTasks(root))[0].state).toBe('active');
  });

  it('refuses a task behind the barrier', async () => {
    await saveTasks(root, [queued({ slug: 'first' }), queued({ slug: 'later', phase: 2 })]);
    await takeCmd('later');
    expect(err.join('\n')).toContain('not startable yet');
    expect(process.exitCode).toBe(1);
  });

  /**
   * A loser in a claim race used to fall through to the handoff-brief path and
   * report "no HANDOFF.md" — which reads as "nothing here" when the truth is
   * "occupied by someone else". Found by racing six real processes.
   */
  it('says who holds a task rather than falling through to the brief path', async () => {
    await saveTasks(root, [queued({
      slug: 'held', state: 'active', baseCommit: 'abc',
      claimedBy: { agent: 'cursor', sessionSlug: 's-other', at: new Date().toISOString() },
    })]);
    await takeCmd('held');
    const text = err.join('\n');
    expect(text).toContain('held by cursor');
    expect(text).toContain('--resume');
    expect(text).not.toContain('HANDOFF');
    expect(process.exitCode).toBe(1);
  });

  it('leaves pre-pipeline tasks to the brief path untouched', async () => {
    // No `state` field at all — a plain `baton new` row.
    const legacy = { ...queued({ slug: 'legacy' }), state: undefined, baseCommit: 'abc' };
    await saveTasks(root, [legacy as Task]);
    await takeCmd('legacy');
    expect(err.join('\n')).toContain('HANDOFF');     // the original behavior
  });

  it('refuses to adopt a task that is not stalled', async () => {
    await saveTasks(root, [queued({
      slug: 'busy', state: 'active', baseCommit: 'abc',
      claimedBy: { agent: 'cursor', sessionSlug: 's-other', at: new Date().toISOString() },
    })]);
    await takeCmd('busy', { resume: true });
    expect(err.join('\n')).toContain('not stalled');
    expect(process.exitCode).toBe(1);
  });

  it('adopts a stalled task and records both stretches', async () => {
    const longAgo = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    await saveTasks(root, [queued({
      slug: 'stalled', state: 'active', baseCommit: 'abc',
      worktreePath: join(root, 'nonexistent'),          // no mtime signal
      claimedBy: { agent: 'cursor', sessionSlug: 's-other', at: longAgo },
      contributors: [{ agent: 'cursor', from: longAgo }],
    })]);
    await takeCmd('stalled', { resume: true });
    expect(out.join('\n')).toContain('adopted stalled from cursor');
    const [t] = await loadTasks(root);
    expect(t.claimedBy?.agent).toBe('claude');
    expect(t.contributors).toHaveLength(2);
    expect(t.contributors?.[0].to).toBeTruthy();
  });

  /** An interruption must never be recorded as a completion. */
  it('pause returns the task to the queue without marking it done', async () => {
    await saveTasks(root, [queued({
      slug: 'a', state: 'active', baseCommit: 'abc',
      claimedBy: { agent: 'claude', sessionSlug: 's1', at: new Date().toISOString() },
    })]);
    await pauseCmd('a', { reason: 'hit the session limit' });
    const [t] = await loadTasks(root);
    expect(t.state).toBe('queued');
    expect(t.baseCommit).toBe('abc');
    expect(t.stoppedReason).toBe('hit the session limit');
    expect(out.join('\n')).toContain('queued, not done');
  });

  it('block keeps the task owned so the next agent does not hit the same wall', async () => {
    await saveTasks(root, [queued({
      slug: 'a', state: 'active',
      claimedBy: { agent: 'claude', sessionSlug: 's1', at: new Date().toISOString() },
    })]);
    await blockCmd('a', 'needs staging DB credentials');
    const [t] = await loadTasks(root);
    expect(t.state).toBe('blocked');
    expect(t.claimedBy?.agent).toBe('claude');
    expect(t.stoppedReason).toBe('needs staging DB credentials');
  });
});

describe('newestMtimeIn', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'baton-mtime-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('finds the newest file under a tree', async () => {
    await mkdir(join(dir, 'src', 'deep'), { recursive: true });
    await writeFile(join(dir, 'src', 'deep', 'x.ts'), 'x\n', 'utf-8');
    expect(newestMtimeIn(dir)).toBeGreaterThan(Date.now() - 60_000);
  });

  /** An agent's build output says nothing about the agent, and walking it costs
   *  more than the answer is worth. */
  it('skips .git and node_modules', async () => {
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'pkg', 'index.js'), 'x\n', 'utf-8');
    expect(newestMtimeIn(dir)).toBe(0);
  });

  it('returns 0 for a directory that is not there', () => {
    expect(newestMtimeIn(join(dir, 'gone'))).toBe(0);
  });
});
