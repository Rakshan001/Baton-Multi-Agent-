import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStats } from '../src/kb/graphify.js';

const graph = (n: number) => JSON.stringify({
  nodes: Array.from({ length: n }, (_, i) => ({ id: `n${i}`, community: i % 2 })),
  links: Array.from({ length: Math.max(0, n - 1) }, (_, i) => ({ source: `n${i}`, target: `n${i + 1}` })),
  built_at_commit: 'abc1234',
});

describe('readStats (memoized graph.json stats)', () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'baton-graphstats-'));
    file = join(dir, 'graph.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parses node/edge/community counts', async () => {
    await writeFile(file, graph(4), 'utf-8');
    const s = await readStats(file);
    expect(s).not.toBeNull();
    expect(s!.nodes).toBe(4);
    expect(s!.edges).toBe(3);
    expect(s!.communities).toBe(2);
    expect(s!.builtAtCommit).toBe('abc1234');
  });

  it('returns null for a missing file', async () => {
    expect(await readStats(join(dir, 'nope.json'))).toBeNull();
  });

  it('reflects a rebuilt graph (cache invalidates on size/mtime change)', async () => {
    await writeFile(file, graph(2), 'utf-8');
    expect((await readStats(file))!.nodes).toBe(2);
    // A rebuild rewrites the file with different content/size — stale stats must not stick.
    await writeFile(file, graph(7), 'utf-8');
    expect((await readStats(file))!.nodes).toBe(7);
  });

  it('returns null on malformed JSON', async () => {
    await writeFile(file, '{ not valid json', 'utf-8');
    expect(await readStats(file)).toBeNull();
  });
});
