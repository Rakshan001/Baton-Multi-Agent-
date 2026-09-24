// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The global git limiter (src/util/exec.ts). Every git spawn goes through one
 * FIFO queue, so a poll tick over N worktrees never runs more than
 * GIT_MAX_CONCURRENT processes at once. Pinned here without git: the cap, the
 * start order, and that a failing job — async or synchronous — gives its slot
 * back. A leaked slot would slowly wedge every git call in the daemon.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLimiter, git, gitTry, GIT_MAX_CONCURRENT } from '../src/util/exec.js';

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let every queued microtask run, so a released slot has been handed on. */
const settle = () => new Promise<void>((r) => setImmediate(r));

describe('createLimiter', () => {
  it('caps at 8 for git', () => {
    expect(GIT_MAX_CONCURRENT).toBe(8);
  });

  it('never runs more than `max` at once, and starts jobs in FIFO order', async () => {
    const limit = createLimiter(2);
    const gates = Array.from({ length: 6 }, deferred);
    const started: number[] = [];
    let active = 0;
    let peak = 0;
    const runs = gates.map((g, i) => limit(async () => {
      active++;
      peak = Math.max(peak, active);   // observed synchronously at each start
      started.push(i);
      try { await g.promise; } finally { active--; }
      return i;
    }));

    await settle();
    expect(started).toEqual([0, 1]);
    // Finish out of order: the NEXT waiter still starts, not whoever finished.
    gates[1]!.resolve();
    await settle();
    expect(started).toEqual([0, 1, 2]);
    gates[0]!.resolve();
    await settle();
    expect(started).toEqual([0, 1, 2, 3]);
    for (const g of gates) g.resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it('releases the slot when a job rejects', async () => {
    const limit = createLimiter(1);
    await expect(limit(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await limit(() => Promise.resolve('next'))).toBe('next');
  });

  it('releases the slot when a job throws synchronously', async () => {
    const limit = createLimiter(1);
    const sync = (): Promise<string> => { throw new Error('sync'); };
    await expect(limit(sync)).rejects.toThrow('sync');
    expect(await limit(() => Promise.resolve('next'))).toBe('next');
  });

  it('hands a released slot to a waiter queued behind a failure', async () => {
    const limit = createLimiter(1);
    const gate = deferred();
    const first = limit(() => gate.promise);
    const second = limit(() => Promise.resolve('second'));
    gate.reject(new Error('first failed'));
    await expect(first).rejects.toThrow('first failed');
    expect(await second).toBe('second');
  });
});

/**
 * A slot must not outlive its deadline. execa settles only once every holder
 * of the child's stdout/stderr has closed them, so a surviving grandchild (gc,
 * a hung ssh under fetch, upload-pack) can keep a timed-out git's promise
 * pending for minutes. Eight of those and every git call in the daemon waits.
 */
describe('createLimiter hold deadline', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('frees the slot at the deadline and lets the next waiter run, while the caller still waits', async () => {
    vi.useFakeTimers();
    const limit = createLimiter(1);
    let firstSettled = false;
    const never = new Promise<string>(() => {});
    void limit(() => never, 1000).then(() => { firstSettled = true; });
    let secondRan = false;
    const second = limit(async () => { secondRan = true; return 'second'; }, 1000);
    await vi.advanceTimersByTimeAsync(999);
    expect(secondRan).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await second).toBe('second');
    expect(secondRan).toBe(true);
    expect(firstSettled).toBe(false);   // the caller is still awaiting its own result
  });

  it('releases once, not twice, when a job settles after its deadline', async () => {
    vi.useFakeTimers();
    const limit = createLimiter(1);
    const gate = deferred();
    const first = limit(() => gate.promise, 1000);
    await vi.advanceTimersByTimeAsync(1000);          // deadline frees the slot
    const blockerGate = deferred();
    const blocker = limit(() => blockerGate.promise); // now holds the only slot
    let thirdRan = false;
    const third = limit(async () => { thirdRan = true; });
    gate.resolve();                                    // late settle: must NOT free a slot again
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(thirdRan).toBe(false);
    blockerGate.resolve();
    await blocker;
    await third;
    expect(thirdRan).toBe(true);
  });

  it('clears the deadline timer when the job finishes in time', async () => {
    vi.useFakeTimers();
    const limit = createLimiter(1);
    await limit(() => Promise.resolve(1), 1000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('an aborted signal', () => {
  it('skips the spawn and rejects with an AbortError', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(git(['--version'], undefined, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const r = await gitTry(['--version'], undefined, ac.signal);
    expect(r.ok).toBe(false);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/abort/i);
  });
});
