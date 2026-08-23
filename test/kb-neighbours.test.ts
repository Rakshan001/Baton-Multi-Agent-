// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Browsing the graph without downloading it.
 *
 * This repo's own graph.json is 144,502,085 bytes for 98,266 nodes and 286,680
 * links -- the file is mostly pretty-printing. Streaming it whole to a client
 * is what /api/kb/graph already does and what the Orca panel already refuses,
 * with the size in the message. These are the queries that replace it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { graphPathFor } from '../src/kb/state.js';
import {
  clearNeighbourIndex, evictIdleNeighbourIndex, neighbourIndexBuilds,
  NEIGHBOURS_IDLE_EVICT_MS, queryNeighbours,
} from '../src/kb/neighbours.js';

let root: string;
let graph: string;

const node = (id: string, over: Record<string, unknown> = {}) => ({
  id, label: id, file_type: 'code', source_file: 'src/a.ts', source_location: 'L1', ...over,
});
const link = (source: string, target: string, relation = 'calls') => ({ source, target, relation });

async function writeGraph(g: unknown): Promise<void> {
  await mkdir(join(root, 'graphify-out'), { recursive: true });
  await writeFile(graph, JSON.stringify(g));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'baton-nb-'));
  graph = graphPathFor(root);
  clearNeighbourIndex();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  clearNeighbourIndex();
});

describe('queryNeighbours — node', () => {
  it('answers both directions, and says which is which', async () => {
    await writeGraph({
      nodes: [node('a'), node('b'), node('c')],
      links: [link('a', 'b', 'calls'), link('c', 'a', 'imports')],
    });
    const out = await queryNeighbours(graph, { node: 'a' });
    expect(out.ok).toBe(true);
    if (!out.ok || out.kind !== 'node') throw new Error('expected a node answer');
    expect(out.neighbours.map((n) => [n.id, n.direction, n.relation])).toEqual([
      ['b', 'out', 'calls'],
      ['c', 'in', 'imports'],
    ]);
  });

  // N-E2. An empty list is a claim that the symbol is isolated. A symbol that
  // is not in the graph at all supports no claim about its neighbours.
  it('refuses an unknown id instead of returning an empty neighbourhood', async () => {
    await writeGraph({ nodes: [node('a')], links: [] });
    const out = await queryNeighbours(graph, { node: 'ghost' });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected a refusal');
    expect(out.code).toBe('unknown-node');
  });

  // N-E7. And an isolated symbol is a real answer, not a refusal.
  it('answers zero neighbours for a symbol that genuinely has none', async () => {
    await writeGraph({ nodes: [node('lonely')], links: [] });
    const out = await queryNeighbours(graph, { node: 'lonely' });
    if (!out.ok || out.kind !== 'node') throw new Error('expected a node answer');
    expect(out.neighbours).toEqual([]);
    expect(out.total).toBe(0);
    expect(out.withheld).toBe(0);
  });

  // N-E3. `translate` in this repo has 3,161 edges. Truncating silently would
  // present 50 of them as the whole neighbourhood.
  it('caps a hub and reports how many it withheld', async () => {
    const nodes = [node('hub'), ...Array.from({ length: 120 }, (_, i) => node(`n${i}`))];
    await writeGraph({ nodes, links: nodes.slice(1).map((n) => link('hub', n.id)) });
    const out = await queryNeighbours(graph, { node: 'hub', limit: 50 });
    if (!out.ok || out.kind !== 'node') throw new Error('expected a node answer');
    expect(out.neighbours).toHaveLength(50);
    expect(out.total).toBe(120);
    expect(out.withheld).toBe(70);
  });

  it('ranks the structurally important neighbours ahead of the rest', async () => {
    // Same notion of importance extractGodNodes already uses: degree.
    await writeGraph({
      nodes: [node('hub'), node('busy'), node('quiet'), node('x'), node('y')],
      links: [
        link('hub', 'quiet'), link('hub', 'busy'),
        link('busy', 'x'), link('busy', 'y'),
      ],
    });
    const out = await queryNeighbours(graph, { node: 'hub', limit: 1 });
    if (!out.ok || out.kind !== 'node') throw new Error('expected a node answer');
    expect(out.neighbours[0]!.id).toBe('busy');
  });
});

