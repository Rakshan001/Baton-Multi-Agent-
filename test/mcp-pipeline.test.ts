// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { loadTasks, saveTasks, type Task } from '../src/store.js';
import { groundMovedNotice, registerPipelineTools, type RegisterTool, type ToolArgs } from '../src/mcp-pipeline.js';
import { checkpointFlag, type DiffStamp } from '../src/handoff/progress-ledger.js';

/**
 * The four pipeline tools, exercised the way an agent reaches them: through the
 * registrar, against a real repo, with real claims and a real evidence gate.
 */
describe('the pipeline MCP tools', () => {
  let root: string;
  let cwd: string;
  const env = { ...process.env };
  const tools = new Map<string, (a: ToolArgs) => Promise<{ content: { type: 'text'; text: string }[] }>>();

  /** Call a tool and parse its JSON answer. */
  const call = async (name: string, args: ToolArgs = {}): Promise<Record<string, never>> => {
    const fn = tools.get(name);
    if (!fn) throw new Error(`no tool '${name}'`);
    return JSON.parse((await fn(args)).content[0]!.text) as Record<string, never>;
  };

  const become = (agent: string): void => { process.env.BATON_AGENT = agent; };

  const row = (over: Partial<Task> = {}): Task => ({
    slug: 'auth-api', task: 'the api', branch: 'baton/auth-api',
    worktreePath: join(root, '.baton', 'wt', 'auth-api'), baseBranch: 'HEAD', baseCommit: null,
    createdAt: '2026-08-05T10:00:00.000Z', phase: 1, dependsOn: [], assignee: null,
    scope: ['src/**'], expects: [], state: 'queued', requireReview: true, ...over,
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-mcpp-'));
    await git(['init', '-q', '-b', 'main'], root);
    await git(['config', 'user.email', 't@t.dev'], root);
    await git(['config', 'user.name', 't'], root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'x\n', 'utf-8');
    await git(['add', '-A'], root);
    await git(['commit', '-qm', 'init'], root);
    await mkdir(join(root, '.baton'), { recursive: true });
    cwd = process.cwd();
    process.chdir(root);
    become('claude');
    process.env.BATON_SLUG = 's1';

    tools.clear();
    const reg: RegisterTool = (name, _config, cb) => { tools.set(name, cb); };
    registerPipelineTools(reg, root);
  });
  afterEach(async () => {
    process.chdir(cwd);
    process.env = { ...env };
    await rm(root, { recursive: true, force: true });
  });

  it('registers exactly the four tools the spec names', () => {
    expect([...tools.keys()].sort()).toEqual(['complete_task', 'my_tasks', 'report_blocked', 'take_task']);
  });

  it('answers "do you have a pending task?" with something startable', async () => {
    await saveTasks(root, [row()]);
    const r = await call('my_tasks');
    expect((r.startable as unknown as Task[]).map((t) => t.slug)).toEqual(['auth-api']);
    expect(r.holding).toEqual([]);
  });

  /** The contract, not the bookkeeping: what to build and what counts as done. */
  it('serves the task contract, not just its name', async () => {
    await saveTasks(root, [row({ expects: ['vitest passes'], principles: ['no new deps'] })]);
    const [t] = (await call('my_tasks')).startable as unknown as Record<string, unknown>[];
    expect(t!.scope).toEqual(['src/**']);
    expect(t!.expects).toEqual(['vitest passes']);
    expect(t!.principles).toEqual(['no new deps']);
  });

  it('claims a task and points at the worktree to work in', async () => {
    await saveTasks(root, [row()]);
    const r = await call('take_task', {});
    expect((r.claimed as unknown as Task).slug).toBe('auth-api');
    expect(String(r.worktree)).toContain('.baton/wt/auth-api');
    expect(String(r.rule)).toContain('ONLY');
    expect((await loadTasks(root))[0]!.state).toBe('active');
  });

  it('refuses a task another agent holds, and says who', async () => {
    await saveTasks(root, [row()]);
    await call('take_task', {});
    become('cursor');
    process.env.BATON_SLUG = 's2';
    const r = await call('take_task', { slug: 'auth-api' });
    expect(r.claimed).toBeNull();
    expect(String(r.refused)).toContain('claude');
  });

  it('explains an empty answer instead of going quiet', async () => {
    await saveTasks(root, [row({ phase: 2, dependsOn: ['setup'] }), row({ slug: 'setup', phase: 1 })]);
    become('cursor');
    const r = await call('take_task', { slug: 'auth-api' });
    expect(r.claimed).toBeNull();
    expect(JSON.stringify(r)).toMatch(/not startable|phase|depends/i);
  });

  it('runs the evidence gate — no commits is refused, and the task stays yours', async () => {
    await saveTasks(root, [row()]);
    await call('take_task', {});
    const r = await call('complete_task', {});
    expect(r.completed).toBe(false);
    expect(JSON.stringify(r.checks)).toContain('no commits');
    expect((await loadTasks(root))[0]!.state).toBe('active');
  });

  it('lands a real completion in review', async () => {
    await saveTasks(root, [row()]);
    const claim = await call('take_task', {});
    const wt = String(claim.worktree);
    await writeFile(join(wt, 'src', 'a.ts'), 'x\nwork\n', 'utf-8');
    await git(['add', '-A'], wt);
    await git(['commit', '-qm', 'work'], wt);

    const r = await call('complete_task', {});
    expect(r.completed).toBe(true);
    expect(r.state).toBe('review');
    expect((await loadTasks(root))[0]!.state).toBe('review');
  });

  /** An agent must not be able to waive its own attestation. */
  it('offers no force flag — expects is held until attested', async () => {
    await saveTasks(root, [row({ expects: ['migration runs both ways'] })]);
    const claim = await call('take_task', {});
    const wt = String(claim.worktree);
    await writeFile(join(wt, 'src', 'a.ts'), 'x\nwork\n', 'utf-8');
    await git(['add', '-A'], wt);
    await git(['commit', '-qm', 'work'], wt);

    const held = await call('complete_task', { force: true });   // ignored by design
    expect(held.completed).toBe(false);
    expect(String(held.refused)).toContain('attest');

    const done = await call('complete_task', { attest: true });
    expect(done.completed).toBe(true);
  });

  it('keeps a blocked task owned, and names the blocker', async () => {
    await saveTasks(root, [row()]);
    await call('take_task', {});
    const r = await call('report_blocked', { reason: 'the staging db credentials are missing' });
    expect(r.blocked).toBe(true);

    const [t] = await loadTasks(root);
    expect(t!.state).toBe('blocked');
    expect(t!.claimedBy?.agent).toBe('claude');            // still owned, not returned to the pool
    expect(t!.stoppedReason).toContain('credentials');
  });

  it('refuses a blocker with no reason', async () => {
    await saveTasks(root, [row()]);
    await call('take_task', {});
    const r = await call('report_blocked', { reason: '  ' });
    expect(r.blocked).toBe(false);
    expect((await loadTasks(root))[0]!.state).toBe('active');
  });

  /** Guessing which task is meant is the exact hallucination this design fights. */
  it('refuses to guess when the agent holds more than one task', async () => {
    await saveTasks(root, [row(), row({ slug: 'auth-ui', branch: 'baton/auth-ui', worktreePath: join(root, '.baton', 'wt', 'auth-ui') })]);
    await call('take_task', { slug: 'auth-api' });
    await call('take_task', { slug: 'auth-ui' });
    const r = await call('complete_task', {});
    expect(r.completed).toBe(false);
    expect(String(r.refused)).toContain('name the one you mean');
  });

  it('shows a rejected task with the reason to fix it', async () => {
    await saveTasks(root, [row({
      state: 'active',
      claimedBy: { agent: 'claude', sessionSlug: 's1', at: '2026-08-05T11:00:00.000Z' },
      contributors: [{ agent: 'claude', from: '2026-08-05T11:00:00.000Z', to: '2026-08-05T11:30:00.000Z' }],
      reviewedBy: { actor: 'cursor', at: '2026-08-05T11:40:00.000Z', verdict: 'reject', notes: 'no test for the empty case' },
    })]);
    const [h] = (await call('my_tasks')).holding as unknown as Record<string, unknown>[];
    expect(h!.sentBackBy).toBe('cursor');
    expect(h!.fix).toBe('no test for the empty case');
  });

  it('offers a review to an agent who did not write it, and not to one who did', async () => {
    await saveTasks(root, [row({
      state: 'review',
      claimedBy: { agent: 'claude', sessionSlug: 's1', at: '2026-08-05T11:00:00.000Z' },
      contributors: [{ agent: 'claude', from: '2026-08-05T11:00:00.000Z', to: '2026-08-05T11:30:00.000Z' }],
    })]);
    expect((await call('my_tasks')).awaitingYourReview).toEqual([]);   // claude wrote it
    become('cursor');
    const mine = (await call('my_tasks')).awaitingYourReview as unknown as Record<string, unknown>[];
    expect(mine).toHaveLength(1);
    expect(mine[0]!.writtenBy).toEqual(['claude']);
  });
});

