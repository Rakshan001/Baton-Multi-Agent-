// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The dashboard's SSE **reconnect loop** (web/src/lib/sse.ts).
 *
 * Phase 7.5 replaced EventSource with fetch(), because EventSource cannot send
 * an Authorization header. That moved reconnection from the browser's code into
 * ours, and the plan recorded the consequence honestly: the frame parser was
 * tested, the loop around it was not. This file closes that.
 *
 * Everything here is driven through a fake `fetch` and fake timers, because the
 * cases that matter are the ones a real link only produces occasionally — a
 * stream that ends mid-session, a token revoked while connected, a hub that
 * restarts and drops every member at the same instant.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openSse, type SseFrame } from '../web/src/lib/sse';

/* ------------------------------------------------------------------ */
/* A stream we can feed by hand                                        */
/* ------------------------------------------------------------------ */

type ReadResult = { done: false; value: Uint8Array } | { done: true; value: undefined };

class FakeStream {
  private queue: ReadResult[] = [];
  private waiter: ((v: ReadResult) => void) | null = null;
  private failer: ((e: Error) => void) | null = null;
  private failed: Error | null = null;

  /** Feed bytes exactly as the daemon would write them — including partial frames. */
  push(text: string): void {
    this.deliver({ done: false, value: new TextEncoder().encode(text) });
  }

  /** A clean end: the daemon restarted, or a proxy timed the stream out. */
  end(): void {
    this.deliver({ done: true, value: undefined });
  }

  /** What a real fetch body does when its AbortController fires. */
  fail(e: Error): void {
    this.failed = e;
    const f = this.failer;
    this.failer = null;
    this.waiter = null;
    f?.(e);
  }

  private deliver(v: ReadResult): void {
    const w = this.waiter;
    if (w) { this.waiter = null; this.failer = null; w(v); }
    else this.queue.push(v);
  }

  getReader() {
    return {
      read: (): Promise<ReadResult> => {
        if (this.failed) return Promise.reject(this.failed);
        const q = this.queue.shift();
        if (q) return Promise.resolve(q);
        return new Promise<ReadResult>((resolve, reject) => {
          this.waiter = resolve;
          this.failer = reject as (e: Error) => void;
        });
      },
    };
  }
}

interface Call { url: string; headers: Record<string, string> }

/** Queue of responses the fake fetch hands out, one per connect attempt. */
type Plan =
  | { kind: 'stream'; stream: FakeStream }
  | { kind: 'status'; status: number }
  | { kind: 'throw' };

let calls: Call[] = [];
let plans: Plan[] = [];
let realFetch: typeof fetch;

function planStream(): FakeStream {
  const s = new FakeStream();
  plans.push({ kind: 'stream', stream: s });
  return s;
}

beforeEach(() => {
  vi.useFakeTimers();
  // Jitter off by default so a delay is exactly the bottom of its window; the
  // window itself is asserted separately.
  vi.spyOn(Math, 'random').mockReturnValue(0);
  calls = [];
  plans = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), headers: { ...(init.headers as Record<string, string>) } });
    const plan = plans.shift() ?? { kind: 'throw' as const };
    if (plan.kind === 'throw') throw new TypeError('Failed to fetch');
    if (plan.kind === 'status') return { status: plan.status, ok: plan.status < 400, body: null };
    // A real abort rejects the pending read; wire the signal through so the
    // close path is the same one production takes.
    init.signal?.addEventListener('abort', () => plan.stream.fail(new Error('aborted')));
    return { status: 200, ok: true, body: plan.stream };
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const frameFor = (id: string, event: string) => `id: ${id}\nevent: ${event}\ndata: {"n":${id}}\n\n`;

/* ------------------------------------------------------------------ */

