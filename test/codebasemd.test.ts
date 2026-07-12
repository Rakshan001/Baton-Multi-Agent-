import { describe, expect, it } from 'vitest';
import { extractGodNodes, renderTree, type DirNode, type GraphJson } from '../src/kb/codebasemd.js';

describe('extractGodNodes', () => {
  const graph: GraphJson = {
    built_at_commit: 'abc123',
    nodes: [
      { id: 'a', label: 'AuthService', file_type: 'code', source_file: 'src/auth.ts', source_location: 'L10' },
      { id: 'b', label: 'UserRepo', file_type: 'code', source_file: 'src/users.ts', source_location: 'L5' },
      { id: 'c', label: 'README', file_type: 'document', source_file: 'README.md' },
      { id: 'd', label: 'helper', file_type: 'code', source_file: 'src/util.ts' },
    ],
    links: [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'd' },
      { source: 'b', target: 'd' },
      { source: 'c', target: 'a' }, // doc link still counts toward a's degree
    ],
  };

  it('ranks by degree and excludes documents', () => {
    const gods = extractGodNodes(graph);
    expect(gods.map((g) => g.label)).toEqual(['AuthService', 'UserRepo', 'helper']);
    expect(gods[0].degree).toBe(3);
    expect(gods.find((g) => g.label === 'README')).toBeUndefined();
  });

  it('breaks degree ties alphabetically (deterministic output)', () => {
    const gods = extractGodNodes(graph);
    // UserRepo and helper both have degree 2 → alphabetical
    expect(gods.slice(1).map((g) => g.label)).toEqual(['UserRepo', 'helper']);
  });

  it('respects the limit', () => {
    expect(extractGodNodes(graph, 1)).toHaveLength(1);
  });

  it('handles empty graphs', () => {
    expect(extractGodNodes({})).toEqual([]);
  });
});

describe('renderTree', () => {
  const tree: DirNode = {
    name: 'proj',
    dirs: [
      { name: 'node_modules', dirs: [], files: [], collapsedFiles: 4821 },
      {
        name: 'src',
        dirs: [{ name: 'lib', dirs: [], files: ['a.ts', 'b.ts'] }],
        files: ['index.ts'],
      },
    ],
    files: ['package.json', 'README.md'],
  };

  it('renders collapsed dirs with file counts', () => {
    const lines = renderTree(tree);
    expect(lines).toContain('node_modules/ (4821 files)');
    expect(lines).toContain('src/');
    expect(lines).toContain('  lib/');
    expect(lines).toContain('    a.ts');
    expect(lines).toContain('package.json');
  });

  it('caps output and marks truncation', () => {
    const big: DirNode = {
      name: 'big',
      dirs: [],
      files: Array.from({ length: 500 }, (_, i) => `f${i}.ts`),
    };
    const lines = renderTree(big, 20);
    expect(lines.length).toBeLessThanOrEqual(22);
  });

  it('elides long file lists per directory', () => {
    const many: DirNode = {
      name: 'd',
      dirs: [],
      files: Array.from({ length: 20 }, (_, i) => `file${String(i).padStart(2, '0')}.ts`),
    };
    const lines = renderTree(many);
    expect(lines).toContain('… +8 more files');
  });
});

describe('refreshDocsIfStale — CODEBASE.md follows a graph rebuilt outside the daemon (G1)', () => {
  it('regenerates a stale doc and leaves a fresh one alone', async () => {
    const { mkdtemp, mkdir, rm, writeFile, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { git } = await import('../src/util/exec.js');
    const { refreshDocsIfStale } = await import('../src/kb/codebasemd.js');

    const root = await mkdtemp(join(tmpdir(), 'baton-docs-stale-'));
    try {
      await git(['init', '-q'], root);
      await git(['config', 'user.email', 't@t.dev'], root);
      await git(['config', 'user.name', 't'], root);
      await writeFile(join(root, 'a.ts'), 'export const a = 1;\n', 'utf-8');
      await git(['add', '.'], root);
      await git(['commit', '-q', '-m', 'init'], root);
      const head = (await git(['rev-parse', 'HEAD'], root)).trim();

      const graphPath = join(root, 'graphify-out', 'graph.json');
      await mkdir(join(root, 'graphify-out'), { recursive: true });
      // The post-commit hook rebuilt the graph to HEAD…
      await writeFile(graphPath, JSON.stringify({ nodes: [], links: [], built_at_commit: head }), 'utf-8');
      // …but CODEBASE.md still carries the previous build's footer.
      await writeFile(join(root, 'CODEBASE.md'),
        'old map\n\n<!-- baton:codebase generated=2026-01-01T00:00:00Z commit=0000000 -->\n', 'utf-8');
      await mkdir(join(root, '.baton'), { recursive: true });
      await writeFile(join(root, '.baton', 'kb.json'), JSON.stringify({
        root, projects: [{ id: 'p', name: 'p', path: root, graphPath }],
        mergedGraphPath: null, lastBuiltAt: null,
      }), 'utf-8');

      const written = await refreshDocsIfStale(root);
      expect(written.length).toBeGreaterThan(0);
      const md = await readFile(join(root, 'CODEBASE.md'), 'utf-8');
      expect(md).toContain(`commit=${head}`); // footer caught up with the graph

      // Second sweep: everything fresh → no writes.
      expect(await refreshDocsIfStale(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
