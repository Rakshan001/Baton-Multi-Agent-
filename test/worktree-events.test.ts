// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Lifecycle transitions are supposed to be LIVE.
 *
 * Before this suite, `claim`, `activate`, `pause`, `block` and `takeover`
 * published nothing at all — a dashboard learned about them on its next poll,
 * which is the difference between "someone just handed that task back" and
 * "that task looks the same as it did five seconds ago".
 *
 * Each verb is exercised through the path an agent actually takes, not through
 * `lifecycle.ts` directly: `claimTask` (src/commands/claim.ts) is the ONE claim
 * path shared by the CLI, MCP `take_task` and the dispatcher, so proving it
 * publishes proves all three at once.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from '../src/util/exec.js';
import { saveTasks, type Task } from '../src/store.js';
import { bus, type BatonEvent } from '../src/events.js';
import { claimTask } from '../src/commands/claim.js';
import { pauseCmd, blockCmd } from '../src/commands/pause.js';
import { lifecycleEventsBetween } from '../src/lifecycle.js';
import { registerPipelineTools, type RegisterTool, type ToolArgs } from '../src/mcp-pipeline.js';
import { STALL_GRACE_MS } from '../src/pipeline.js';
import { WorktreeWatcher } from '../src/watch.js';

const REPO = join(fileURLToPath(new URL('..', import.meta.url)));

describe('lifecycle events', () => {
  let root: string;
  let cwd: string;
  const env = { ...process.env };
  let seen: BatonEvent[] = [];
  let unsub: () => void;
  const tools = new Map<string, (a: ToolArgs) => Promise<{ content: { type: 'text'; text: string }[] }>>();

  const typesOf = (): string[] => seen.map((e) => e.type);
  const find = <T extends BatonEvent['type']>(type: T): Extract<BatonEvent, { type: T }> | undefined =>
    seen.find((e) => e.type === type) as Extract<BatonEvent, { type: T }> | undefined;

  const row = (over: Partial<Task> = {}): Task => ({
    slug: 'auth-api', task: 'the api', branch: 'baton/auth-api',
    worktreePath: join(root, '.baton', 'wt', 'auth-api'), baseBranch: 'HEAD', baseCommit: null,
    createdAt: '2026-08-05T10:00:00.000Z', phase: 1, dependsOn: [], assignee: null,
    scope: ['src/**'], expects: [], state: 'queued', requireReview: true, ...over,
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-wtev-'));
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
    // The CLI resolves its root from cwd; pin it so a temp dir under a symlinked
    // /tmp (macOS) cannot resolve to something else mid-test.
    process.env.BATON_ROOT = root;
    process.env.BATON_AGENT = 'claude';
    process.env.BATON_SLUG = 's1';

    seen = [];
    unsub = bus.onAny((e) => { seen.push(e.event); });

    tools.clear();
    const reg: RegisterTool = (name, _config, cb) => { tools.set(name, cb); };
    registerPipelineTools(reg, root);
  });

  afterEach(async () => {
    unsub();
    process.chdir(cwd);
    process.env = { ...env };
    await rm(root, { recursive: true, force: true });
  });

  it('publishes task.claimed and task.activated when a task is taken', async () => {
    await saveTasks(root, [row()]);
    await claimTask(root, 'auth-api', { agent: 'claude', sessionSlug: 's1' });

    expect(typesOf()).toEqual(expect.arrayContaining(['task.claimed', 'task.activated']));
    expect(find('task.claimed')).toMatchObject({ slug: 'auth-api', agent: 'claude' });
    expect(find('task.activated')).toMatchObject({ slug: 'auth-api', agent: 'claude' });
    // Claim before activate, never the other way round: a client that saw them
    // reversed would render an active task with no holder.
    expect(typesOf().indexOf('task.claimed')).toBeLessThan(typesOf().indexOf('task.activated'));
  });

  it('publishes task.takenover, not task.claimed, when stalled work is adopted', async () => {
    const stale = new Date(Date.now() - STALL_GRACE_MS * 4).toISOString();
    await saveTasks(root, [row({
      state: 'active',
      baseCommit: 'deadbeef',
      // A path that does not exist: liveness then has nothing newer than the
      // claim stamp, which is exactly the "holder went away" shape.
      worktreePath: join(root, '.baton', 'wt', 'gone'),
      claimedBy: { agent: 'cursor', sessionSlug: 's-cursor', at: stale },
      contributors: [{ agent: 'cursor', from: stale }],
    })]);

    await claimTask(root, 'auth-api', { agent: 'claude', sessionSlug: 's1' }, { resume: true });

    expect(typesOf()).toContain('task.takenover');
    expect(typesOf()).not.toContain('task.claimed');
    expect(find('task.takenover')).toMatchObject({ slug: 'auth-api', agent: 'claude', from: 'cursor' });
  });

  it('publishes task.paused when the CLI hands a task back', async () => {
    await saveTasks(root, [row({
      state: 'active', baseCommit: 'deadbeef',
      claimedBy: { agent: 'claude', sessionSlug: 's1', at: '2026-08-05T10:00:00.000Z' },
    })]);

    await pauseCmd('auth-api', { reason: 'out of context' });

    expect(find('task.paused')).toMatchObject({ slug: 'auth-api', agent: 'claude', reason: 'out of context' });
  });

  it('publishes task.blocked when the CLI blocks a task', async () => {
    await saveTasks(root, [row({
      state: 'active', baseCommit: 'deadbeef',
      claimedBy: { agent: 'claude', sessionSlug: 's1', at: '2026-08-05T10:00:00.000Z' },
    })]);

    await blockCmd('auth-api', 'waiting on a migration');

    expect(find('task.blocked')).toMatchObject({ slug: 'auth-api', agent: 'claude', reason: 'waiting on a migration' });
  });

  it('publishes task.blocked when MCP report_blocked is called', async () => {
    await saveTasks(root, [row({
      state: 'active', baseCommit: 'deadbeef',
      claimedBy: { agent: 'claude', sessionSlug: 's1', at: '2026-08-05T10:00:00.000Z' },
    })]);

    const fn = tools.get('report_blocked')!;
    await fn({ slug: 'auth-api', reason: 'the upstream API is down' });

    expect(find('task.blocked')).toMatchObject({ slug: 'auth-api', reason: 'the upstream API is down' });
  });

  it('publishes nothing when the transition is refused', async () => {
    await saveTasks(root, [row({
      state: 'active', baseCommit: 'deadbeef',
      claimedBy: { agent: 'cursor', sessionSlug: 's-cursor', at: '2026-08-05T10:00:00.000Z' },
    })]);

    await pauseCmd('auth-api', { reason: 'not mine to pause' });

    expect(typesOf()).not.toContain('task.paused');
  });
});

