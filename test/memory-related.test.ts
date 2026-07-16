import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { saveMemory, recallMemories } from '../src/memory.js';

/**
 * The memory "graph" done the token-optimal way: memories anchored to the same
 * files ARE related — the edges already exist in the anchor data, no graph
 * construction cost (the Zep/Graphiti approach spends ~600k tokens building a
 * temporal graph per conversation; this spends zero). Keyword recall misses a
 * fact whose TEXT doesn't mention the topic; shared anchors recover it.
 */
describe('recallMemories — related facts via shared anchors', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-memrel-'));
    const g = (args: string[]) => execa('git', args, { cwd: root });
    await g(['init', '-q']);
    await g(['config', 'user.email', 't@t.t']);
    await g(['config', 'user.name', 'T']);
    await mkdir(join(root, 'src', 'auth'), { recursive: true });
    await mkdir(join(root, 'src', 'reports'), { recursive: true });
    await writeFile(join(root, 'src', 'auth', 'token.ts'), 'export const x = 1;\n');
    await writeFile(join(root, 'src', 'auth', 'refresh.ts'), 'export const y = 2;\n');
    await writeFile(join(root, 'src', 'reports', 'csv.ts'), 'export const z = 3;\n');
    await g(['add', '.']);
    await g(['commit', '-qm', 'init']);

    await saveMemory(root, {
      fact: 'Token expiry uses a 5-minute clock-skew allowance for mobile clients.',
      type: 'decision', files: ['src/auth/token.ts'],
    });
    await saveMemory(root, {
      // Deliberately does NOT contain the word "expiry" — only reachable via the shared anchor.
      fact: 'The refresh flow revalidates the session against src/auth/token.ts on every rotation.',
      type: 'gotcha', files: ['src/auth/token.ts', 'src/auth/refresh.ts'],
    });
    await saveMemory(root, {
      fact: 'CSV export streams rows; never buffer the whole report in memory.',
      type: 'convention', files: ['src/reports/csv.ts'],
    });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('surfaces anchor-related facts that keyword scoring missed', async () => {
    const r = await recallMemories(root, { topic: 'expiry clock skew' });
    expect(r.facts.some((f) => f.fact.includes('clock-skew'))).toBe(true);
    // The refresh fact shares the token.ts anchor but not the topic words.
    expect(r.facts.some((f) => f.fact.includes('refresh flow'))).toBe(false);
    expect(r.related?.some((f) => f.fact.includes('refresh flow'))).toBe(true);
    // The CSV fact shares nothing — must not ride along.
    expect(r.related?.some((f) => f.fact.includes('CSV'))).toBeFalsy();
  });

  it('caps related facts and never duplicates already-recalled ones', async () => {
    const r = await recallMemories(root, { topic: 'expiry clock skew' });
    expect((r.related ?? []).length).toBeLessThanOrEqual(3);
    const ids = new Set(r.facts.map((f) => f.id));
    for (const rel of r.related ?? []) expect(ids.has(rel.id)).toBe(false);
  });

  it('adds no related section without a topic (plain listing stays lean)', async () => {
    const r = await recallMemories(root, {});
    expect(r.related ?? []).toEqual([]);
  });
});
