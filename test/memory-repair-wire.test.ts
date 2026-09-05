// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gcMemories, listMemories, repairMemories, saveMemory } from '../src/memory.js';

/**
 * M3, wired. `repairMemories` already re-anchored a stale fact when its
 * verifiable terms still appeared in the file. That test is too weak: a term
 * SURVIVING is not the same as the fact still being true. `CSRF_GUARD = true`
 * flipping to `CSRF_GUARD = false` leaves the term intact and the fact wrong,
 * and re-anchoring it serves a false claim to every later session as verified
 * truth -- the one failure this whole subsystem exists to prevent.
 *
 * assessAnchor compares what CHANGED against what the fact is about, so it
 * catches the flip.
 */
describe('repair + gc — a refreshed fact must still be true', () => {
  let root: string;
  const g = (args: string[]) => execa('git', args, { cwd: root });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-repair-'));
    await mkdir(join(root, '.baton'), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await g(['init', '-q']);
    await g(['config', 'user.email', 't@t.t']);
    await g(['config', 'user.name', 'T']);
    await writeFile(join(root, 'src', 'server.ts'), 'const CSRF_GUARD = true;\nfunction other() { return 1; }\n');
    await g(['add', '.']);
    await g(['commit', '-qm', 'init']);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const factOf = async (id: string) => (await listMemories(root)).find((f) => f.id === id)!;

  it('refuses to re-anchor when the change contradicts the fact', async () => {
    const saved = await saveMemory(root, {
      fact: 'CSRF_GUARD is enabled in src/server.ts — the guard is central, never per-endpoint',
      type: 'convention', files: ['src/server.ts'],
    });
    // The term survives; the value it asserts does not.
    await writeFile(join(root, 'src', 'server.ts'), 'const CSRF_GUARD = false;\nfunction other() { return 1; }\n');
    await g(['commit', '-qam', 'flip the guard']);

    expect((await factOf(saved.id)).freshness).toBe('stale');
    const r = await repairMemories(root);
    expect(r.reanchored).not.toContain(saved.id);
    expect(r.needsReview).toContain(saved.id);
    expect((await factOf(saved.id)).freshness).toBe('stale');
  });

  it('re-anchors when the change missed what the fact is about', async () => {
    const saved = await saveMemory(root, {
      fact: 'CSRF_GUARD is enabled in src/server.ts — the guard is central, never per-endpoint',
      type: 'convention', files: ['src/server.ts'],
    });
    await writeFile(join(root, 'src', 'server.ts'), 'const CSRF_GUARD = true;\nfunction other() { return 99; }\n');
    await g(['commit', '-qam', 'unrelated edit']);

    expect((await factOf(saved.id)).freshness).toBe('stale');
    const r = await repairMemories(root);
    expect(r.reanchored).toContain(saved.id);
    expect((await factOf(saved.id)).freshness).not.toBe('stale');
  });

  it('gc does not delete a fact the repair check can still justify', async () => {
    // gc removes facts whose anchors changed. Combined with the anchor bug this
    // deleted CORRECT facts, so gc must repair before it prunes.
    const saved = await saveMemory(root, {
      fact: 'CSRF_GUARD is enabled in src/server.ts — the guard is central, never per-endpoint',
      type: 'convention', files: ['src/server.ts'],
    });
    await writeFile(join(root, 'src', 'server.ts'), 'const CSRF_GUARD = true;\nfunction other() { return 99; }\n');
    await g(['commit', '-qam', 'unrelated edit']);

    const removed = await gcMemories(root);
    expect(removed).not.toContain(saved.id);
    expect(await factOf(saved.id)).toBeDefined();
  });

  it('gc still removes a fact whose evidence genuinely moved', async () => {
    const saved = await saveMemory(root, {
      fact: 'CSRF_GUARD is enabled in src/server.ts — the guard is central, never per-endpoint',
      type: 'convention', files: ['src/server.ts'],
    });
    await writeFile(join(root, 'src', 'server.ts'), 'const CSRF_GUARD = false;\n');
    await g(['commit', '-qam', 'flip']);
    expect(await gcMemories(root)).toContain(saved.id);
  });

  it('declines to refresh a value change even when the fact may still be true', async () => {
    // The deliberate cost of the strictness above, recorded rather than hidden.
    //
    // "MAX_RETRIES lives in config.ts" survives 3 -> 5; "CSRF_GUARD is enabled"
    // does not survive true -> false. Same shape, opposite answers, and the
    // difference is semantic -- which is exactly what a mechanical pass cannot
    // read. So a change landing ON a line the fact names is treated as
    // undecidable and left for review.
    //
    // The asymmetry runs this way on purpose: a withheld-but-true fact costs
    // one re-derivation, while a refreshed-but-false one is served to every
    // later session as verified truth. If this proves too strict in practice,
    // the place to loosen it is assessAnchor -- not by deleting this test.
    const saved = await saveMemory(root, {
      fact: 'the ORIGIN_GUARD constant in src/server.ts gates every mutating endpoint',
      type: 'convention', files: ['src/server.ts'],
    });
    await writeFile(join(root, 'src', 'server.ts'), 'const ORIGIN_GUARD = 2;\nfunction other() { return 1; }\n');
    await g(['commit', '-qam', 'change the guard value']);

    const r = await repairMemories(root);
    expect(r.reanchored).not.toContain(saved.id);
    expect(r.needsReview).toContain(saved.id);
  });

  it('reports what it would remove without removing it', async () => {
    const saved = await saveMemory(root, {
      fact: 'CSRF_GUARD is enabled in src/server.ts — the guard is central, never per-endpoint',
      type: 'convention', files: ['src/server.ts'],
    });
    await writeFile(join(root, 'src', 'server.ts'), 'const CSRF_GUARD = false;\n');
    await g(['commit', '-qam', 'flip']);

    expect(await gcMemories(root, { dryRun: true })).toContain(saved.id);
    // Still there: a dry run reports, it does not delete.
    expect(await factOf(saved.id)).toBeDefined();
  });
});
