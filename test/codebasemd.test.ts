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