/**
 * The ground moving under a working agent. An agent inside a worktree has no
 * reason to look at the board again, so this rides on whatever tool it calls
 * next — the soonest moment it can possibly hear.
 */
describe('the cancellation notice', () => {
  const at = '2026-08-05T11:00:00.000Z';
  const t = (over: Partial<Task> = {}): Task => ({
    slug: 'auth-api', task: 'the api', branch: 'baton/auth-api', worktreePath: '/w',
    baseBranch: 'main', baseCommit: 'aaa', createdAt: at, state: 'active',
    claimedBy: { agent: 'claude', sessionSlug: 'mine', at }, ...over,
  });

  it('says nothing while the task is still yours', () => {
    expect(groundMovedNotice(t(), 'auth-api', 'mine')).toBeNull();
  });

  it('stops an agent working on a cancelled task, and says who cancelled it', () => {
    const n = groundMovedNotice(t({ state: 'cancelled', cancelledBy: { actor: 'rakshan', at, reason: 'scope changed' } }), 'auth-api', 'mine');
    expect(n).toContain('STOP');
    expect(n).toContain('rakshan');
    expect(n).toContain('scope changed');
  });

  it('stops an agent whose task was deleted outright', () => {
    expect(groundMovedNotice(undefined, 'auth-api', 'mine')).toContain('no longer exists');
  });

  /** Two agents in one worktree overwrite each other — the displaced one is the
   *  only party that can stop, so it is the one that has to be told. */
  it('warns the displaced agent when its task was adopted', () => {
    const n = groundMovedNotice(t({ claimedBy: { agent: 'cursor', sessionSlug: 'theirs', at } }), 'auth-api', 'mine');
    expect(n).toContain('adopted by cursor');
    expect(n).toContain('--resume');
  });

  it('does not warn about a task in review or done — nobody is writing', () => {
    expect(groundMovedNotice(t({ state: 'review', claimedBy: { agent: 'cursor', sessionSlug: 'theirs', at } }), 'auth-api', 'mine')).toBeNull();
    expect(groundMovedNotice(t({ state: 'done', claimedBy: { agent: 'cursor', sessionSlug: 'theirs', at } }), 'auth-api', 'mine')).toBeNull();
  });
});

