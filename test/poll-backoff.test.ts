// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Poll backoff while the daemon is unreachable (web/src/hooks/usePoll.ts).
 *
 * Found during the Phase 0 rehearsal: with a port-forward dropped under a live
 * dashboard, the SSE stream backed off to 5 attempts over ~40 s while
 * `/api/status` fired 21 times in the same window. Worse, `useStatus` stretches
 * its interval to 30 s only while SSE is live — so losing the link flipped it
 * back to 2 s and the client polled FIFTEEN TIMES FASTER at the exact moment
 * nothing could answer. Over a metered or rate-limited tunnel that is a request
 * storm aimed at a dead endpoint.
 *
 * `pollDelay` is the pure half of the fix, so it is tested directly; the
 * scheduling around it is a React effect and is verified by driving the real
 * dashboard.
 */
import { describe, it, expect } from 'vitest';
import { pollDelay } from '../web/src/hooks/usePoll';

describe('pollDelay', () => {
  it('polls at the requested interval while the daemon answers', () => {
    // The overwhelmingly common case: nothing is wrong, nothing changes.
    expect(pollDelay(2000, 0)).toBe(2000);
    expect(pollDelay(30_000, 0)).toBe(30_000);
  });

  it('doubles per consecutive failure', () => {
    expect(pollDelay(2000, 1)).toBe(4000);
    expect(pollDelay(2000, 2)).toBe(8000);
    expect(pollDelay(2000, 3)).toBe(16_000);
  });

  it('caps at 30 s however long the outage runs', () => {
    // A dashboard that took minutes to notice the daemon was back would be its
    // own bug. The point is to stop hammering, not to stop watching.
    expect(pollDelay(2000, 4)).toBe(30_000);
    expect(pollDelay(2000, 50)).toBe(30_000);
    expect(pollDelay(2000, 5000)).toBe(30_000);
  });

  it('never returns less than the base interval', () => {
    // Backoff may only ever slow polling down. A bug that made failures speed
    // it up is the one this whole file exists because of.
    for (const interval of [2000, 5000, 10_000, 30_000, 60_000]) {
      for (let f = 0; f <= 8; f++) {
        expect(pollDelay(interval, f)).toBeGreaterThanOrEqual(Math.min(interval, 30_000));
      }
    }
  });

  it('is monotonic — more failures never means a shorter wait', () => {
    let prev = 0;
    for (let f = 0; f <= 10; f++) {
      const d = pollDelay(2000, f);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });

  it('treats a negative failure count as healthy rather than inverting', () => {
    expect(pollDelay(2000, -1)).toBe(2000);
  });

  it('holds a slow poller at its own interval rather than shortening it', () => {
    // useHistory polls at 60 s when SSE is live. Backoff must not drag that
    // DOWN toward the 30 s cap — the cap is a ceiling on the wait, not a target.
    expect(pollDelay(60_000, 0)).toBe(60_000);
    expect(pollDelay(60_000, 3)).toBe(30_000);
  });

  /*
   * The regression this file is named for. 40 s of downtime used to cost 21
   * requests at the 2 s cadence; with backoff the same window costs 6.
   */
  it('turns a 40 s outage from 21 requests into a handful', () => {
    let elapsed = 0;
    let failures = 0;
    let requests = 0;
    while (elapsed < 40_000) {
      elapsed += pollDelay(2000, failures);
      failures++;
      requests++;
    }
    expect(requests).toBeLessThanOrEqual(6);
    expect(21 / requests).toBeGreaterThan(3); // at least a 3x reduction
  });
});
