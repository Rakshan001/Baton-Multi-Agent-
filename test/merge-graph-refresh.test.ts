import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { queueMergeGraphRefresh } from '../src/commands/merge.js';

/**
 * G1 — the post-merge graph refresh must only refresh a graph that EXISTS.
 * A project listed in kb.json but never indexed has nothing to keep fresh;
 * first builds belong to `kb init`/`kb rebuild`. Before this guard, a merge
 * fire-and-forgot a detached graphify run that surprise-indexed the project
 * (and, in tests, kept writing graphify-out/ while cleanup deleted it).
 */
describe('queueMergeGraphRefresh', () => {
  let hub: string, projA: string, projB: string;

  beforeEach(async () => {
    hub = await mkdtemp(join(tmpdir(), 'baton-mergerefresh-'));
    projA = join(hub, 'proj-a');
    projB = join(hub, 'proj-b');
    for (const p of [projA, projB]) {
      await mkdir(p, { recursive: true });
      await git(['init', '-q'], p);
    }
    // proj-a HAS a built graph; proj-b was never indexed.
    await mkdir(join(projA, 'graphify-out'), { recursive: true });
    await writeFile(join(projA, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: [], links: [] }), 'utf-8');
    await mkdir(join(hub, '.baton'), { recursive: true });
    await writeFile(join(hub, '.baton', 'kb.json'), JSON.stringify({
      root: hub,
      projects: [
        { id: 'proj-a', name: 'proj-a', path: projA, graphPath: join(projA, 'graphify-out', 'graph.json') },
        { id: 'proj-b', name: 'proj-b', path: projB, graphPath: join(projB, 'graphify-out', 'graph.json') },
      ],
      mergedGraphPath: null,
      lastBuiltAt: null,
    }), 'utf-8');
  });
  afterEach(async () => { await rm(hub, { recursive: true, force: true }); });

  it('skips a project whose graph was never built — a merge must not surprise-index', async () => {
    const calls: string[] = [];
    const out = await queueMergeGraphRefresh(hub, projB, 'some-task', async (p) => { calls.push(p); });
    expect(out).toBe('never-built');
    expect(calls).toEqual([]);
  });

  it('queues a refresh for a project with an existing graph', async () => {
    const calls: string[] = [];
    const out = await queueMergeGraphRefresh(hub, projA, 'some-task', async (p) => { calls.push(p); });
    expect(out).toBe('queued');
    await new Promise((r) => setTimeout(r, 50)); // the queue runs it async
    expect(calls).toEqual([projA]);
  });

  it('reports when no kb project matches the merged repo', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'baton-elsewhere-'));
    try {
      expect(await queueMergeGraphRefresh(hub, outside, 'some-task', async () => {})).toBe('no-project');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
