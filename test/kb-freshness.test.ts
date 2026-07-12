import { describe, expect, it } from 'vitest';
import {
  classifyGraphFreshness,
  isIndexablePath,
  renderGraphFreshnessNote,
  injectFreshnessNote,
  renderBranchDivergenceNote,
  worktreeGraphDivergence,
} from '../src/kb/freshness.js';

/**
 * G1 — the graph-freshness golden rule. The graph is only as fresh as its last
 * build (post-commit); uncommitted edits are invisible to it. These pure
 * helpers classify how far the graph lags reality and render the honest
 * warning every graph consumer (orient, graph query proxy) attaches, so an
 * agent can never trust a stale symbol and re-create an existing function.
 */
describe('classifyGraphFreshness', () => {
  it('is fresh when the graph was built at HEAD and nothing is dirty', () => {
    const f = classifyGraphFreshness({ builtAtCommit: 'abc', head: 'abc', behind: 0, dirtyPaths: [] });
    expect(f.status).toBe('fresh');
  });

  it('is behind when HEAD moved past the built commit', () => {
    const f = classifyGraphFreshness({ builtAtCommit: 'abc', head: 'def', behind: 3, dirtyPaths: [] });
    expect(f.status).toBe('behind');
    expect(f.behind).toBe(3);
  });

  it('dirty dominates behind — uncommitted edits are the sharper warning', () => {
    const f = classifyGraphFreshness({ builtAtCommit: 'abc', head: 'def', behind: 3, dirtyPaths: ['src/a.ts'] });
    expect(f.status).toBe('dirty');
    expect(f.dirtyPaths).toEqual(['src/a.ts']);
  });

  it('is unknown when the graph never recorded its commit', () => {
    const f = classifyGraphFreshness({ builtAtCommit: null, head: 'abc', behind: 0, dirtyPaths: [] });
    expect(f.status).toBe('unknown');
  });
});

describe('isIndexablePath — only warn about files the graph actually indexes', () => {
  it('accepts code files', () => {
    expect(isIndexablePath('src/auth.ts')).toBe(true);
    expect(isIndexablePath('app/main.py')).toBe(true);
    expect(isIndexablePath('web/App.tsx')).toBe(true);
    expect(isIndexablePath('Service.java')).toBe(true);
  });
  it('rejects docs and non-code files (a dirty README is not graph drift)', () => {
    expect(isIndexablePath('README.md')).toBe(false);
    expect(isIndexablePath('notes.txt')).toBe(false);
  });
  it('rejects ignored/generated locations even with code extensions', () => {
    expect(isIndexablePath('node_modules/x/index.js')).toBe(false);
    expect(isIndexablePath('graphify-out/graph.json')).toBe(false);
    expect(isIndexablePath('.baton/wt/task/src/a.ts')).toBe(false);
    expect(isIndexablePath('dist/cli.js')).toBe(false);
  });
});

