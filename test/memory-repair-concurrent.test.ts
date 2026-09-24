// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { saveMemory, repairMemories, removeMemory, supersedeMemory } from '../src/memory.js';

/**
 * Repair runs from three places inside ONE daemon process: the periodic sweep,
 * the recall-time pass (maybeRepairOnRecall), and POST /api/memory/repair.
 * They can overlap, so the atomic write-then-rename must survive two passes
 * touching the same fact at once. Keying the temp file on process.pid alone
 * does not: same process = same name = the second rename hits ENOENT and the
 * endpoint 500s.
 */
describe('repairMemories (concurrent passes in one process)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-repair-race-'));
    await execa('git', ['init', '-q'], { cwd: root });
    await execa('git', ['config', 'user.email', 't@t.test'], { cwd: root });
    await execa('git', ['config', 'user.name', 'T'], { cwd: root });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'server.ts'), 'export const ORIGIN_GUARD = false;\n');
    await execa('git', ['add', '-A'], { cwd: root });
    await execa('git', ['commit', '-qm', 'init'], { cwd: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('never loses a rename race when two repairs overlap on the same fact', async () => {
    const fact = await saveMemory(root, {
      fact: 'The `ORIGIN_GUARD` constant gates every mutating endpoint in src/server.ts.',
      type: 'convention',
      files: ['src/server.ts'],
    });

    // Go stale on an edit that misses the line the fact is about, so both
    // passes decide this fact is mechanically re-anchorable. (This used to flip
    // false → true; repair no longer refreshes a fact when the change lands on
    // a line the fact names. The subject here is the rename race, not that
    // judgement.)
    await writeFile(join(root, 'src', 'server.ts'), '// hardened\nexport const ORIGIN_GUARD = false;\n');

    // Two passes at once — exactly what the sweep + the endpoint do.
    const results = await Promise.allSettled([repairMemories(root), repairMemories(root)]);

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected.map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);

    // At least one pass must claim the re-anchor; neither may throw.
    const reanchored = results
      .flatMap((r) => (r.status === 'fulfilled' ? r.value.reanchored : []));
    expect(reanchored).toContain(fact.id);
  });
});

/**
 * The same shape one level down. `archiveFact` — the single retire path behind
 * `removeMemory`, `supersedeMemory` and the consolidation pass — checked the
 * file's existence and THEN renamed it. Two retire calls in flight (a daemon
 * consolidation tick and a manual `baton memory consolidate`) both pass the
 * check, and the loser's rename throws ENOENT: `consolidateOnce` aborts to
 * `failed` mid-plan with no stamp written, and the CLI reports nothing about
 * the facts it had already archived. Its own contract says "returns false if
 * the file was already gone (idempotent)" — so ENOENT from the rename is that
 * false, and nothing else is swallowed.
 */
describe('archiveFact (two retires racing on one fact)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-archive-race-'));
    await execa('git', ['init', '-q'], { cwd: root });
    await execa('git', ['config', 'user.email', 't@t.test'], { cwd: root });
    await execa('git', ['config', 'user.name', 'T'], { cwd: root });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'server.ts'), 'export const ORIGIN_GUARD = false;\n');
    await execa('git', ['add', '-A'], { cwd: root });
    await execa('git', ['commit', '-qm', 'init'], { cwd: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('the losing remove returns false instead of throwing ENOENT', async () => {
    const fact = await saveMemory(root, {
      fact: 'The `ORIGIN_GUARD` constant gates every mutating endpoint in src/server.ts.',
      type: 'convention',
      files: ['src/server.ts'],
    });

    const results = await Promise.allSettled([
      removeMemory(root, fact.id, 'pass A'),
      removeMemory(root, fact.id, 'pass B'),
    ]);

    expect(results.map((r) => (r.status === 'rejected' ? String((r as PromiseRejectedResult).reason) : 'ok')))
      .toEqual(['ok', 'ok']);
    // Exactly one winner — the other saw it already gone.
    expect((results as PromiseFulfilledResult<boolean>[]).map((r) => r.value).sort())
      .toEqual([false, true]);
  });

  it('a fact vanishing between the existence check and the rename is "already gone", not an error', async () => {
    const fact = await saveMemory(root, {
      fact: 'The `ORIGIN_GUARD` constant gates every mutating endpoint in src/server.ts.',
      type: 'convention',
      files: ['src/server.ts'],
    });

    // supersede and remove share the one retire path, so racing the two covers
    // the consolidation tick vs. the manual pass exactly.
    const results = await Promise.allSettled([
      supersedeMemory(root, fact.id, 'newer-fact', 'consolidation tick'),
      removeMemory(root, fact.id, 'manual pass'),
    ]);

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected.map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    expect((results as PromiseFulfilledResult<boolean>[]).map((r) => r.value).sort())
      .toEqual([false, true]);
  });

  it('still propagates an error that is NOT "already gone"', async () => {
    const fact = await saveMemory(root, {
      fact: 'The `ORIGIN_GUARD` constant gates every mutating endpoint in src/server.ts.',
      type: 'convention',
      files: ['src/server.ts'],
    });

    // A directory where the archive file must be written: the rename fails with
    // EISDIR/ENOTEMPTY/EPERM, never ENOENT. Swallowing that would lose the fact
    // silently and report success, which is the bug in the other direction.
    await mkdir(join(root, '.baton', 'memory', 'archive', `${fact.id}.md`), { recursive: true });
    await writeFile(join(root, '.baton', 'memory', 'archive', `${fact.id}.md`, 'occupied'), 'x');

    await expect(removeMemory(root, fact.id, 'manual pass')).rejects.toThrow();
  });
});
