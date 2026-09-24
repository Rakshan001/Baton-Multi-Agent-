// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The read-path mtime cache (`cachedNewestMtimeIn`, src/liveness.ts).
 *
 * `collectWorktrees` walks every worktree synchronously for its newest mtime,
 * and it runs per dashboard tab every 5s and per MCP `list_worktrees`. The
 * cache lets those READ paths reuse one walk for a while. Pinned with an
 * injected clock and walker, so nothing here depends on wall time:
 *
 *  - within the window, one walk; past it, a fresh one;
 *  - each entry's window is staggered, so entries inserted together do not
 *    all come due in one synchronous burst;
 *  - expired entries are evicted on insert, so the map never grows past the
 *    worktrees still being read;
 *  - `livenessProbe` without the opt is UNCACHED — the decision paths
 *    (takeover, claim, next, snapshot) must never act on a reused walk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cachedNewestMtimeIn, clearMtimeCache, livenessProbe, MTIME_TTL_MS, mtimeCacheSize,
} from '../src/liveness.js';
import type { PipelineTask } from '../src/pipeline.js';

beforeEach(() => clearMtimeCache());
afterEach(() => clearMtimeCache());

function counter(value = 42): { walk: (dir: string) => number; calls: string[] } {
  const calls: string[] = [];
  return { calls, walk: (dir: string) => { calls.push(dir); return value; } };
}

describe('cachedNewestMtimeIn', () => {
  it('walks once inside the window and again once it has passed', () => {
    let t = 1_000_000;
    const clock = () => t;
    const { walk, calls } = counter();
    expect(cachedNewestMtimeIn('/wt/a', clock, walk)).toBe(42);
    t += MTIME_TTL_MS / 2 - 1;           // the shortest window any entry gets
    expect(cachedNewestMtimeIn('/wt/a', clock, walk)).toBe(42);
    expect(calls).toHaveLength(1);
    t += MTIME_TTL_MS;                   // past the longest window
    cachedNewestMtimeIn('/wt/a', clock, walk);
    expect(calls).toHaveLength(2);
  });

  it('never serves an entry older than MTIME_TTL_MS', () => {
    let t = 5_000_000;
    const clock = () => t;
    const { walk, calls } = counter();
    const dirs = Array.from({ length: 20 }, (_, i) => `/wt/${i}`);
    for (const d of dirs) cachedNewestMtimeIn(d, clock, walk);
    t += MTIME_TTL_MS;
    for (const d of dirs) cachedNewestMtimeIn(d, clock, walk);
    expect(calls).toHaveLength(40);
  });

  it('staggers expiry, so entries inserted together do not all expire together', () => {
    let t = 9_000_000;
    const clock = () => t;
    const { walk, calls } = counter();
    const dirs = Array.from({ length: 20 }, (_, i) => `/wt/${i}`);
    for (const d of dirs) cachedNewestMtimeIn(d, clock, walk);
    t += Math.floor(MTIME_TTL_MS * 0.75);
    for (const d of dirs) cachedNewestMtimeIn(d, clock, walk);
    const rewalked = calls.length - dirs.length;
    expect(rewalked).toBeGreaterThan(0);
    expect(rewalked).toBeLessThan(dirs.length);
  });

  it('evicts expired entries when it inserts', () => {
    let t = 2_000_000;
    const clock = () => t;
    const { walk } = counter();
    cachedNewestMtimeIn('/wt/gone-1', clock, walk);
    cachedNewestMtimeIn('/wt/gone-2', clock, walk);
    expect(mtimeCacheSize()).toBe(2);
    t += MTIME_TTL_MS;
    cachedNewestMtimeIn('/wt/new', clock, walk);
    expect(mtimeCacheSize()).toBe(1);
  });

  it('keys by directory', () => {
    const { walk, calls } = counter();
    cachedNewestMtimeIn('/wt/a', () => 1, walk);
    cachedNewestMtimeIn('/wt/b', () => 1, walk);
    expect(calls).toEqual(['/wt/a', '/wt/b']);
  });
});

describe('livenessProbe stays uncached by default', () => {
  let root: string;
  let wt: string;

  beforeEach(async () => {
    root = realpathSync(await mkdtemp(join(tmpdir(), 'baton-mtime-')));
    wt = join(root, 'wt');
    await mkdir(wt);
    await writeFile(join(wt, 'x.ts'), 'x\n', 'utf-8');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('walks the worktree itself even when the read-path cache holds a stale answer', () => {
    expect(cachedNewestMtimeIn(wt, Date.now, () => 0)).toBe(0);   // stale "nothing written"
    const t = { slug: 's', state: 'active', worktreePath: wt, baseCommit: 'abc' } as unknown as PipelineTask;
    expect(livenessProbe(root)(t)).toBeGreaterThan(0);
  });

  it('uses the walker it is handed, called with the directory alone', () => {
    const { walk, calls } = counter(7);
    const t = { slug: 's', state: 'active', worktreePath: wt, baseCommit: 'abc' } as unknown as PipelineTask;
    expect(livenessProbe(root, { mtime: walk })(t)).toBe(7);
    expect(calls).toEqual([wt]);
  });
});
