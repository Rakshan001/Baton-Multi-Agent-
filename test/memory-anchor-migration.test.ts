// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listMemories, pruneUnclaimedAnchors, saveMemory } from '../src/memory.js';

/**
 * Fixing capture stops NEW facts being mis-anchored; it does nothing for the
 * ones already damaged. Measured on this repo: nine facts still carried
 * `.gitignore`, `AGENTS.md` and `CODEBASE.md` as evidence for claims that
 * mention none of them, so every one of them read as stale -- and `memory gc`
 * would have deleted them.
 *
 * This is the one-time repair: drop an anchor the fact has no textual claim to.
 * The fact keeps its text, its id and its authorship; it simply stops asserting
 * evidence it never had. Anchorless, it ages honestly on commit distance
 * instead of dying on somebody else's churn.
 */
describe('pruneUnclaimedAnchors — retroactive repair of anchors nothing claimed', () => {
  let root: string;
  const g = (args: string[]) => execa('git', args, { cwd: root });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-migrate-'));
    await mkdir(join(root, '.baton'), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await g(['init', '-q']);
    await g(['config', 'user.email', 't@t.t']);
    await g(['config', 'user.name', 'T']);
    await writeFile(join(root, '.gitignore'), 'node_modules\n');
    await writeFile(join(root, 'src', 'server.ts'), 'const GUARD = true;\n');
    await g(['add', '.']);
    await g(['commit', '-qm', 'init']);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const anchorsOf = async (id: string) =>
    (await listMemories(root)).find((f) => f.id === id)!.anchors.files.map((a) => a.path);

  it('drops an anchor the fact never mentions', async () => {
    const saved = await saveMemory(root, {
      fact: 'the full test suite is timing-sensitive on a loaded machine — run it with fewer workers',
      type: 'gotcha', files: ['.gitignore'],
    });
    const r = await pruneUnclaimedAnchors(root);
    expect(r.changed).toContain(saved.id);
    expect(await anchorsOf(saved.id)).toEqual([]);
  });

  it('keeps an anchor the fact does mention', async () => {
    const saved = await saveMemory(root, {
      fact: 'the GUARD constant in src/server.ts gates every mutating endpoint',
      type: 'convention', files: ['src/server.ts'],
    });
    const r = await pruneUnclaimedAnchors(root);
    expect(r.changed).not.toContain(saved.id);
    expect(await anchorsOf(saved.id)).toEqual(['src/server.ts']);
  });

  it('keeps only the claimed anchors when a fact has both kinds', async () => {
    const saved = await saveMemory(root, {
      fact: 'the GUARD constant in src/server.ts gates every mutating endpoint',
      type: 'convention', files: ['src/server.ts', '.gitignore'],
    });
    await pruneUnclaimedAnchors(root);
    expect(await anchorsOf(saved.id)).toEqual(['src/server.ts']);
  });

  it('reports without writing when asked to dry run', async () => {
    const saved = await saveMemory(root, {
      fact: 'the full test suite is timing-sensitive on a loaded machine — run it with fewer workers',
      type: 'gotcha', files: ['.gitignore'],
    });
    const r = await pruneUnclaimedAnchors(root, { dryRun: true });
    expect(r.changed).toContain(saved.id);
    // Untouched on disk: a migration over someone's knowledge must be previewable.
    expect(await anchorsOf(saved.id)).toEqual(['.gitignore']);
  });

  it('never changes a fact text, id or author', async () => {
    const saved = await saveMemory(root, {
      fact: 'the full test suite is timing-sensitive on a loaded machine — run it with fewer workers',
      type: 'gotcha', files: ['.gitignore'],
    });
    const before = (await listMemories(root)).find((f) => f.id === saved.id)!;
    await pruneUnclaimedAnchors(root);
    const after = (await listMemories(root)).find((f) => f.id === saved.id)!;
    expect(after.fact).toBe(before.fact);
    expect(after.id).toBe(before.id);
    expect(after.author).toBe(before.author);
    expect(after.type).toBe(before.type);
    expect(after.createdAt).toBe(before.createdAt);
  });

  it('keeps an anchor the fact names by concept rather than by filename', async () => {
    // Found by dry-running this on the real store: a fact reading "cross-process
    // agent locks go through tmux session names" was about to lose its
    // src/util/tmux.ts anchor, because it says "tmux" and not "tmux.ts".
    //
    // The asymmetry here is the OPPOSITE of capture's. Adding an anchor at
    // capture time risks false evidence, so capture is strict. Dropping one
    // here risks a fact that nothing can ever invalidate -- served as fresh
    // forever, however wrong the repo makes it -- so the migration must lean
    // toward keeping. Same question, different cost of being wrong.
    const saved = await saveMemory(root, {
      fact: 'cross-process agent locks go through tmux session names — in-memory maps see only their own process',
      type: 'convention', files: ['src/util/tmux.ts'],
    });
    const r = await pruneUnclaimedAnchors(root);
    expect(r.changed).not.toContain(saved.id);
    expect(await anchorsOf(saved.id)).toEqual(['src/util/tmux.ts']);
  });

  it('still drops an anchor whose stem the fact does not mention either', async () => {
    const saved = await saveMemory(root, {
      fact: 'the full test suite is timing-sensitive on a loaded machine — run it with fewer workers',
      type: 'gotcha', files: ['src/util/tmux.ts'],
    });
    expect((await pruneUnclaimedAnchors(root)).changed).toContain(saved.id);
    expect(await anchorsOf(saved.id)).toEqual([]);
  });

  it('is idempotent', async () => {
    await saveMemory(root, {
      fact: 'the full test suite is timing-sensitive on a loaded machine — run it with fewer workers',
      type: 'gotcha', files: ['.gitignore'],
    });
    await pruneUnclaimedAnchors(root);
    expect((await pruneUnclaimedAnchors(root)).changed).toEqual([]);
  });

  it('deletes nothing, ever', async () => {
    await saveMemory(root, {
      fact: 'the full test suite is timing-sensitive on a loaded machine — run it with fewer workers',
      type: 'gotcha', files: ['.gitignore'],
    });
    const countBefore = (await listMemories(root)).length;
    await pruneUnclaimedAnchors(root);
    expect((await listMemories(root)).length).toBe(countBefore);
  });

  it('brings a spuriously-anchored fact back from stale', async () => {
    // The whole point, end to end.
    const saved = await saveMemory(root, {
      fact: 'the full test suite is timing-sensitive on a loaded machine — run it with fewer workers',
      type: 'gotcha', files: ['.gitignore'],
    });
    await writeFile(join(root, '.gitignore'), 'node_modules\ndist\n');
    await g(['commit', '-qam', 'unrelated gitignore change']);
    expect((await listMemories(root)).find((f) => f.id === saved.id)!.freshness).toBe('stale');

    await pruneUnclaimedAnchors(root);
    expect((await listMemories(root)).find((f) => f.id === saved.id)!.freshness).not.toBe('stale');
  });
});