/**
 * The cross-process half. A CLI `baton pause` runs in its own process, so the
 * publish above reaches nobody in the daemon — the only thing the daemon sees
 * is `tasks.json` changing (src/watch.ts:105-107). This derives the same events
 * from two snapshots of that file, so the observer needs no second IPC channel.
 */
describe('lifecycleEventsBetween', () => {
  const T0 = '2026-08-05T10:00:00.000Z';
  const base = (over: Partial<Task> & { slug: string }): Task => ({
    task: over.slug, branch: `baton/${over.slug}`, worktreePath: `/wt/${over.slug}`,
    baseBranch: 'main', baseCommit: null, createdAt: T0,
    phase: 1, dependsOn: [], assignee: null, scope: [], state: 'queued',
    ...over,
  });
  const held = (agent: string) => ({ agent, sessionSlug: `s-${agent}`, at: T0 });

  it('derives a claim', () => {
    const before = [base({ slug: 'a' })];
    const after = [base({ slug: 'a', state: 'claimed', claimedBy: held('claude') })];
    expect(lifecycleEventsBetween(before, after)).toEqual([
      { type: 'task.claimed', slug: 'a', agent: 'claude', by: 'claude' },
    ]);
  });

  it('derives an activation', () => {
    const before = [base({ slug: 'a', state: 'claimed', claimedBy: held('claude') })];
    const after = [base({ slug: 'a', state: 'active', claimedBy: held('claude') })];
    expect(lifecycleEventsBetween(before, after)).toEqual([
      { type: 'task.activated', slug: 'a', agent: 'claude' },
    ]);
  });

  it('derives a pause with its reason', () => {
    const before = [base({ slug: 'a', state: 'active', claimedBy: held('claude') })];
    const after = [base({ slug: 'a', state: 'queued', stoppedReason: 'out of time' })];
    expect(lifecycleEventsBetween(before, after)).toEqual([
      { type: 'task.paused', slug: 'a', agent: 'claude', reason: 'out of time' },
    ]);
  });

  it('derives a block', () => {
    const before = [base({ slug: 'a', state: 'active', claimedBy: held('claude') })];
    const after = [base({ slug: 'a', state: 'blocked', stoppedReason: 'needs a key', claimedBy: held('claude') })];
    expect(lifecycleEventsBetween(before, after)).toEqual([
      { type: 'task.blocked', slug: 'a', agent: 'claude', reason: 'needs a key' },
    ]);
  });

  it('derives a takeover — same state, different holder', () => {
    const before = [base({ slug: 'a', state: 'active', claimedBy: held('cursor') })];
    const after = [base({ slug: 'a', state: 'active', claimedBy: held('claude') })];
    expect(lifecycleEventsBetween(before, after)).toEqual([
      { type: 'task.takenover', slug: 'a', agent: 'claude', from: 'cursor' },
    ]);
  });

  it('says nothing about an unchanged list', () => {
    const tasks = [base({ slug: 'a', state: 'active', claimedBy: held('claude') }), base({ slug: 'b' })];
    expect(lifecycleEventsBetween(tasks, tasks)).toEqual([]);
  });

  it('says nothing about a task that appeared or vanished — task.created/removed own those', () => {
    expect(lifecycleEventsBetween([], [base({ slug: 'a', state: 'claimed', claimedBy: held('claude') })])).toEqual([]);
    expect(lifecycleEventsBetween([base({ slug: 'a' })], [])).toEqual([]);
  });
});