describe('queryNeighbours — file', () => {
  it('lists the symbols a file defines, so a reader can pick one', async () => {
    await writeGraph({
      nodes: [
        node('a', { source_file: 'src/a.ts' }),
        node('b', { source_file: 'src/a.ts' }),
        node('c', { source_file: 'src/other.ts' }),
      ],
      links: [],
    });
    const out = await queryNeighbours(graph, { file: 'src/a.ts' });
    if (!out.ok || out.kind !== 'file') throw new Error('expected a file answer');
    expect(out.nodes.map((n) => n.id)).toEqual(['a', 'b']);
  });

  // N-E5. "This file has no symbols" and "the graph has never seen this file"
  // are different, and only one of them is a reason to rebuild.
  it('refuses a file the graph has never seen', async () => {
    await writeGraph({ nodes: [node('a')], links: [] });
    const out = await queryNeighbours(graph, { file: 'src/never.ts' });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected a refusal');
    expect(out.code).toBe('file-not-indexed');
  });

  it('normalises a windows-style path against a posix-indexed graph', async () => {
    await writeGraph({ nodes: [node('a', { source_file: 'src/a.ts' })], links: [] });
    const out = await queryNeighbours(graph, { file: 'src\\a.ts' });
    expect(out.ok).toBe(true);
  });
});

describe('queryNeighbours — refusals that are not about the query', () => {
  // N-E1
  it('says the graph is not built rather than reporting an empty one', async () => {
    const out = await queryNeighbours(graph, { node: 'a' });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected a refusal');
    expect(out.code).toBe('not-built');
    expect(out.message).toContain('baton kb rebuild');
  });

  // N-E6
  it('refuses a query that names neither a node nor a file', async () => {
    await writeGraph({ nodes: [node('a')], links: [] });
    const out = await queryNeighbours(graph, {});
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected a refusal');
    expect(out.code).toBe('needs-selector');
  });
});

describe('the index cache', () => {
  // N-E4. A rebuild while a panel is open must not keep answering from the
  // graph that existed when it opened.
  it('rebuilds itself when the graph file changes', async () => {
    await writeGraph({ nodes: [node('a')], links: [] });
    expect((await queryNeighbours(graph, { node: 'a' })).ok).toBe(true);

    await writeGraph({ nodes: [node('b')], links: [] });
    // Same size is possible; the mtime moves regardless.
    await utimes(graph, new Date(), new Date(Date.now() + 1000));

    expect((await queryNeighbours(graph, { node: 'a' })).ok).toBe(false);
    expect((await queryNeighbours(graph, { node: 'b' })).ok).toBe(true);
  });

  it('parses the graph once, however many queries follow', async () => {
    // 144 MB per request is the thing this endpoint exists to avoid.
    await writeGraph({ nodes: [node('a'), node('b')], links: [link('a', 'b')] });
    await queryNeighbours(graph, { node: 'a' });
    await queryNeighbours(graph, { node: 'b' });
    await queryNeighbours(graph, { file: 'src/a.ts' });
    expect(neighbourIndexBuilds()).toBe(1);
  });
});

describe('the index does not squat on memory', () => {
  // Measured on this repo's own graph: 328 MB peak while parsing, 94 MB
  // retained afterwards. A background daemon must not hold that for a panel
  // somebody closed an hour ago.
  it('drops the index once nobody has asked in a while', async () => {
    await writeGraph({ nodes: [node('a')], links: [] });
    await queryNeighbours(graph, { node: 'a' });
    expect(neighbourIndexBuilds()).toBe(1);

    evictIdleNeighbourIndex(Date.now() + NEIGHBOURS_IDLE_EVICT_MS + 1);

    await queryNeighbours(graph, { node: 'a' });
    expect(neighbourIndexBuilds()).toBe(2);
  });

  it('keeps an index that is still being used', async () => {
    await writeGraph({ nodes: [node('a')], links: [] });
    await queryNeighbours(graph, { node: 'a' });
    evictIdleNeighbourIndex(Date.now() + 1_000);
    await queryNeighbours(graph, { node: 'a' });
    expect(neighbourIndexBuilds()).toBe(1);
  });
})
