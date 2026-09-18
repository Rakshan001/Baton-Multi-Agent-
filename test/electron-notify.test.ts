// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The decision half of desktop notifications. Nothing here launches Electron:
 * `electron/notify.ts` keeps every judgement (does this transition deserve a
 * notification? what does the badge say? is the user opted out?) in pure
 * functions, and main.ts is the thin adapter that turns the answer into
 * `new Notification(...)` / `app.dock.setBadge(...)`.
 *
 * The discipline under test is the whole feature: a notification stream people
 * learn to dismiss is worse than silence, because it teaches them to dismiss
 * the real one too.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  attentionKey,
  attentionReason,
  nextInQueue,
  planNotifications,
  readNotifyPrefs,
  writeNotifyPrefs,
  type AttentionMap,
  type AttentionRow,
} from '../electron/notify.ts';

const ROOT = '/repos/baton';

function row(over: Partial<AttentionRow> & { slug: string }): AttentionRow {
  return {
    root: ROOT,
    projectName: 'baton',
    port: 7077,
    branch: `baton/${over.slug}`,
    health: 'working',
    state: 'active',
    quietForMs: 0,
    ...over,
  };
}

describe('attentionReason', () => {
  it('fires for stalled and abandoned', () => {
    expect(attentionReason(row({ slug: 'a', health: 'stalled' }))).toBe('stalled');
    expect(attentionReason(row({ slug: 'a', health: 'abandoned' }))).toBe('abandoned');
  });

  it('fires for a task that is blocked on a human', () => {
    expect(attentionReason(row({ slug: 'a', health: 'working', state: 'blocked' }))).toBe('blocked');
  });

  it('NEVER fires for quiet — that state exists so the UI can show concern silently', () => {
    expect(attentionReason(row({ slug: 'a', health: 'quiet' }))).toBeNull();
    // and not even when it has been quiet a long time: quiet is by definition
    // still inside the grace window, and `stalled` is the word for past it.
    expect(attentionReason(row({ slug: 'a', health: 'quiet', quietForMs: 44 * 60_000 }))).toBeNull();
  });

  it('stays silent for every non-actionable health', () => {
    for (const health of ['working', 'ok', 'dirty', 'unknown', 'rebasing', 'orphan-disk', 'missing']) {
      expect(attentionReason(row({ slug: 'a', health }))).toBeNull();
    }
  });
});

