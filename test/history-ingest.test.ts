import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { ingestGitLog, listHistory, queryFile, closeHistoryDb } from '../src/history.js';

/**
 * B2 — commits that land OUTSIDE `baton merge` (agents merging via GitHub PRs
 * directly on the sub-repos) were invisible: history.db's commits table is only
 * written by recordMerge. ingestGitLog reads a repo's real git log into a
 * synthetic per-project bucket so the History page and who_touched/blame cover
 * every commit, however it landed. Idempotent; never clobbers a real task's
 * attribution of the same sha.
 */
async function repoWithCommits(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'baton-ingest-'));
  await git(['init', '-q'], root);
  await git(['config', 'user.email', 't@t.dev'], root);
  await git(['config', 'user.name', 't'], root);
  await writeFile(join(root, 'auth.ts'), 'export const a = 1;\n', 'utf-8');
  await git(['add', '.'], root);
  await git(['commit', '-q', '-m', 'fix(auth): first'], root);
  await writeFile(join(root, 'pay.ts'), 'export const p = 1;\n', 'utf-8');
  await git(['add', '.'], root);
  await git(['commit', '-q', '-m', 'feat(pay): second'], root);
  return root;
}

describe('ingestGitLog', () => {
  let root: string;
  beforeEach(async () => { root = await repoWithCommits(); });
  afterEach(async () => { closeHistoryDb(root); await rm(root, { recursive: true, force: true }); });

  it('imports real git commits into a labelled per-project bucket', async () => {
    const n = await ingestGitLog(root, { slug: 'git:proj-a', task: 'proj-a (direct commits)', cwd: root });
    expect(n).toBe(2);
    const hist = listHistory(root).find((h) => h.slug === 'git:proj-a');
    expect(hist?.task).toBe('proj-a (direct commits)');
    expect(hist?.commits.map((c) => c.message).sort()).toEqual(['feat(pay): second', 'fix(auth): first']);
  });

  it('records each commit\'s files so who_touched/blame work', async () => {
    await ingestGitLog(root, { slug: 'git:proj-a', task: 'proj-a', cwd: root });
    const hits = queryFile(root, 'auth.ts');
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toBe('fix(auth): first');
    expect(hits[0].slug).toBe('git:proj-a');
  });

  it('is idempotent — re-ingesting adds nothing and does not duplicate files', async () => {
    await ingestGitLog(root, { slug: 'git:proj-a', task: 'proj-a', cwd: root });
    const added = await ingestGitLog(root, { slug: 'git:proj-a', task: 'proj-a', cwd: root });
    expect(added).toBe(0);
    expect(queryFile(root, 'auth.ts')).toHaveLength(1); // not duplicated
    const hist = listHistory(root).find((h) => h.slug === 'git:proj-a');
    expect(hist?.commits).toHaveLength(2);
  });

  it('picks up new commits on a later ingest', async () => {
    await ingestGitLog(root, { slug: 'git:proj-a', task: 'proj-a', cwd: root });
    await writeFile(join(root, 'auth.ts'), 'export const a = 2;\n', 'utf-8');
    await git(['add', '.'], root);
    await git(['commit', '-q', '-m', 'fix(auth): third'], root);
    const added = await ingestGitLog(root, { slug: 'git:proj-a', task: 'proj-a', cwd: root });
    expect(added).toBe(1);
    const hist = listHistory(root).find((h) => h.slug === 'git:proj-a');
    expect(hist?.commits).toHaveLength(3);
  });

  it('never overwrites a real task\'s attribution of the same commit', async () => {
    // A real merged task already owns auth.ts's commit sha.
    const sha = (await git(['rev-list', '-1', 'HEAD', '--', 'auth.ts'], root)).trim();
    const { recordTask, recordMerge } = await import('../src/history.js');
    recordTask(root, { slug: 'real-task', task: 'the real task', branch: 'baton/x', baseBranch: 'main', createdAt: new Date().toISOString() });
    recordMerge(root, { slug: 'real-task', mergedAt: new Date().toISOString(), archivedRef: null,
      commits: [{ sha, message: 'fix(auth): first', at: '2026-01-01T00:00:00Z', files: ['auth.ts'] }] });

    await ingestGitLog(root, { slug: 'git:proj-a', task: 'proj-a', cwd: root });
    const hits = queryFile(root, 'auth.ts');
    // still attributed to the real task, not duplicated into the git bucket
    expect(hits).toHaveLength(1);
    expect(hits[0].slug).toBe('real-task');
  });

  it('returns 0 for a path that is not a git repo (fail-safe)', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'baton-nogit-'));
    try {
      expect(await ingestGitLog(root, { slug: 'git:x', task: 'x', cwd: empty })).toBe(0);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
