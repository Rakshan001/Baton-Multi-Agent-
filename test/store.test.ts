import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addTask,
  getTask,
  loadTasks,
  removeTask,
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
