import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addTask,
  getTask,
  loadTasks,
  removeTask,
  resolveBatonRoot,
  slugify,
  tasksFile,
  type Task,
} from '../src/store.js';

function mkTask(slug: string): Task {
  return {
    slug,
    task: `do ${slug}`,
    branch: `baton/${slug}`,
    worktreePath: `/tmp/wt/${slug}`,
    baseBranch: 'main',
    baseCommit: 'abc1234',
    createdAt: new Date().toISOString(),
  };
}

describe('slugify', () => {
  it('kebab-cases free text', () => {
    expect(slugify('Fix the Mobile Navbar!')).toBe('fix-the-mobile-navbar');
  });
  it('falls back to "task" for empty input', () => {
    expect(slugify('!!!')).toBe('task');
  });
  it('disambiguates against taken slugs', () => {
    expect(slugify('fix', ['fix'])).toBe('fix-2');
    expect(slugify('fix', ['fix', 'fix-2'])).toBe('fix-3');
  });
  it('truncates long input', () => {
    expect(slugify('a'.repeat(100)).length).toBeLessThanOrEqual(40);
  });
});

describe('task store', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-store-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns [] when no store exists', async () => {
    expect(await loadTasks(root)).toEqual([]);
  });

  it('adds, gets, and removes tasks; persists JSON', async () => {
    await addTask(root, mkTask('alpha'));
    await addTask(root, mkTask('beta'));

    expect((await loadTasks(root)).map((t) => t.slug)).toEqual(['alpha', 'beta']);
    expect((await getTask(root, 'beta'))?.branch).toBe('baton/beta');

    const onDisk = JSON.parse(await readFile(tasksFile(root), 'utf-8'));
    expect(onDisk).toHaveLength(2);

    await removeTask(root, 'alpha');
    expect((await loadTasks(root)).map((t) => t.slug)).toEqual(['beta']);
  });

  it('survives a corrupt store file', async () => {
    await addTask(root, mkTask('x'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(tasksFile(root), 'not json', 'utf-8');
    expect(await loadTasks(root)).toEqual([]);
  });
});

describe('resolveBatonRoot ownership gate', () => {
  it.skipIf(process.platform === 'win32')('skips a world-writable .baton and keeps walking up', async () => {
    const { mkdtemp, mkdir, chmod } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const base = await mkdtemp(join(tmpdir(), 'baton-own-'));
    // legit root at base, planted world-writable .baton deeper down
    await mkdir(join(base, '.baton'), { recursive: true });
    await chmod(join(base, '.baton'), 0o755);
    const deep = join(base, 'sub', 'repo');
    await mkdir(join(deep, '.baton'), { recursive: true });
    await chmod(join(deep, '.baton'), 0o777); // world-writable → untrusted
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = await resolveBatonRoot(deep);
    expect(root).toBe(base);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it.skipIf(process.platform === 'win32')('accepts a normal user-owned 755 .baton', async () => {
    const { mkdtemp, mkdir, chmod } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const base = await mkdtemp(join(tmpdir(), 'baton-own2-'));
    await mkdir(join(base, '.baton'), { recursive: true });
    await chmod(join(base, '.baton'), 0o755);
    expect(await resolveBatonRoot(base)).toBe(base);
  });
});

describe('tasks.json cross-process lock', () => {
  it('breaks a stale lock and still writes', async () => {
    const { mkdtemp, mkdir, utimes } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'baton-lock-'));
    await mkdir(join(root, '.baton'), { recursive: true });
    // a lock dir left behind by a crashed process, 10s old
    const lock = join(root, '.baton', 'tasks.lock');
    await mkdir(lock);
    const old = (Date.now() - 10_000) / 1000;
    await utimes(lock, old, old);
    await addTask(root, {
      slug: 't1', task: 'T1', branch: 'baton/t1', worktreePath: join(root, 'wt'),
      baseBranch: 'main', baseCommit: null, createdAt: new Date().toISOString(),
    });
    expect((await loadTasks(root)).map((t) => t.slug)).toEqual(['t1']);
  });

  it('releases the lock after a write (second write is fast)', async () => {
    const { mkdtemp, mkdir, stat } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'baton-lock2-'));
    await mkdir(join(root, '.baton'), { recursive: true });
    const task = (slug: string) => ({
      slug, task: slug, branch: `baton/${slug}`, worktreePath: join(root, slug),
      baseBranch: 'main', baseCommit: null, createdAt: new Date().toISOString(),
    });
    await addTask(root, task('a'));
    await expect(stat(join(root, '.baton', 'tasks.lock'))).rejects.toThrow(); // released
    const t0 = Date.now();
    await addTask(root, task('b'));
    expect(Date.now() - t0).toBeLessThan(500); // no lock contention
    expect((await loadTasks(root)).map((t) => t.slug)).toEqual(['a', 'b']);
  });
});
