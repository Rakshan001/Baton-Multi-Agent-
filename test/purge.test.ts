import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { git } from '../src/util/exec.js';
import { listArchiveRefs, listBatonBranches, branchExists } from '../src/git.js';
import {
  confirmPhraseFor, sanitizeCategories, purgePreview, purgeStorage, PURGE_CATEGORIES,
} from '../src/purge.js';

describe('sanitizeCategories', () => {
  it('keeps only known categories and de-dupes', () => {
    expect(sanitizeCategories(['memory', 'memory', 'reports', 'bogus', 42, null])).toEqual(['memory', 'reports']);
  });
  it('returns [] for non-arrays', () => {
    expect(sanitizeCategories('memory')).toEqual([]);
    expect(sanitizeCategories(undefined)).toEqual([]);
  });
  it('every advertised category is valid', () => {
    expect(sanitizeCategories([...PURGE_CATEGORIES])).toEqual(PURGE_CATEGORIES);
  });
});

describe('confirmPhraseFor', () => {
  it('is "purge <repo>"', () => {
    expect(confirmPhraseFor('orbit')).toBe('purge orbit');
  });
});

async function seedRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'baton-purge-'));
  await git(['init', '-q'], root);
  await git(['config', 'user.email', 'test@baton.dev'], root);
  await git(['config', 'user.name', 'Baton Test'], root);
  await git(['checkout', '-q', '-b', 'main'], root);
  await writeFile(join(root, 'README.md'), '# test\n', 'utf-8');
  await writeFile(join(root, '.gitignore'), '.baton/\n', 'utf-8');
  await git(['add', '.'], root);
  await git(['commit', '-q', '-m', 'initial'], root);

  // Baton data stores.
  await mkdir(join(root, '.baton', 'reports'), { recursive: true });
  await writeFile(join(root, '.baton', 'reports', 'feat-x.md'), 'report\n', 'utf-8');
  await mkdir(join(root, '.baton', 'memory', 'facts'), { recursive: true });
  await writeFile(join(root, '.baton', 'memory', 'facts', 'a.md'), 'a fact\n', 'utf-8');
  await writeFile(join(root, '.baton', 'history.db'), 'x'.repeat(2048), 'utf-8');
  await mkdir(join(root, '.baton', 'tmp'), { recursive: true });
  await writeFile(join(root, '.baton', 'tmp', 'upload.bin'), 'y'.repeat(1024), 'utf-8');

  // A completed task's residue: an archive ref + an orphan baton branch (no worktree).
  const head = (await git(['rev-parse', 'HEAD'], root)).trim();
  await git(['update-ref', 'refs/baton/archive/feat-x', head], root);
  await git(['branch', 'baton/feat-x', head], root);
  return root;
}

describe('purgeStorage (real repo)', () => {
  let root: string;
  beforeEach(async () => { root = await seedRepo(); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('previews categories with the typed confirm phrase', async () => {
    const p = await purgePreview(root);
    expect(p.repo).toBe(basename(root));
    expect(p.confirmPhrase).toBe(`purge ${basename(root)}`);
    const archives = p.items.find((i) => i.category === 'archives');
    expect(archives?.count).toBeGreaterThanOrEqual(2); // 1 archive ref + 1 orphan branch
  });

  it('permanently deletes selected data and reclaims git residue, sparing source + main', async () => {
    expect(await listArchiveRefs(root)).toHaveLength(1);
    expect(await branchExists('baton/feat-x', root)).toBe(true);

    const r = await purgeStorage(root, ['reports', 'memory', 'history', 'tmp', 'archives']);

    // Data stores are gone from disk.
    expect(existsSync(join(root, '.baton', 'reports'))).toBe(false);
    expect(existsSync(join(root, '.baton', 'memory', 'facts'))).toBe(false);
    expect(existsSync(join(root, '.baton', 'history.db'))).toBe(false);
    expect(existsSync(join(root, '.baton', 'tmp'))).toBe(false);

    // Git residue reclaimed: archive ref + orphan branch removed, gc ran.
    expect(await listArchiveRefs(root)).toHaveLength(0);
    expect(await branchExists('baton/feat-x', root)).toBe(false);
    expect(r.gcRan).toBe(true);
    expect(r.freedBytes).toBeGreaterThanOrEqual(0);

    // Safety: the user's source and main branch are untouched.
    expect(existsSync(join(root, 'README.md'))).toBe(true);
    expect(await branchExists('main', root)).toBe(true);
    expect((await listBatonBranches(root))).toHaveLength(0);
  });

  it('only deletes the categories asked for', async () => {
    await purgeStorage(root, ['tmp']);
    expect(existsSync(join(root, '.baton', 'tmp'))).toBe(false);
    expect(existsSync(join(root, '.baton', 'reports'))).toBe(true);
    expect(existsSync(join(root, '.baton', 'memory', 'facts'))).toBe(true);
    expect(await listArchiveRefs(root)).toHaveLength(1); // untouched without 'archives'
  });
});