describe('openSse — the happy stream', () => {
  it('sends the token and delivers frames', async () => {
    const frames: SseFrame[] = [];
    const stream = planStream();
    const close = openSse({ url: '/api/events', token: 'baton_abc', onFrame: (f) => frames.push(f) });
    await vi.advanceTimersByTimeAsync(0);

    expect(calls[0].headers.Authorization).toBe('Bearer baton_abc');
    expect(calls[0].headers.Accept).toBe('text/event-stream');
    // No Last-Event-ID on a first connection: there is nothing to resume from.
    expect(calls[0].headers['Last-Event-ID']).toBeUndefined();

    stream.push(frameFor('1', 'task.created'));
    await vi.advanceTimersByTimeAsync(0);
    expect(frames).toEqual([{ id: '1', event: 'task.created', data: '{"n":1}' }]);
    close();
  });

  it('sends no Authorization header for a loopback daemon', async () => {
    planStream();
    const close = openSse({ url: '/api/events', onFrame: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0].headers.Authorization).toBeUndefined();
    close();
  });

  it('reassembles a frame split across chunk boundaries', async () => {
    // The failure this prevents: a dropped `claim.conflict` is a collision
    // nobody is told about, and a chunk can split anywhere — including between
    // the two newlines that end a frame.
    const frames: SseFrame[] = [];
    const stream = planStream();
    const close = openSse({ url: '/api/events', onFrame: (f) => frames.push(f) });
    await vi.advanceTimersByTimeAsync(0);

    stream.push('id: 7\nevent: claim.con');
    await vi.advanceTimersByTimeAsync(0);
    expect(frames).toHaveLength(0);

    stream.push('flict\ndata: {"relPath":"src/a.ts"}\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(frames).toHaveLength(0); // still one newline short of a whole frame

    stream.push('\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(frames).toEqual([{ id: '7', event: 'claim.conflict', data: '{"relPath":"src/a.ts"}' }]);
    close();
  });

  it('delivers several frames arriving in one chunk', async () => {
    const frames: SseFrame[] = [];
    const stream = planStream();
    const close = openSse({ url: '/api/events', onFrame: (f) => frames.push(f) });
    await vi.advanceTimersByTimeAsync(0);
    stream.push(frameFor('1', 'a') + frameFor('2', 'b') + frameFor('3', 'c'));
    await vi.advanceTimersByTimeAsync(0);
    expect(frames.map((f) => f.event)).toEqual(['a', 'b', 'c']);
    close();
  });
});

describe('openSse — reconnect', () => {
  it('reconnects after a clean end and resumes from the last id', async () => {
    // A clean end is still an end: the daemon restarted, or a proxy timed the
    // stream out at ~100 s. Resuming by id is what stops a silent hole.
    const first = planStream();
    const second = planStream();
    const opened = vi.fn();
    const close = openSse({ url: '/api/events', token: 't', onFrame: () => {}, onOpen: opened });
    await vi.advanceTimersByTimeAsync(0);

    first.push(frameFor('41', 'x') + frameFor('42', 'y'));
    await vi.advanceTimersByTimeAsync(0);
    first.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1); // waiting out the backoff, not hammering

    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(2);
    expect(calls[1].headers['Last-Event-ID']).toBe('42');
    expect(opened).toHaveBeenCalledTimes(2);
    void second;
    close();
  });

  it('does not resume from a keep-alive or a frame with no id', async () => {
    // `: ping` every 25 s holds the connection open through an idle timeout. A
    // fabricated id would ask the daemon to replay from a position that never
    // existed.
    const frames: SseFrame[] = [];
    const first = planStream();
    planStream();
    const close = openSse({ url: '/api/events', onFrame: (f) => frames.push(f) });
    await vi.advanceTimersByTimeAsync(0);

    first.push('id: 9\nevent: a\ndata: {}\n\n');
    first.push(': ping\n\n');
    first.push('event: b\ndata: {}\n\n'); // no id
    await vi.advanceTimersByTimeAsync(0);
    expect(frames.map((f) => f.event)).toEqual(['a', 'b']); // the ping is not an event

    first.end();
    await vi.advanceTimersByTimeAsync(500);
    expect(calls[1].headers['Last-Event-ID']).toBe('9');
    close();
  });

  it('retries when the daemon is not listening at all', async () => {
    const errors: Array<{ status?: number; willRetry: boolean }> = [];
    plans.push({ kind: 'throw' });
    planStream();
    const close = openSse({ url: '/api/events', onFrame: () => {}, onError: (e) => errors.push(e) });
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual([{ status: undefined, willRetry: true }]);

    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(2);
    close();
  });

  it('retries a 5xx and reports the status', async () => {
    const errors: Array<{ status?: number; willRetry: boolean }> = [];
    plans.push({ kind: 'status', status: 503 });
    planStream();
    const close = openSse({ url: '/api/events', onFrame: () => {}, onError: (e) => errors.push(e) });
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual([{ status: 503, willRetry: true }]);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(2);
    close();
  });
});

describe('openSse — the backoff ladder', () => {
  it('doubles up to the cap and stays there', async () => {
    // Nothing ever succeeds, so `attempt` only grows. With jitter pinned to 0
    // each delay is the bottom of its window: half the capped value.
    for (let i = 0; i < 9; i++) plans.push({ kind: 'throw' });
    const close = openSse({ url: '/api/events', onFrame: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);

    const expected = [500, 1000, 2000, 4000, 8000, 15_000, 15_000, 15_000];
    for (const [i, wait] of expected.entries()) {
      // One tick short: the retry must not have fired yet.
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(calls).toHaveLength(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(i + 2);
    }
    close();
  });

  it('resets the ladder once a connection succeeds', async () => {
    // Otherwise a member who has been offline all morning waits 15 s for every
    // blip for the rest of the day.
    plans.push({ kind: 'throw' }, { kind: 'throw' });
    const third = planStream();
    planStream();
    const close = openSse({ url: '/api/events', onFrame: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);   // attempt 0 → 500 ms
    await vi.advanceTimersByTimeAsync(1000);  // attempt 1 → 1000 ms
    expect(calls).toHaveLength(3);            // connected

    third.end();
    await vi.advanceTimersByTimeAsync(499);
    expect(calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(4);            // back to the bottom rung
    close();
  });

  it('jitters within the window rather than firing on a fixed beat', async () => {
    // A hub restart drops every member at the same instant. Without jitter they
    // would all come back at the same instant too.
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    plans.push({ kind: 'throw' }, { kind: 'throw' });
    const close = openSse({ url: '/api/events', onFrame: () => {} });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(500);   // the floor for attempt 0
    expect(calls).toHaveLength(1);            // jitter pushed it past the floor
    await vi.advanceTimersByTimeAsync(500);   // …but never past the ceiling
    expect(calls).toHaveLength(2);
    close();
  });
});

describe('openSse — a refused credential is terminal', () => {
  for (const status of [401, 403]) {
    it(`reports ${status} and never retries it`, async () => {
      // A revoked or rotated token fails identically every time. A client that
      // hammers a dead credential turns one expired session into a load pattern.
      const errors: Array<{ status?: number; willRetry: boolean }> = [];
      const authFailed = vi.fn();
      plans.push({ kind: 'status', status });
      planStream(); // would be used if it wrongly retried
      const close = openSse({
        url: '/api/events', token: 'stale',
        onFrame: () => {}, onError: (e) => errors.push(e), onAuthFailure: authFailed,
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(authFailed).toHaveBeenCalledWith(status);
      expect(errors).toEqual([{ status, willRetry: false }]);

      // Well past every rung of the ladder.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(calls).toHaveLength(1);
      close();
    });
  }

  it('is terminal only for auth — a 404 still retries', async () => {
    plans.push({ kind: 'status', status: 404 });
    planStream();
    const authFailed = vi.fn();
    const close = openSse({ url: '/api/events', onFrame: () => {}, onAuthFailure: authFailed });
    await vi.advanceTimersByTimeAsync(0);
    expect(authFailed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(2);
    close();
  });
});

describe('openSse — close is permanent', () => {
  it('stops frames, retries and callbacks for good', async () => {
    const frames: SseFrame[] = [];
    const errors: unknown[] = [];
    const stream = planStream();
    planStream();
    const close = openSse({
      url: '/api/events', onFrame: (f) => frames.push(f), onError: (e) => errors.push(e),
    });
    await vi.advanceTimersByTimeAsync(0);
    stream.push(frameFor('1', 'a'));
    await vi.advanceTimersByTimeAsync(0);
    expect(frames).toHaveLength(1);

    close();
    await vi.advanceTimersByTimeAsync(0);

    // The abort rejects the pending read, which is the same path a real fetch
    // takes — and it must NOT be mistaken for a dropped stream worth retrying.
    stream.push(frameFor('2', 'b'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(frames).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('cancels a retry that was already scheduled', async () => {
    // Closing during the backoff window is the common case: a React effect
    // tears down while the stream is waiting to come back.
    plans.push({ kind: 'throw' });
    planStream();
    const close = openSse({ url: '/api/events', onFrame: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);

    close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveLength(1);
  });

  it('is safe to call twice', async () => {
    planStream();
    const close = openSse({ url: '/api/events', onFrame: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    close();
    expect(() => close()).not.toThrow();
  });
});
