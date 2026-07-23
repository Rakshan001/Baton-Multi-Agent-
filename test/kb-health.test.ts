import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditKb, KB_STALE_DAYS } from '../src/kb/health.js';
import { kbFile, graphPathFor, type KbState } from '../src/kb/state.js';

let root: string;
const NOW = new Date('2026-07-22T00:00:00Z');

async function writeKb(state: Partial<KbState>): Promise<void> {
  const file = kbFile(root);
  await mkdir(join(root, '.baton'), { recursive: true });
  await writeFile(file, JSON.stringify({ root, projects: [], mergedGraphPath: null, lastBuiltAt: null, ...state }, null, 2));
}

/** A project dir that passes every check: real dir, real graph file. */
async function healthyProject(id: string) {
  const path = join(root, id);
  await mkdir(join(path, 'graphify-out'), { recursive: true });
  await writeFile(graphPathFor(path), '{}');
  return { id, name: id, path, graphPath: graphPathFor(path) };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'baton-kbh-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('auditKb', () => {
  it('reports a healthy KB as clean', async () => {
    await writeKb({ projects: [await healthyProject('api')], lastBuiltAt: NOW.toISOString() });
    expect(await auditKb(root, NOW)).toEqual([]);
  });

  it('treats a missing kb.json as info, not a failure', async () => {
    const [f] = await auditKb(root, NOW);
    expect(f.level).toBe('info');
    expect(f.message).toMatch(/no knowledge base/);
  });

  it('flags a kb.json built for a different repo', async () => {
    await writeKb({ root: '/somewhere/else/baton', projects: [await healthyProject('api')], lastBuiltAt: NOW.toISOString() });
    const errs = (await auditKb(root, NOW)).filter((f) => f.level === 'error');
    expect(errs.some((f) => /different repo/.test(f.message))).toBe(true);
  });

  it('flags a project pointing outside the repo — the failure that went unnoticed', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'baton-outside-'));
    await writeKb({
      projects: [{ id: 'baton', name: 'baton', path: outside, graphPath: graphPathFor(outside) }],
      lastBuiltAt: NOW.toISOString(),
    });
    const errs = (await auditKb(root, NOW)).filter((f) => f.level === 'error');
    expect(errs.some((f) => /points outside this repo/.test(f.message))).toBe(true);
    await rm(outside, { recursive: true, force: true });
  });

  it('flags a project whose directory is gone', async () => {
    await writeKb({
      projects: [{ id: 'api', name: 'api', path: join(root, 'api'), graphPath: graphPathFor(join(root, 'api')) }],
      lastBuiltAt: NOW.toISOString(),
    });
    expect((await auditKb(root, NOW))[0].message).toMatch(/not a directory/);
  });

  it('flags a project whose graph file is missing', async () => {
    const path = join(root, 'api');
    await mkdir(path, { recursive: true });
    await writeKb({ projects: [{ id: 'api', name: 'api', path, graphPath: graphPathFor(path) }], lastBuiltAt: NOW.toISOString() });
    const errs = await auditKb(root, NOW);
    expect(errs[0].message).toMatch(/no graph on disk/);
    expect(errs[0].fix).toBe('baton kb rebuild');
  });

  it('flags an empty project list', async () => {
    await writeKb({ projects: [], lastBuiltAt: NOW.toISOString() });
    expect((await auditKb(root, NOW)).some((f) => /lists no projects/.test(f.message))).toBe(true);
  });

  it('flags a missing merged graph', async () => {
    await writeKb({
      projects: [await healthyProject('api')],
      mergedGraphPath: join(root, '.baton', 'kb', 'merged-graph.json'),
      lastBuiltAt: NOW.toISOString(),
    });
    expect((await auditKb(root, NOW)).some((f) => /merged graph is missing/.test(f.message))).toBe(true);
  });

  it('reports staleness as a warning, not an error', async () => {
    const old = new Date(NOW.getTime() - (KB_STALE_DAYS + 11) * 86_400_000);
    await writeKb({ projects: [await healthyProject('api')], lastBuiltAt: old.toISOString() });
    const [f] = await auditKb(root, NOW);
    expect(f.level).toBe('warn');
    expect(f.message).toMatch(/41 days ago/);
  });

  it('does not warn about a graph built just under the threshold', async () => {
    const recent = new Date(NOW.getTime() - (KB_STALE_DAYS - 1) * 86_400_000);
    await writeKb({ projects: [await healthyProject('api')], lastBuiltAt: recent.toISOString() });
    expect(await auditKb(root, NOW)).toEqual([]);
  });

  it('reports an unreadable kb.json as an error and does not throw', async () => {
    await mkdir(join(root, '.baton'), { recursive: true });
    await writeFile(kbFile(root), '{ torn');
    const [f] = await auditKb(root, NOW);
    expect(f.level).toBe('error');
    expect(f.message).toMatch(/unreadable/);
  });

  it('survives a kb.json whose projects field is not an array', async () => {
    await mkdir(join(root, '.baton'), { recursive: true });
    await writeFile(kbFile(root), JSON.stringify({ root, projects: 'nope', lastBuiltAt: null }));
    const out = await auditKb(root, NOW);
    expect(out.some((f) => /lists no projects/.test(f.message))).toBe(true);
  });
});