/** §6.2: a checkpoint claiming progress with zero changed files is flagged. */
describe('checkpoint diff-stamping', () => {
  const item = (content: string, status: string) => ({ content, status });
  const stamp = (over: Partial<DiffStamp> = {}): DiffStamp =>
    ({ filesChanged: 0, insertions: 0, deletions: 0, commits: 0, ...over });

  it('flags items ticked off with nothing behind them', () => {
    const f = checkpointFlag([item('a', 'in_progress')], [item('a', 'completed')], stamp());
    expect(f).toContain('1 item marked complete');
  });

  it('says nothing when the repository corroborates the claim', () => {
    expect(checkpointFlag([item('a', 'pending')], [item('a', 'completed')], stamp({ commits: 1 }))).toBeUndefined();
    expect(checkpointFlag([item('a', 'pending')], [item('a', 'completed')], stamp({ filesChanged: 3 }))).toBeUndefined();
  });

  /** Thinking, reading and failed experiments are honest checkpoints. */
  it('does not flag a checkpoint that claims nothing new', () => {
    expect(checkpointFlag([item('a', 'completed')], [item('a', 'completed')], stamp())).toBeUndefined();
    expect(checkpointFlag([], [item('a', 'in_progress')], stamp())).toBeUndefined();
  });

  it('has no opinion when the diff could not be read', () => {
    expect(checkpointFlag([item('a', 'pending')], [item('a', 'completed')], undefined)).toBeUndefined();
  });
});
