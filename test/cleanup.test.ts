import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import {
  auditBranches, auditTmux, auditWorktrees, isReclaimableTmp,
  auditJunk, cleanJunk,
} from '../src/cleanup.js';
import { createTask } from '../src/commands/new.js';
import { createWorktree } from '../src/git.js';
import { loadTasks } from '../src/store.js';
import { repoPrefix } from '../src/util/tmux.js';
import type { Task } from '../src/store.js';
import type { WorktreeEntry } from '../src/git.js';

const task = (slug: string, root: string): Task => ({
  slug, task: slug, branch: `baton/${slug}`,
  worktreePath: join(root, '.baton', 'wt', slug),
  baseBranch: 'main', baseCommit: 'abc', createdAt: new Date(0).toISOString(),
});
const wt = (path: string, branch: string | null): WorktreeEntry => ({ path, branch, head: 'h' });

/* ---------------- pure detectors (no I/O) ---------------- */

describe('auditWorktrees', () => {
  const root = '/repo';
  it('flags a task whose worktree dir is gone', () => {
    const t = task('lost', root);
    const items = auditWorktrees(root, [t], [], () => false);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('orphan-worktree-task');
    expect(items[0].id).toBe('lost');
  });
  it('flags a baton worktree on disk with no task', () => {
    const path = join(root, '.baton', 'wt', 'ghost');
    const items = auditWorktrees(root, [], [wt(path, 'baton/ghost')], () => true);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('orphan-worktree-disk');
  });
  it('ignores a healthy matched pair and the main worktree', () => {
    const t = task('ok', root);
    const items = auditWorktrees(root, [t], [wt(t.worktreePath, t.branch), wt(root, 'main')], () => true);
    expect(items).toHaveLength(0);
  });
});

describe('auditBranches', () => {
  it('flags a baton branch with no task and no worktree', () => {
    const items = auditBranches(['baton/dead'], [], []);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('orphan-branch');
  });
  it('does not flag a branch backing a live worktree or task', () => {
    expect(auditBranches(['baton/live'], [], [wt('/x', 'baton/live')])).toHaveLength(0);
    expect(auditBranches(['baton/has-task'], [task('has-task', '/r')], [])).toHaveLength(0);
  });
});

describe('auditTmux', () => {
  const root = '/repo';
  it('flags a repo session whose slug has no task', () => {
    const name = `${repoPrefix(root)}ghost`;
    const items = auditTmux(root, [name], []);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('ghost');
  });
  it('ignores a session whose task exists and foreign sessions', () => {
    const name = `${repoPrefix(root)}alive`;
    expect(auditTmux(root, [name], [task('alive', root)])).toHaveLength(0);
    expect(auditTmux(root, ['some-other-tmux'], [])).toHaveLength(0);
  });
});

describe('isReclaimableTmp', () => {
  const now = 1_000_000_000;
  const old = now - 20 * 60_000;   // 20 min old
  const fresh = now - 60_000;      // 1 min old
  it('dead pid + old → reclaimable', () => {
    expect(isReclaimableTmp('tasks.json.99999.tmp', old, now, () => false)).toBe(true);
    expect(isReclaimableTmp('.mem-foo.99999.tmp', old, now, () => false)).toBe(true);
  });
  it('live pid → never', () => {
    expect(isReclaimableTmp('tasks.json.123.tmp', old, now, () => true)).toBe(false);
  });
  it('dead pid but recent → not yet', () => {
    expect(isReclaimableTmp('tasks.json.99999.tmp', fresh, now, () => false)).toBe(false);
  });
  it('unparseable pid → age-only with a longer threshold', () => {
    const veryOld = now - 120 * 60_000;
    expect(isReclaimableTmp('weird.tmp', veryOld, now, () => false)).toBe(true);
    expect(isReclaimableTmp('weird.tmp', old, now, () => false)).toBe(false); // 20min < 60min
  });
  it('non-.tmp → never', () => {
    expect(isReclaimableTmp('tasks.json', old, now, () => false)).toBe(false);
  });
});

/* ---------------- integration (real temp git repo) ---------------- */

describe('cleanup against a real repo', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-clean-'));
    await execa('git', ['init', '-q'], { cwd: root });
    await execa('git', ['config', 'user.email', 't@t.t'], { cwd: root });
    await execa('git', ['config', 'user.name', 'T'], { cwd: root });
    await execa('git', ['commit', '--allow-empty', '-qm', 'init'], { cwd: root });
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it('reports + reclaims a task whose worktree was deleted', async () => {
    const t = await createTask('orphan me', root);
    await rm(t.worktreePath, { recursive: true, force: true }); // simulate manual delete
    const report = await auditJunk(root);
    const orphan = report.items.find((i) => i.kind === 'orphan-worktree-task' && i.id === t.slug);
    expect(orphan).toBeDefined();

    const dry = await cleanJunk(root, report, { apply: false });
    expect(dry.applied).toBe(false);
    expect((await loadTasks(root)).some((x) => x.slug === t.slug)).toBe(true); // untouched

    const done = await cleanJunk(root, await auditJunk(root), { apply: true });
    expect(done.removed.some((i) => i.id === t.slug)).toBe(true);
    expect((await loadTasks(root)).some((x) => x.slug === t.slug)).toBe(false);
  });

  it('skips a dirty orphan worktree unless forced', async () => {
    // git canonicalizes the path (/var → /private/var on macOS); match by id.
    const path = join(root, '.baton', 'wt', 'dirtyghost');
    await createWorktree(path, 'baton/dirtyghost', 'HEAD', root); // no task entry
    await writeFile(join(path, 'scratch.txt'), 'uncommitted'); // untracked → dirty

    const report = await auditJunk(root);
    const item = report.items.find((i) => i.kind === 'orphan-worktree-disk' && i.id === 'dirtyghost');
    expect(item).toBeDefined();
    expect(item!.blocked).toBe('dirty');

    const skip = await cleanJunk(root, report, { apply: true, force: false });
    expect(skip.skipped.some((s) => s.item.id === 'dirtyghost')).toBe(true);
    expect(existsSync(path)).toBe(true);

    const forced = await cleanJunk(root, await auditJunk(root), { apply: true, force: true });
    expect(forced.removed.some((i) => i.id === 'dirtyghost')).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('reclaims a dead-pid temp file but never a live-pid one', async () => {
    const dir = join(root, '.baton');
    await mkdir(dir, { recursive: true });
    const dead = join(dir, 'tasks.json.99999.tmp');
    const live = join(dir, `tasks.json.${process.pid}.tmp`);
    await writeFile(dead, 'x'); await writeFile(live, 'x');
    const oldTime = new Date(Date.now() - 30 * 60_000);
    await utimes(dead, oldTime, oldTime);
    await utimes(live, oldTime, oldTime);

    const report = await auditJunk(root);
    expect(report.items.some((i) => i.path === dead)).toBe(true);
    expect(report.items.some((i) => i.path === live)).toBe(false);

    await cleanJunk(root, report, { apply: true });
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
    await rm(live, { force: true });
  });
});