describe('planNotifications', () => {
  const seen: AttentionMap = {};

  it('notifies on the transition INTO stalled', () => {
    const plan = planNotifications(seen, [row({ slug: 'auth', health: 'stalled' })], { enabled: true });
    expect(plan.notifications).toHaveLength(1);
    expect(plan.notifications[0]!.reason).toBe('stalled');
    expect(plan.notifications[0]!.slug).toBe('auth');
    expect(plan.notifications[0]!.body).toContain('auth');
  });

  it('does not re-notify while a worktree SITS stalled', () => {
    const one = planNotifications(seen, [row({ slug: 'auth', health: 'stalled' })], { enabled: true });
    const two = planNotifications(one.next, [row({ slug: 'auth', health: 'stalled' })], { enabled: true });
    const three = planNotifications(two.next, [row({ slug: 'auth', health: 'stalled' })], { enabled: true });
    expect(two.notifications).toEqual([]);
    expect(three.notifications).toEqual([]);
    // but it is still on the badge: the badge is a level, the notification an edge.
    expect(three.badge).toBe(1);
  });

  it('notifies again when a stall escalates to abandoned', () => {
    const one = planNotifications(seen, [row({ slug: 'auth', health: 'stalled' })], { enabled: true });
    const two = planNotifications(one.next, [row({ slug: 'auth', health: 'abandoned' })], { enabled: true });
    expect(two.notifications.map((n) => n.reason)).toEqual(['abandoned']);
  });

  it('never notifies for quiet, however many ticks it is quiet for', () => {
    let map: AttentionMap = seen;
    for (let i = 0; i < 5; i += 1) {
      const plan = planNotifications(map, [row({ slug: 'auth', health: 'quiet' })], { enabled: true });
      expect(plan.notifications).toEqual([]);
      expect(plan.badge).toBe(0);
      map = plan.next;
    }
  });

  it('re-notifies if a worktree recovers and then stalls again', () => {
    const one = planNotifications(seen, [row({ slug: 'auth', health: 'stalled' })], { enabled: true });
    const back = planNotifications(one.next, [row({ slug: 'auth', health: 'working' })], { enabled: true });
    expect(back.notifications).toEqual([]);
    expect(back.badge).toBe(0);
    const again = planNotifications(back.next, [row({ slug: 'auth', health: 'stalled' })], { enabled: true });
    expect(again.notifications.map((n) => n.reason)).toEqual(['stalled']);
  });

  it('keeps projects apart: same slug in two repos is two worktrees', () => {
    const a = row({ slug: 'auth', health: 'stalled' });
    const b = row({ slug: 'auth', health: 'stalled', root: '/repos/other', projectName: 'other', port: 7078 });
    expect(attentionKey(a)).not.toBe(attentionKey(b));
    const plan = planNotifications(seen, [a, b], { enabled: true });
    expect(plan.notifications).toHaveLength(2);
    expect(plan.badge).toBe(2);
  });

  it('badges what needs attention, and drops rows that stop needing it', () => {
    const one = planNotifications(
      seen,
      [row({ slug: 'a', health: 'stalled' }), row({ slug: 'b', health: 'abandoned' })],
      { enabled: true },
    );
    expect(one.badge).toBe(2);
    const two = planNotifications(one.next, [row({ slug: 'a', health: 'working' })], { enabled: true });
    expect(two.badge).toBe(0);
    expect(two.next).toEqual({});
  });

  it('a first sighting seeds the baseline without shouting', () => {
    // The app may start hours after an agent died. Announcing every already-dead
    // worktree at launch is exactly the flood that gets the feature switched off;
    // the badge and the hotkey still say so.
    const plan = planNotifications(null, [row({ slug: 'auth', health: 'abandoned' })], { enabled: true });
    expect(plan.notifications).toEqual([]);
    expect(plan.badge).toBe(1);
    expect(plan.next).toEqual({ [attentionKey(row({ slug: 'auth' }))]: 'abandoned' });
  });

  it('honours suppression — no notification, no badge — but keeps tracking', () => {
    const off = planNotifications(seen, [row({ slug: 'auth', health: 'stalled' })], { enabled: false });
    expect(off.notifications).toEqual([]);
    expect(off.badge).toBe(0);
    // Tracking continues so turning it back on does not replay a backlog...
    expect(off.next[attentionKey(row({ slug: 'auth' }))]).toBe('stalled');
    const on = planNotifications(off.next, [row({ slug: 'auth', health: 'stalled' })], { enabled: true });
    expect(on.notifications).toEqual([]);
    // ...and the queue still answers the hotkey, which is a pull, not a push.
    expect(off.queue.map((q) => q.slug)).toEqual(['auth']);
  });

  it('orders the queue abandoned, then stalled, then blocked, longest-waiting first', () => {
    const plan = planNotifications(
      null,
      [
        row({ slug: 'blocked-one', health: 'working', state: 'blocked' }),
        row({ slug: 'stalled-new', health: 'stalled', quietForMs: 50 * 60_000 }),
        row({ slug: 'stalled-old', health: 'stalled', quietForMs: 90 * 60_000 }),
        row({ slug: 'gone', health: 'abandoned' }),
        row({ slug: 'fine', health: 'quiet' }),
      ],
      { enabled: true },
    );
    expect(plan.queue.map((q) => q.slug)).toEqual(['gone', 'stalled-old', 'stalled-new', 'blocked-one']);
  });
});

describe('nextInQueue', () => {
  const q = [
    { key: 'k1', slug: 'a', root: ROOT, port: 7077, reason: 'stalled' as const },
    { key: 'k2', slug: 'b', root: ROOT, port: 7077, reason: 'stalled' as const },
  ];

  it('starts at the top when nothing has been visited', () => {
    expect(nextInQueue(q, null)?.slug).toBe('a');
  });

  it('advances, then wraps', () => {
    expect(nextInQueue(q, 'k1')?.slug).toBe('b');
    expect(nextInQueue(q, 'k2')?.slug).toBe('a');
  });

  it('restarts at the top when the last visited worktree is no longer in trouble', () => {
    expect(nextInQueue(q, 'gone-away')?.slug).toBe('a');
  });

  it('has nothing to jump to when nothing needs attention', () => {
    expect(nextInQueue([], 'k1')).toBeNull();
  });
});

describe('the preference', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'baton-notify-'));
    process.env.BATON_NOTIFY_FILE = join(dir, 'notify.json');
  });
  afterEach(() => {
    delete process.env.BATON_NOTIFY_FILE;
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to on when nothing has been written', () => {
    expect(readNotifyPrefs().enabled).toBe(true);
  });

  it('round-trips through disk, which is what surviving a restart means', () => {
    writeNotifyPrefs({ enabled: false });
    expect(readNotifyPrefs().enabled).toBe(false);
    writeNotifyPrefs({ enabled: true });
    expect(readNotifyPrefs().enabled).toBe(true);
  });

  it('falls back to on rather than to silence when the file is corrupt', () => {
    writeNotifyPrefs({ enabled: false });
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(process.env.BATON_NOTIFY_FILE!, '{ not json');
    expect(readNotifyPrefs().enabled).toBe(true);
  });
});
