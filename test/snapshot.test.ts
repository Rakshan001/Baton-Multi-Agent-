import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import { git } from '../src/util/exec.js';
import { addTask } from '../src/store.js';
import { readBrief, setBriefStatus, handoffPath } from '../src/handoff/brief.js';
import { snapshotTask, snapshotDue, SNAPSHOT_DEBOUNCE_MS } from '../src/commands/snapshot.js';

/**
 * ISS-03 — a resumable HANDOFF.md must exist on disk BEFORE a session limit
 * cutoff, refreshed during the session, agent-agnostically (git ground truth),
 * without committing the agent's WIP or un-taking an active handoff.
 */
describe('snapshotDue — the debounce gate the hot edit path leans on', () => {
  let wt: string;
  beforeEach(async () => { wt = await mkdtemp(join(tmpdir(), 'baton-snapdue-')); });
  afterEach(async () => { await rm(wt, { recursive: true, force: true }); });

  it('is due when no brief exists yet', async () => {
    expect(await snapshotDue(wt)).toBe(true);
  });

  it('is NOT due right after a brief is written', async () => {
    await writeFile(handoffPath(wt), '---\nbaton: 1\n---\nx\n', 'utf-8');
    expect(await snapshotDue(wt)).toBe(false);
  });

  it('is due again once the brief ages past the window', async () => {
    await writeFile(handoffPath(wt), '---\nbaton: 1\n---\nx\n', 'utf-8');
    const old = (Date.now() - SNAPSHOT_DEBOUNCE_MS - 60_000) / 1000;
    await utimes(handoffPath(wt), old, old);
    expect(await snapshotDue(wt)).toBe(true);
  });
});

describe('snapshotTask — debounced, no-commit, status-preserving checkpoint', () => {
  let root: string;
  let wt: string;
  const gitWt = (args: string[]) => git(['-C', wt, ...args], root);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-snap-'));
    await git(['init', '-q', '-b', 'main'], root);
    await git(['config', 'user.email', 't@t.dev'], root);
    await git(['config', 'user.name', 't'], root);
    await writeFile(join(root, 'a.ts'), 'export const a = 1;\n', 'utf-8');
    await git(['add', '.'], root);
    await git(['commit', '-qm', 'init'], root);
    // A real baton task worktree.
    wt = join(root, '.baton', 'wt', 'add-hourly');
    await mkdir(join(root, '.baton', 'wt'), { recursive: true });
    await git(['worktree', 'add', '-q', '-b', 'baton/add-hourly', wt, 'main'], root);
    await addTask(root, {
      slug: 'add-hourly', task: 'add hourly buckets to the chart', branch: 'baton/add-hourly',
      baseBranch: 'main', worktreePath: wt, createdAt: new Date().toISOString(),
      agent: 'cursor', status: 'in-progress',
    } as never);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('writes a HANDOFF.md that captures uncommitted work, with NO commit made', async () => {
    // Dirty, uncommitted edit — the exact state a session limit would strand.
    await writeFile(join(wt, 'a.ts'), 'export const a = 2; // WIP\n', 'utf-8');

    const brief = await snapshotTask('add-hourly', { root, from: 'cursor' });
    expect(brief).not.toBeNull();
    expect(existsSync(handoffPath(wt))).toBe(true);
    expect(brief!.meta.from).toBe('cursor');
    // The objective is carried so the continuation head can resume it.
    expect(brief!.markdown).toContain('add hourly buckets to the chart');

    // Crucially: the snapshot must NOT have committed the WIP.
    const status = await gitWt(['status', '--porcelain']);
    expect(status.trim()).toContain('a.ts'); // still dirty — nothing was committed
    const log = await gitWt(['log', '--oneline']);
    expect(log).not.toContain('checkpoint');
  });

  it('phrases the brief guardrails as positive requirements, not a "Do NOT" list (ISS-07)', async () => {
    const brief = await snapshotTask('add-hourly', { root, force: true });
    expect(brief).not.toBeNull();
    expect(brief!.markdown).not.toContain('## Do NOT');
    expect(brief!.markdown).toContain('## Rules to hold');
    expect(brief!.markdown).toContain('Stay inside this worktree');
    expect(brief!.markdown).toContain('Execute the existing plan and flag blockers');
  });

  it('preserves an in-progress (taken) brief\'s status instead of resetting it to ready', async () => {
    await snapshotTask('add-hourly', { root, force: true });
    await setBriefStatus(wt, 'in-progress'); // human took it
    // Age the file so the debounce does not block the refresh.
    const old = (Date.now() - SNAPSHOT_DEBOUNCE_MS - 60_000) / 1000;
    await utimes(handoffPath(wt), old, old);

    const brief = await snapshotTask('add-hourly', { root });
    expect(brief).not.toBeNull();
    expect(brief!.meta.status).toBe('in-progress');
    const onDisk = await readBrief(wt);
    expect(onDisk!.meta.status).toBe('in-progress');
  });

  it('respects the debounce — a second immediate snapshot is a no-op (returns null)', async () => {
    const first = await snapshotTask('add-hourly', { root });
    expect(first).not.toBeNull();
    const second = await snapshotTask('add-hourly', { root }); // brief is fresh
    expect(second).toBeNull();
  });

  it('--force overrides the debounce', async () => {
    await snapshotTask('add-hourly', { root });
    const forced = await snapshotTask('add-hourly', { root, force: true });
    expect(forced).not.toBeNull();
  });

  it('never overwrites a brief the human marked done', async () => {
    await snapshotTask('add-hourly', { root, force: true });
    await setBriefStatus(wt, 'done');
    const after = await snapshotTask('add-hourly', { root, force: true });
    expect(after).toBeNull();
    expect((await readBrief(wt))!.meta.status).toBe('done');
  });

  it('returns null when there is no task worktree here', async () => {
    expect(await snapshotTask('nonexistent-slug', { root })).toBeNull();
  });

  it('writes a git-excluded Cursor auto-load rule alongside the brief (ISS-01 read side)', async () => {
    await writeFile(join(wt, 'a.ts'), 'export const a = 2; // wip\n', 'utf-8');
    await snapshotTask('add-hourly', { root, force: true });

    const rulePath = join(wt, '.cursor', 'rules', 'baton-continuation.mdc');
    expect(existsSync(rulePath)).toBe(true);
    const rule = await readFile(rulePath, 'utf-8');
    expect(rule).toContain('alwaysApply: true');
    expect(rule).toContain('add hourly buckets to the chart');

    // It must be excluded from git so a later checkpoint commit can't sweep it in.
    const status = await gitWt(['status', '--porcelain']);
    expect(status).not.toContain('.cursor/rules/baton-continuation.mdc');
  });
});