describe('renderGraphFreshnessNote', () => {
  it('says nothing when fresh or unknown — no noise', () => {
    expect(renderGraphFreshnessNote({ status: 'fresh', builtAtCommit: 'abc', behind: 0, dirtyPaths: [] })).toBe('');
    expect(renderGraphFreshnessNote({ status: 'unknown', builtAtCommit: null, behind: 0, dirtyPaths: [] })).toBe('');
  });

  it('dirty: names the files and tells the agent to re-read them, not the graph', () => {
    const note = renderGraphFreshnessNote({
      status: 'dirty', builtAtCommit: 'abcdef1234567', behind: 0, dirtyPaths: ['src/a.ts', 'src/b.ts'],
    });
    expect(note).toContain('src/a.ts');
    expect(note).toContain('re-read');
    expect(note).toContain('abcdef1'); // short sha
  });

  it('dirty: caps the file list instead of dumping dozens of paths', () => {
    const many = Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`);
    const note = renderGraphFreshnessNote({ status: 'dirty', builtAtCommit: 'abc', behind: 0, dirtyPaths: many });
    expect(note).toContain('src/f0.ts');
    expect(note).not.toContain('src/f9.ts');
    expect(note).toContain('more');
  });

  it('behind: reports how many commits the graph lags', () => {
    const note = renderGraphFreshnessNote({ status: 'behind', builtAtCommit: 'abc', behind: 4, dirtyPaths: [] });
    expect(note).toContain('4 commit');
    expect(note.toLowerCase()).toContain('behind');
  });
});

describe('injectFreshnessNote — append the warning to a proxied graph answer', () => {
  const rpc = (content: unknown[]) => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content } });

  it('appends a text block to a JSON-RPC tools/call result', () => {
    const out = injectFreshnessNote(rpc([{ type: 'text', text: 'answer' }]), 'application/json', 'WARN');
    const parsed = JSON.parse(out) as { result: { content: Array<{ type: string; text: string }> } };
    expect(parsed.result.content).toHaveLength(2);
    expect(parsed.result.content[1]).toEqual({ type: 'text', text: 'WARN' });
  });

  it('returns the body unchanged when there is no note', () => {
    const body = rpc([{ type: 'text', text: 'answer' }]);
    expect(injectFreshnessNote(body, 'application/json', '')).toBe(body);
  });

  it('never touches SSE streams, invalid JSON, or shapes it does not understand', () => {
    expect(injectFreshnessNote('event: message\ndata: {}\n\n', 'text/event-stream', 'WARN'))
      .toBe('event: message\ndata: {}\n\n');
    expect(injectFreshnessNote('not json', 'application/json', 'WARN')).toBe('not json');
    const noContent = JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} });
    expect(injectFreshnessNote(noContent, 'application/json', 'WARN')).toBe(noContent);
    const errorResp = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } });
    expect(injectFreshnessNote(errorResp, 'application/json', 'WARN')).toBe(errorResp);
  });
});

describe('worktree branch divergence (W2)', () => {
  it('renders a warning naming the files that differ from the graph build point', () => {
    const note = renderBranchDivergenceNote(['src/auth.ts', 'src/pay.ts'], 'abc1234def');
    expect(note).toContain('abc1234');
    expect(note).toContain('src/auth.ts');
    expect(note).toMatch(/re-read/i);
    expect(note).toMatch(/branch/i);
  });
  it('renders nothing when the branch matches the build point', () => {
    expect(renderBranchDivergenceNote([], 'abc1234def')).toBe('');
  });
  it('caps the file list like the dirty note does', () => {
    const files = Array.from({ length: 10 }, (_, i) => `f${i}.ts`);
    const note = renderBranchDivergenceNote(files, 'abc1234def');
    expect(note).toContain('(+4 more)');
  });
});

describe('worktreeGraphDivergence — against a real worktree', () => {
  it('lists indexable files that differ between the graph commit and the worktree HEAD', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { git } = await import('../src/util/exec.js');
    const repo = await mkdtemp(join(tmpdir(), 'baton-diverge-'));
    try {
      await git(['init', '-q', '-b', 'main'], repo);
      await git(['config', 'user.email', 't@t.dev'], repo);
      await git(['config', 'user.name', 't'], repo);
      await writeFile(join(repo, 'a.ts'), 'export const a = 1;\n', 'utf-8');
      await git(['add', '.'], repo);
      await git(['commit', '-q', '-m', 'graph built here'], repo);
      const builtAt = (await git(['rev-parse', 'HEAD'], repo)).trim();
      const wt = join(repo, 'wt-branch');
      await git(['worktree', 'add', '-q', '-b', 'feat/x', wt], repo);
      await writeFile(join(wt, 'a.ts'), 'export const a = 2;\n', 'utf-8');
      await writeFile(join(wt, 'README.md'), 'docs only\n', 'utf-8'); // not indexable
      await git(['add', '.'], wt);
      await git(['commit', '-q', '-m', 'branch work'], wt);

      expect(await worktreeGraphDivergence(wt, builtAt)).toEqual(['a.ts']);
      // same commit → no divergence
      expect(await worktreeGraphDivergence(repo, builtAt)).toEqual([]);
      // unknown commit → fail safe, empty
      expect(await worktreeGraphDivergence(wt, 'f'.repeat(40))).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
