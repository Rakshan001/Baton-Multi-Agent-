import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import {
  recallRows, RECALL_FULL_BODIES, recallMemories, saveMemory, type MemoryStatus,
} from '../src/memory.js';

/**
 * M2 — progressive-disclosure recall (the claude-mem 3-layer pattern): serve a
 * compact index (~50–100 tokens/row) with full bodies for only the top hits;
 * the agent hydrates the rest by id. Cuts the read path ~10x without losing
 * anything — the full fact is one call away.
 */

const mkStatus = (id: string, fact: string, over: Partial<MemoryStatus> = {}): MemoryStatus => ({
  id,
  type: 'decision',
  fact,
  agent: null,
  task: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  anchors: { commit: null, files: [{ path: 'src/a.ts', hash: 'x' }] },
  supersedes: null,
  fingerprint: 'f',
  freshness: 'fresh',
  staleReason: null,
  commitsBehind: 0,
  project: null,
  ...over,
});

const LONG = 'The CSRF origin guard gates every mutating endpoint centrally in the request router.\nSecond line with much more detail about implementation specifics that should never appear in a preview row because previews are single-line.';

describe('recallRows (pure serving shape)', () => {
  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => mkStatus(id, `${id}: ${LONG}`));

  it(`serves full bodies for the top ${RECALL_FULL_BODIES}, compact previews after`, () => {
    const rows = recallRows(six);
    for (const row of rows.slice(0, RECALL_FULL_BODIES)) {
      expect(row.fact).toContain('Second line');
      expect(row.preview).toBeUndefined();
    }
    for (const row of rows.slice(RECALL_FULL_BODIES)) {
      expect(row.fact).toBeUndefined();
      expect(row.preview).toBeDefined();
      expect(row.preview!.length).toBeLessThanOrEqual(140);
      expect(row.preview).not.toContain('\n');
    }
  });

  it('preview rows keep id, type, freshness, and anchor paths (enough to judge relevance)', () => {
    const row = recallRows(six)[RECALL_FULL_BODIES];
    expect(row.id).toBeDefined();
    expect(row.type).toBe('decision');
    expect(row.freshness).toBe('fresh');
    expect(row.files).toContain('src/a.ts');
  });

  it('serves everything full when there are few facts (no pointless indirection)', () => {
    const rows = recallRows(six.slice(0, 2));
    expect(rows.every((r) => r.fact && !r.preview)).toBe(true);
  });
});

describe('recallMemories({ ids }) — hydrate by id', () => {
  let root: string;
  let savedId: string;
  let staleId: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-memdisc-'));
    const g = (args: string[]) => execa('git', args, { cwd: root });
    await g(['init', '-q']);
    await g(['config', 'user.email', 't@t.t']);
    await g(['config', 'user.name', 'T']);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'guard.ts'), 'export const g = 1;\n');
    await writeFile(join(root, 'src', 'other.ts'), 'export const o = 1;\n');
    await g(['add', '.']);
    await g(['commit', '-qm', 'init']);
    savedId = (await saveMemory(root, {
      fact: 'The origin guard gates every mutating endpoint centrally.',
      type: 'convention', files: ['src/guard.ts'],
    })).id;
    staleId = (await saveMemory(root, {
      fact: 'This fact will go stale when its anchor changes underneath it.',
      type: 'gotcha', files: ['src/other.ts'],
    })).id;
    // Invalidate the second fact's anchor.
    await writeFile(join(root, 'src', 'other.ts'), 'export const o = 2;\n');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns full bodies for exactly the requested ids', async () => {
    const r = await recallMemories(root, { ids: [savedId] });
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0].id).toBe(savedId);
    expect(r.facts[0].fact).toContain('origin guard');
  });

  it('a stale requested id is withheld WITH its reason, never served as truth', async () => {
    const all = await recallMemories(root, {});
    expect(all.facts.map((f) => f.id)).not.toContain(staleId);
    const r = await recallMemories(root, { ids: [staleId] });
    expect(r.facts).toHaveLength(0);
    expect(r.withheld?.[0]?.id).toBe(staleId);
    expect(r.withheld?.[0]?.reason).toMatch(/changed/);
  });

  it('an unknown id is reported, not silently dropped', async () => {
    const r = await recallMemories(root, { ids: ['mem-does-not-exist'] });
    expect(r.withheld?.some((w) => w.id === 'mem-does-not-exist' && /no such/i.test(w.reason))).toBe(true);
  });
});
