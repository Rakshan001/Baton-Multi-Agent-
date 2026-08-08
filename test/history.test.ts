// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listHistory, queryFile, recordMerge, recordTask } from '../src/history.js';

describe('history index (node:sqlite)', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-hist-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('records a task and lists it with no commits yet', () => {
    recordTask(root, {
      slug: 'navbar',
      task: 'fix navbar',
      branch: 'baton/navbar',
      baseBranch: 'main',
      createdAt: '2026-06-08T00:00:00Z',
    });
    const h = listHistory(root);
    expect(h).toHaveLength(1);
    expect(h[0].slug).toBe('navbar');
    expect(h[0].commits).toEqual([]);
  });

  it('records merge commits and attributes a file to its task/agent', () => {
    recordTask(root, {
      slug: 'navbar',
      task: 'fix navbar',
      branch: 'baton/navbar',
      baseBranch: 'main',
      createdAt: '2026-06-08T00:00:00Z',
    });
    recordMerge(root, {
      slug: 'navbar',
      agent: 'claude',
      mergedAt: '2026-06-08T01:00:00Z',
      archivedRef: 'refs/baton/archive/navbar',
      commits: [
        { sha: 'aaaa1111', message: 'tweak nav', at: '2026-06-08T00:30:00Z', files: ['src/Nav.tsx', 'src/util.ts'] },
      ],
    });

    const hits = queryFile(root, 'src/Nav.tsx');
    expect(hits).toHaveLength(1);
    expect(hits[0].agent).toBe('claude');
    expect(hits[0].slug).toBe('navbar');
    expect(hits[0].message).toBe('tweak nav');

    expect(queryFile(root, 'does/not/exist.ts')).toEqual([]);

    const h = listHistory(root);
    expect(h[0].agent).toBe('claude');
    expect(h[0].mergedAt).toBe('2026-06-08T01:00:00Z');
    expect(h[0].commits).toHaveLength(1);
  });
});

/**
 * Paths recorded in history are worktree-relative, so in a hub `src/index.ts`
 * in proj-a and in proj-b are two unrelated files that merely spell the same
 * string. Without a project column, who_touched blended their histories and
 * named agents that never opened the file — the history-plane twin of the
 * conflict bug 87b4114 fixed for signals.
 */
describe('who_touched scoping across a hub\'s sub-projects', () => {
  let root: string;
  const commit = (sha: string, path: string) => ({ sha, message: `touch ${path}`, at: '2026-08-05T10:00:00.000Z', files: [path] });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-histscope-'));
    for (const [slug, project] of [['a-task', 'proj-a'], ['b-task', 'proj-b']] as const) {
      recordTask(root, { slug, task: slug, branch: `baton/${slug}`, baseBranch: 'main', createdAt: '2026-08-05T09:00:00.000Z' });
      recordMerge(root, {
        slug, mergedAt: '2026-08-05T10:00:00.000Z', archivedRef: null,
        projectId: project, agent: project === 'proj-a' ? 'claude' : 'cursor',
        commits: [commit(`sha-${slug}`, 'src/index.ts')],
      });
    }
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('returns only the asker\'s project', () => {
    expect(queryFile(root, 'src/index.ts', 'proj-a').map((h) => h.slug)).toEqual(['a-task']);
    expect(queryFile(root, 'src/index.ts', 'proj-b').map((h) => h.slug)).toEqual(['b-task']);
  });

  it('an asker with no project still sees everything — a single repo must not lose history', () => {
    expect(queryFile(root, 'src/index.ts').map((h) => h.slug).sort()).toEqual(['a-task', 'b-task']);
    expect(queryFile(root, 'src/index.ts', null).map((h) => h.slug).sort()).toEqual(['a-task', 'b-task']);
  });

  it('a row with no project of its own matches every asker', () => {
    // Written by a task with no sub-project, or before the column existed.
    recordTask(root, { slug: 'plain', task: 'plain', branch: 'baton/plain', baseBranch: 'main', createdAt: '2026-08-05T09:00:00.000Z' });
    recordMerge(root, {
      slug: 'plain', mergedAt: '2026-08-05T11:00:00.000Z', archivedRef: null,
      commits: [commit('sha-plain', 'src/index.ts')],
    });
    expect(queryFile(root, 'src/index.ts', 'proj-a').map((h) => h.slug).sort()).toEqual(['a-task', 'plain']);
  });
});

/**
 * The column is added to databases that predate it, so an existing install must
 * keep working — and keep its history — after an upgrade.
 */
describe('commit_files.project migration', () => {
  it('adds the column to a pre-existing db and backfills the git:<id> buckets', async () => {
    const { createRequire } = await import('node:module');
    const { mkdirSync } = await import('node:fs');
    const root = await mkdtemp(join(tmpdir(), 'baton-histmig-'));
    try {
      // A database in the OLD shape: commit_files with no `project`.
      const sqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
      mkdirSync(join(root, '.baton'), { recursive: true });
      const old = new sqlite.DatabaseSync(join(root, '.baton', 'history.db'));
      old.exec(`CREATE TABLE tasks (slug TEXT PRIMARY KEY, task TEXT, agent TEXT, branch TEXT, base_branch TEXT, created_at TEXT, merged_at TEXT, archived_ref TEXT)`);
      old.exec(`CREATE TABLE commits (sha TEXT PRIMARY KEY, slug TEXT, message TEXT, at TEXT)`);
      old.exec(`CREATE TABLE commit_files (sha TEXT, slug TEXT, path TEXT)`);
      old.exec(`INSERT INTO tasks VALUES ('git:proj-a','proj-a direct',NULL,NULL,NULL,'2026-08-01','2026-08-01',NULL)`);
      old.exec(`INSERT INTO tasks VALUES ('legacy','legacy',NULL,NULL,NULL,'2026-08-01','2026-08-01',NULL)`);
      old.exec(`INSERT INTO commits VALUES ('s1','git:proj-a','m','2026-08-01T00:00:00.000Z')`);
      old.exec(`INSERT INTO commits VALUES ('s2','legacy','m','2026-08-01T00:00:00.000Z')`);
      old.exec(`INSERT INTO commit_files VALUES ('s1','git:proj-a','src/index.ts')`);
      old.exec(`INSERT INTO commit_files VALUES ('s2','legacy','src/index.ts')`);
      old.close();

      // git:<id> rows are backfilled, so they scope correctly straight away...
      expect(queryFile(root, 'src/index.ts', 'proj-a').map((h) => h.slug).sort()).toEqual(['git:proj-a', 'legacy']);
      // ...and proj-b sees only the un-backfillable legacy row, never proj-a's.
      expect(queryFile(root, 'src/index.ts', 'proj-b').map((h) => h.slug)).toEqual(['legacy']);
      // Nothing was lost: an unscoped ask still returns both.
      expect(queryFile(root, 'src/index.ts').map((h) => h.slug).sort()).toEqual(['git:proj-a', 'legacy']);
    } finally {
      const { closeHistoryDb } = await import('../src/history.js');
      closeHistoryDb(root);
      await rm(root, { recursive: true, force: true });
    }
  });
});
