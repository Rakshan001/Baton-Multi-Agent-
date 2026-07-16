import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import {
  extractVerifiableTerms, repairMemories, listMemories, readJournal,
  recallMemories, saveMemory,
} from '../src/memory.js';

/**
 * M3 — the stale-repair queue. Before: a changed anchor file made the fact
 * stale forever and `gc` DELETED it — even when the fact was still true (the
 * #1 knowledge-loss bug). Now: if the fact's verifiable terms (backticked
 * spans, identifiers, paths) all survive the change, the anchors are refreshed
 * mechanically; otherwise the fact is queued for review instead of destroyed.
 */

describe('extractVerifiableTerms', () => {
  it('extracts backticked spans, identifiers, and paths', () => {
    const t = extractVerifiableTerms(
      'The `ORIGIN_GUARD` check in src/server.ts calls gitRoot() and reads retention.json.',
    );
    expect(t).toContain('ORIGIN_GUARD');
    expect(t).toContain('src/server.ts');
    expect(t).toContain('gitRoot');
    expect(t).toContain('retention.json');
  });

  it('extracts nothing from plain prose (unverifiable — must go to review)', () => {
    expect(extractVerifiableTerms('Exports stream rows and never buffer reports fully.')).toEqual([]);
  });

  it('ignores hyphenated prose like zero-dependency and cross-origin', () => {
    const t = extractVerifiableTerms('The daemon is zero-dependency and blocks cross-origin posts.');
    expect(t).not.toContain('zero-dependency');
    expect(t).not.toContain('cross-origin');
  });
});

describe('repairMemories (real temp git repo)', () => {
  let root: string;
  const g = (args: string[]) => execa('git', args, { cwd: root });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-memrepair-'));
    await g(['init', '-q']);
    await g(['config', 'user.email', 't@t.t']);
    await g(['config', 'user.name', 'T']);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'server.ts'), 'export const ORIGIN_GUARD = true;\n');
    await g(['add', '.']);
    await g(['commit', '-qm', 'init']);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('re-anchors a stale fact whose verifiable terms survived the change', async () => {
    const saved = await saveMemory(root, {
      fact: 'The `ORIGIN_GUARD` constant gates every mutating endpoint in src/server.ts.',
      type: 'convention', files: ['src/server.ts'],
    });
    // The file changes, but ORIGIN_GUARD survives — the fact is still true.
    await writeFile(join(root, 'src', 'server.ts'), '// hardened\nexport const ORIGIN_GUARD = true;\n');
    expect((await listMemories(root)).find((f) => f.id === saved.id)?.freshness).toBe('stale');

    const r = await repairMemories(root);
    expect(r.reanchored).toContain(saved.id);
    expect(r.needsReview).not.toContain(saved.id);
    expect((await listMemories(root)).find((f) => f.id === saved.id)?.freshness).not.toBe('stale');
    expect((await readJournal(root)).some((e) => e.op === 'reanchor' && e.id === saved.id)).toBe(true);
  });

  it('a renamed identifier does NOT count as survival (no substring false-pass)', async () => {
    const saved = await saveMemory(root, {
      fact: 'The `ORIGIN_GUARD` constant gates every mutating endpoint.',
      type: 'convention', files: ['src/server.ts'],
    });
    // ORIGIN_GUARD is gone; ORIGIN_GUARD_V2 contains it as a substring.
    await writeFile(join(root, 'src', 'server.ts'), 'export const ORIGIN_GUARD_V2 = true;\n');
    const r = await repairMemories(root);
    expect(r.needsReview).toContain(saved.id);
    expect(r.reanchored).not.toContain(saved.id);
  });

  it('queues for review when a verifiable term did NOT survive (fact may be false)', async () => {
    const saved = await saveMemory(root, {
      fact: 'The `ORIGIN_GUARD` constant gates every mutating endpoint.',
      type: 'convention', files: ['src/server.ts'],
    });
    await writeFile(join(root, 'src', 'server.ts'), 'export const originCheck = true;\n');
    const r = await repairMemories(root);
    expect(r.needsReview).toContain(saved.id);
    expect(r.reanchored).not.toContain(saved.id);
    expect((await listMemories(root)).find((f) => f.id === saved.id)?.freshness).toBe('stale');
  });

  it('queues plain-prose facts for review (nothing mechanical to verify)', async () => {
    const saved = await saveMemory(root, {
      fact: 'Exports stream rows and never buffer whole reports in process memory.',
      type: 'convention', files: ['src/server.ts'],
    });
    await writeFile(join(root, 'src', 'server.ts'), 'export const ORIGIN_GUARD = false;\n');
    const r = await repairMemories(root);
    expect(r.needsReview).toContain(saved.id);
  });

  it('queues for review when an anchored file was deleted, even if terms match elsewhere', async () => {
    await writeFile(join(root, 'src', 'other.ts'), 'export const ORIGIN_GUARD = true;\n');
    const saved = await saveMemory(root, {
      fact: 'The `ORIGIN_GUARD` constant is defined in both files.',
      type: 'convention', files: ['src/server.ts', 'src/other.ts'],
    });
    await unlink(join(root, 'src', 'other.ts'));
    const r = await repairMemories(root);
    expect(r.needsReview).toContain(saved.id);
    expect(r.reanchored).not.toContain(saved.id);
  });
});

describe('recall surfaces one opportunistic review request', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-memreview-'));
    const g = (args: string[]) => execa('git', args, { cwd: root });
    await g(['init', '-q']);
    await g(['config', 'user.email', 't@t.t']);
    await g(['config', 'user.name', 'T']);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'auth.ts'), 'export const a = 1;\n');
    await g(['add', '.']);
    await g(['commit', '-qm', 'init']);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('a stale fact sharing anchors with the hits is offered for review, not served', async () => {
    await saveMemory(root, {
      fact: 'Auth tokens rotate on every session refresh to limit replay.',
      type: 'gotcha', files: ['src/auth.ts'],
    });
    const stale = await saveMemory(root, {
      fact: 'Auth uses a legacy allowlist for trusted callers during rollout.',
      type: 'decision', files: ['src/auth.ts'],
    });
    // First fact must stay fresh, second must go stale: re-anchor the fresh one
    // is impossible per-file (same anchor), so make the stale one file-specific.
    // Instead: both share src/auth.ts — change it, then re-save the first fact
    // so it is freshly anchored while the second stays stale.
    await writeFile(join(root, 'src', 'auth.ts'), 'export const a = 2;\n');
    await saveMemory(root, {
      fact: 'Auth tokens rotate on every session refresh to limit replay.',
      type: 'gotcha', files: ['src/auth.ts'],
    });

    const r = await recallMemories(root, { topic: 'auth rotation' });
    expect(r.facts.map((f) => f.id)).not.toContain(stale.id);
    expect(r.review?.id).toBe(stale.id);
    expect(r.review?.reason).toMatch(/changed/);
    expect(r.review?.preview).toContain('legacy allowlist');
  });

  it('no review request when nothing stale touches the topic files', async () => {
    await saveMemory(root, {
      fact: 'Auth tokens rotate on every session refresh to limit replay.',
      type: 'gotcha', files: ['src/auth.ts'],
    });
    const r = await recallMemories(root, { topic: 'auth rotation' });
    expect(r.review).toBeUndefined();
  });
});
