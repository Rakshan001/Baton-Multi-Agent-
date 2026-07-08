import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { renderOrientation, buildOrientation, ORIENT_MAX_CHARS } from '../src/kb/orient.js';
import { saveMemory } from '../src/memory.js';
import type { CompletionReport } from '../src/reports.js';

const report = (slug: string, summary: string): CompletionReport => ({
  slug, task: `do ${slug}`, agent: 'claude', mergedAt: new Date().toISOString(),
  summary, files: [`src/${slug}.ts`], commits: [], overlappedWith: [],
});

describe('renderOrientation — durable, budgeted onboarding brief', () => {
  const memory = '## Project memory (evidence-checked)\n\n- [gotcha] auth tokens expire in 15m';

  it('composes the CODEBASE pointer, memory, recent work, and a live-tools pointer', () => {
    const out = renderOrientation({
      hasCodebaseMd: true,
      memorySection: memory,
      reports: [report('add-oauth', 'Added OAuth login')],
    });
    expect(out).toContain('CODEBASE.md');
    expect(out).toContain('auth tokens expire');
    expect(out).toContain('add-oauth');
    expect(out).toContain('Added OAuth login');
    expect(out).toMatch(/check_files|list_signals/); // pointer to LIVE tools, not the live data itself
  });

  it('always keeps the live-tools pointer, dropping recent-work first when over budget', () => {
    const fat = 'x'.repeat(ORIENT_MAX_CHARS); // memory alone blows the budget
    const out = renderOrientation({
      hasCodebaseMd: true,
      memorySection: `## Project memory (evidence-checked)\n\n${fat}`,
      reports: [report('add-oauth', 'Added OAuth login')],
    }, ORIENT_MAX_CHARS);
    expect(out.length).toBeLessThanOrEqual(ORIENT_MAX_CHARS);
    expect(out).toMatch(/check_files|list_signals/);
    expect(out).not.toContain('add-oauth'); // recent-work sacrificed before the pointer
  });

  it('falls back to a getting-started note when nothing durable exists yet', () => {
    const out = renderOrientation({ hasCodebaseMd: false, memorySection: '', reports: [] });
    expect(out.toLowerCase()).toMatch(/no .*memory|getting started|fresh/);
    expect(out).toMatch(/check_files|list_signals/);
  });

  it('carries the graph-freshness warning when the graph lags (G1 golden rule)', () => {
    const out = renderOrientation({
      hasCodebaseMd: true,
      freshnessNote: '⚠ Graph freshness: 2 file(s) have uncommitted edits — re-read: src/a.ts',
      memorySection: memory,
      reports: [report('add-oauth', 'Added OAuth login')],
    });
    expect(out).toContain('Graph freshness');
    expect(out).toContain('src/a.ts');
  });

  it('keeps the freshness warning even when the budget drops other sections', () => {
    const fat = 'x'.repeat(ORIENT_MAX_CHARS);
    const out = renderOrientation({
      hasCodebaseMd: true,
      freshnessNote: '⚠ Graph freshness: re-read src/a.ts',
      memorySection: `## Project memory (evidence-checked)\n\n${fat}`,
      reports: [report('add-oauth', 'Added OAuth login')],
    }, ORIENT_MAX_CHARS);
    expect(out).toContain('Graph freshness'); // a safety warning outranks nice-to-have context
    expect(out.length).toBeLessThanOrEqual(ORIENT_MAX_CHARS);
  });
});

describe('buildOrientation — gathers real memory/reports for a repo', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-orient-'));
    await git(['init', '-q'], root);
    await git(['config', 'user.email', 't@t.dev'], root);
    await git(['config', 'user.name', 't'], root);
    await writeFile(join(root, 'a.ts'), 'export const a = 1;\n', 'utf-8');
    await git(['add', '.'], root);
    await git(['commit', '-q', '-m', 'init'], root);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('surfaces a saved memory fact in the brief, under budget', async () => {
    await saveMemory(root, { fact: 'The daemon is zero-dependency raw node:http.', type: 'convention', files: ['a.ts'] });
    const brief = await buildOrientation(root);
    expect(brief).toContain('zero-dependency');
    expect(brief.length).toBeLessThanOrEqual(ORIENT_MAX_CHARS);
  });

  it('nudges a main-checkout session toward an isolated worktree (G2)', async () => {
    const brief = await buildOrientation(root, { cwd: root });
    expect(brief).toContain('baton new');
  });

  it('does not nudge a session already inside a worktree', async () => {
    const brief = await buildOrientation(root, { cwd: join(root, '.baton', 'wt', 'fix-auth') });
    expect(brief).not.toContain('baton new');
  });

  it('warns about uncommitted edits the graph cannot see, when a kb exists', async () => {
    const { mkdir } = await import('node:fs/promises');
    const head = (await git(['rev-parse', 'HEAD'], root)).trim();
    await mkdir(join(root, 'graphify-out'), { recursive: true });
    await writeFile(join(root, 'graphify-out', 'graph.json'),
      JSON.stringify({ nodes: [], links: [], built_at_commit: head }), 'utf-8');
    await mkdir(join(root, '.baton'), { recursive: true });
    await writeFile(join(root, '.baton', 'kb.json'), JSON.stringify({
      root, projects: [{ id: 'p', name: 'p', path: root, graphPath: join(root, 'graphify-out', 'graph.json') }],
      mergedGraphPath: null, lastBuiltAt: null,
    }), 'utf-8');
    await writeFile(join(root, 'a.ts'), 'export const a = 2; // edited, uncommitted\n', 'utf-8');

    const brief = await buildOrientation(root);
    expect(brief).toContain('a.ts');
    expect(brief.toLowerCase()).toContain('re-read');
  });
});