/**
 * The browser drops any frame whose type is not on the whitelist, so a new
 * event type that stops there is indistinguishable from one that was never
 * published. Asserted against the source because `web/` is a separate
 * workspace with its own tsconfig and cannot be imported from here.
 */
describe('the client SSE whitelist', () => {
  it('accepts every lifecycle type, and task.cancelled', async () => {
    const src = await readFile(join(REPO, 'web/src/hooks/useEvents.ts'), 'utf-8');
    for (const t of ['task.claimed', 'task.activated', 'task.paused', 'task.blocked', 'task.takenover', 'task.cancelled', 'task.unclaimed']) {
      expect(src, `useEvents.ts must whitelist ${t}`).toContain(`"${t}"`);
    }
  });
});

/**
 * The acceptance criterion the call-site publishes cannot meet on their own.
 *
 * `bus.publish` inside src/commands/pause.ts runs in the CLI's process. The
 * daemon holding the dashboard's SSE stream is a DIFFERENT process, so that
 * publish reaches nobody there and the dashboard waits for its 5-second poll.
 * The watcher closes the gap by diffing tasks.json, the one thing both
 * processes share — the same trick the file already uses for `task.created`.
 *
 * So this test never calls a lifecycle function. It writes the store the way
 * another process would, and asserts THIS process hears about it.
 */
describe('a lifecycle change made by another process', () => {
  let root: string;
  let seen: BatonEvent[];
  let unsub: () => void;
  let watcher: WorktreeWatcher;

  const task = (over: Partial<Task> = {}): Task => ({
    slug: 'auth-api', task: 'the api', branch: 'baton/auth-api',
    worktreePath: join(root, '.baton', 'wt', 'auth-api'), baseBranch: 'HEAD', baseCommit: null,
    createdAt: '2026-08-05T10:00:00.000Z', phase: 1, dependsOn: [], assignee: null,
    scope: ['src/**'], expects: [], state: 'queued', requireReview: true, ...over,
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-wtxproc-'));
    await mkdir(join(root, '.baton'), { recursive: true });
    await saveTasks(root, [task({ state: 'active', claimedBy: { agent: 'claude', session: 's1', at: new Date().toISOString() } })]);
    watcher = new WorktreeWatcher(root);
    await watcher.start(); // first resync takes the baseline
    seen = [];
    unsub = bus.onAny((e) => { seen.push(e.event); });
  });

  afterEach(async () => {
    unsub?.();
    await watcher.stop();
    await rm(root, { recursive: true, force: true });
  });

  it('reaches a listener in the daemon process, without anyone publishing to it', async () => {
    // Exactly what `baton pause` leaves behind, written from outside.
    await saveTasks(root, [task({ state: 'queued', claimedBy: null, stoppedReason: 'out of context' })]);
    await watcher.resync();

    const paused = seen.find((e) => e.type === 'task.paused');
    expect(paused, `no task.paused in [${seen.map((e) => e.type).join(', ')}]`).toBeDefined();
    expect((paused as { slug: string }).slug).toBe('auth-api');
  });

  it('says nothing when tasks.json is rewritten with no transition in it', async () => {
    // A resync fires on every write to the file, including ones that change
    // nothing a human would call a transition. Announcing those would train
    // everyone to ignore the stream.
    await saveTasks(root, [task({ state: 'active', claimedBy: { agent: 'claude', session: 's1', at: new Date().toISOString() } })]);
    await watcher.resync();
    expect(seen.filter((e) => e.type.startsWith('task.'))).toEqual([]);
  });

  it('does not replay the same transition on the next unrelated write', async () => {
    // The snapshot has to advance on every resync. If it only advanced when a
    // transition was found, the next write would diff against a stale list and
    // announce the pause a second time.
    await saveTasks(root, [task({ state: 'queued', claimedBy: null, stoppedReason: 'out of context' })]);
    await watcher.resync();
    seen = [];
    await saveTasks(root, [task({ state: 'queued', claimedBy: null, stoppedReason: 'out of context', phase: 2 })]);
    await watcher.resync();
    expect(seen.filter((e) => e.type === 'task.paused')).toEqual([]);
  });
});
