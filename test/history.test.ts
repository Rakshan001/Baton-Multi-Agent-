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
