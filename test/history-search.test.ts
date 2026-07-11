import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordTask, recordMerge, searchHistory, closeHistoryDb } from '../src/history.js';

/**
 * Unified commit search — the "graphify the commits" answer done the
 * token-optimal way: SQLite FTS5 over messages + file paths already in
 * history.db (zero new deps, no graph construction cost). An agent asks
 * "who touched token expiry?" and gets top hits with task/agent/files for
 * ~150 tokens instead of a git-log spelunking session.
 */
describe('searchHistory — FTS over commits + files', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-hsearch-'));
    await mkdir(join(root, '.baton'), { recursive: true });
    recordTask(root, { slug: 'fix-auth', task: 'fix auth token expiry', agent: 'claude', branch: 'baton/fix-auth', baseBranch: 'main', createdAt: '2026-07-01T10:00:00Z' });
    recordMerge(root, {
      slug: 'fix-auth', agent: 'claude', mergedAt: '2026-07-01T12:00:00Z', archivedRef: null,
      commits: [
        { sha: 'a'.repeat(40), message: 'fix(auth): correct token expiry clock skew', at: '2026-07-01T11:00:00Z', files: ['src/auth/token.ts', 'test/token.test.ts'] },
        { sha: 'b'.repeat(40), message: 'chore: tidy imports', at: '2026-07-01T11:30:00Z', files: ['src/auth/token.ts'] },
      ],
    });
    recordTask(root, { slug: 'add-csv', task: 'csv export', agent: 'codex', branch: 'baton/add-csv', baseBranch: 'main', createdAt: '2026-07-02T10:00:00Z' });
    recordMerge(root, {
      slug: 'add-csv', agent: 'codex', mergedAt: '2026-07-02T12:00:00Z', archivedRef: null,
      commits: [{ sha: 'c'.repeat(40), message: 'feat(reports): streaming csv export', at: '2026-07-02T11:00:00Z', files: ['src/reports/csv.ts'] }],
    });
  });
  afterEach(async () => {
    closeHistoryDb(root);
    await rm(root, { recursive: true, force: true });
  });

  it('finds commits by message words, most relevant first, with task context', () => {
    const hits = searchHistory(root, 'token expiry');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].sha).toBe('a'.repeat(40));
    expect(hits[0].slug).toBe('fix-auth');
    expect(hits[0].agent).toBe('claude');
    expect(hits[0].files).toContain('src/auth/token.ts');
  });

  it('finds commits by file path fragments', () => {
    const hits = searchHistory(root, 'csv');
    expect(hits.some((h) => h.sha === 'c'.repeat(40))).toBe(true);
  });

  it('caps results and file lists (answers stay token-light)', () => {
    const hits = searchHistory(root, 'token', 1);
    expect(hits.length).toBeLessThanOrEqual(1);
    for (const h of hits) expect(h.files.length).toBeLessThanOrEqual(5);
  });

  it('never throws on hostile/odd queries', () => {
    for (const q of ['"unbalanced', 'a AND OR NOT', '(((', '', '   ', 'sha:*', 'x"; DROP TABLE commits;--']) {
      expect(() => searchHistory(root, q)).not.toThrow();
    }
  });

  it('returns [] when nothing matches', () => {
    expect(searchHistory(root, 'zebra quantum blockchain')).toEqual([]);
  });

  it('picks up commits recorded before the first search (lazy backfill)', () => {
    // First search builds the index from existing rows; a later merge must appear too.
    expect(searchHistory(root, 'expiry').length).toBeGreaterThan(0);
    recordMerge(root, {
      slug: 'add-csv', agent: 'codex', mergedAt: '2026-07-03T12:00:00Z', archivedRef: null,
      commits: [{ sha: 'd'.repeat(40), message: 'fix(csv): escape quoted delimiters', at: '2026-07-03T11:00:00Z', files: ['src/reports/csv.ts'] }],
    });
    const hits = searchHistory(root, 'delimiters');
    expect(hits.some((h) => h.sha === 'd'.repeat(40))).toBe(true);
  });
});
