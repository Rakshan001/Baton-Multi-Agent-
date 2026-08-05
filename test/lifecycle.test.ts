import { describe, it, expect } from 'vitest';
import { activate, block, claim, nextFor, pause, releaseClaim, takeover } from '../src/lifecycle.js';
import { STALL_GRACE_MS } from '../src/pipeline.js';
import type { Task } from '../src/store.js';

const T0 = '2026-08-05T10:00:00.000Z';
const NOW = '2026-08-05T12:00:00.000Z';

function row(over: Partial<Task> & { slug: string }): Task {
  return {
    task: over.slug, branch: `baton/${over.slug}`, worktreePath: `/wt/${over.slug}`,
    baseBranch: 'main', baseCommit: null, createdAt: T0,
    phase: 1, dependsOn: [], assignee: null, scope: [], state: 'queued',
    ...over,
  };
}

const claude = { agent: 'claude', sessionSlug: 's-claude' };
const cursor = { agent: 'cursor', sessionSlug: 's-cursor' };

describe('claim', () => {
  it('marks the task claimed and opens a contributor stretch', () => {
    const r = claim([row({ slug: 'a' })], 'a', claude, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.task.state).toBe('claimed');
    expect(r.task.claimedBy).toEqual({ agent: 'claude', sessionSlug: 's-claude', at: NOW });
    expect(r.task.contributors).toEqual([{ agent: 'claude', from: NOW }]);
  });

  /**
   * The compare-and-swap. `mutateTasks` re-reads under the lock, so the second
   * agent decides against the list the first one just wrote — and refuses.
   */
  it('lets exactly one of two simultaneous claimers win', () => {
    const before = [row({ slug: 'a' })];
    const first = claim(before, 'a', claude, NOW);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = claim(first.tasks, 'a', cursor, NOW);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.refusal.code).toBe('held');
    expect(second.refusal.message).toContain('claude');
  });

  it('refuses work assigned to someone else', () => {
    const r = claim([row({ slug: 'a', assignee: 'cursor' })], 'a', claude, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe('not-yours');
  });

  /** Re-derived at the write, never read from a flag the caller was shown. */
  it('refuses a task behind the phase barrier even if the caller asked for it', () => {
    const tasks = [row({ slug: 'first', phase: 1 }), row({ slug: 'later', phase: 2 })];
    const r = claim(tasks, 'later', claude, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe('not-eligible');
  });

  it('refuses a task whose dependency is not done', () => {
    const tasks = [row({ slug: 'dep' }), row({ slug: 'b', dependsOn: ['dep'] })];
    expect(claim(tasks, 'b', claude, NOW).ok).toBe(false);
    const withDone = [row({ slug: 'dep', state: 'done' }), row({ slug: 'b', dependsOn: ['dep'] })];
    expect(claim(withDone, 'b', claude, NOW).ok).toBe(true);
  });

  it('reports an unknown slug rather than creating one', () => {
    const r = claim([], 'ghost', claude, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe('missing');
  });
});

/**
 * A failed worktree creation must not leave the task `claimed`: invisible to
 * `next` because it is not queued, useless to its holder because there is
 * nothing to work in, and holding its phase against everyone else.
 */
describe('releaseClaim — rollback when materialization fails', () => {
  it('returns the task to queued and removes the stretch it opened', () => {
    const claimed = claim([row({ slug: 'a' })], 'a', claude, NOW);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const r = releaseClaim(claimed.tasks, 'a', claude);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.task.state).toBe('queued');
    expect(r.task.claimedBy).toBeUndefined();
    expect(r.task.contributors).toBeUndefined();
  });

  it('will not roll back a claim another session now holds', () => {
    const held = [row({ slug: 'a', state: 'claimed', claimedBy: { agent: 'cursor', sessionSlug: 's-cursor', at: NOW } })];
    expect(releaseClaim(held, 'a', claude).ok).toBe(false);
  });
});

describe('activate', () => {
  const materialized = { branch: 'baton/a', worktreePath: '/wt/a', baseBranch: 'main', baseCommit: 'abc123' };

  it('records the worktree that now exists and flips to active', () => {
    const claimed = claim([row({ slug: 'a' })], 'a', claude, NOW);
    if (!claimed.ok) return;
    const r = activate(claimed.tasks, 'a', claude, materialized);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.task.state).toBe('active');
    expect(r.task.baseCommit).toBe('abc123');
  });

  it('refuses if another session took the claim in the meantime', () => {
    const stolen = [row({ slug: 'a', state: 'claimed', claimedBy: { agent: 'cursor', sessionSlug: 's-cursor', at: NOW } })];
    const r = activate(stolen, 'a', claude, materialized);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe('not-yours');
  });
});

describe('takeover', () => {
  const now = Date.parse(NOW);
  const active = (over: Partial<Task> = {}) => [row({
    slug: 'a', state: 'active', baseCommit: 'abc',
    claimedBy: { agent: 'claude', sessionSlug: 's-claude', at: T0 },
    contributors: [{ agent: 'claude', from: T0 }],
    ...over,
  })];
  const stall = (agoMs: number) => ({ now, livenessOf: () => now - agoMs });

  it('adopts stalled work and closes the previous stretch instead of erasing it', () => {
    const r = takeover(active(), 'a', cursor, NOW, stall(STALL_GRACE_MS + 60_000));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.task.claimedBy?.agent).toBe('cursor');
    expect(r.task.contributors).toEqual([
      { agent: 'claude', from: T0, to: NOW },
      { agent: 'cursor', from: NOW },
    ]);
    expect(r.task.state).toBe('active');
  });

  /**
   * Liveness is max(heartbeat, worktree mtime) — an agent running a 20-minute
   * build makes no tool calls and is very much alive. Taking its work is the
   * double-write the whole design exists to prevent.
   */
  it('refuses a task that is quiet but not stalled', () => {
    const r = takeover(active(), 'a', cursor, NOW, stall(10 * 60_000));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe('not-stalled');
    expect(r.refusal.message).toContain('10m ago');
  });

  it('refuses to take over work that is not active', () => {
    const r = takeover(active({ state: 'review' }), 'a', cursor, NOW, stall(1e9));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe('wrong-state');
  });

  it('is not filtered by assignee — whoever is free finishes it', () => {
    expect(takeover(active({ assignee: 'claude' }), 'a', cursor, NOW, stall(1e9)).ok).toBe(true);
  });
});

/**
 * An interruption must never be recorded as a completion, and the counterpart
 * matters just as much: handing work back must not look like finishing it.
 */
describe('pause', () => {
  const mine = [row({
    slug: 'a', state: 'active', baseCommit: 'abc',
    claimedBy: { agent: 'claude', sessionSlug: 's-claude', at: T0 },
    contributors: [{ agent: 'claude', from: T0 }],
  })];

  it('returns the task to the queue with the worktree and history intact', () => {
    const r = pause(mine, 'a', claude, NOW, 'out of context');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.task.state).toBe('queued');
    expect(r.task.claimedBy).toBeUndefined();
    expect(r.task.baseCommit).toBe('abc');                                 // worktree kept
    expect(r.task.contributors).toEqual([{ agent: 'claude', from: T0, to: NOW }]);
    expect(r.task.stoppedReason).toBe('out of context');
  });

  it('never marks anything done', () => {
    const r = pause(mine, 'a', claude, NOW);
    expect(r.ok && r.task.state).not.toBe('done');
  });

  it('refuses to hand back work someone else holds', () => {
    const r = pause(mine, 'a', cursor, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe('not-yours');
  });
});

describe('block', () => {
  const mine = [row({ slug: 'a', state: 'active', claimedBy: { agent: 'claude', sessionSlug: 's-claude', at: T0 } })];

  /** Blocked stays owned — otherwise the next agent picks it up and hits the
   *  same wall, which is a loop rather than a queue. */
  it('keeps the task owned and records the cause', () => {
    const r = block(mine, 'a', claude, 'needs staging DB credentials', NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.task.state).toBe('blocked');
    expect(r.task.claimedBy?.agent).toBe('claude');
    expect(r.task.stoppedReason).toBe('needs staging DB credentials');
  });

  it('refuses a blocker with no reason', () => {
    const r = block(mine, 'a', claude, '   ', NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.message).toContain('needs a reason');
  });
});

describe('nextFor', () => {
  it('prefers the lowest open phase', () => {
    const tasks = [row({ slug: 'later', phase: 2 }), row({ slug: 'now', phase: 1 })];
    expect(nextFor('claude', tasks)?.slug).toBe('now');
  });

  /** Your own work before helping with the pool — otherwise an agent drains the
   *  open pool while the tasks named for it sit waiting. */
  it('prefers work assigned to this agent over the open pool', () => {
    const tasks = [row({ slug: 'pool', createdAt: T0 }), row({ slug: 'mine', assignee: 'claude', createdAt: NOW })];
    expect(nextFor('claude', tasks)?.slug).toBe('mine');
  });

  it('falls back to the oldest when nothing else separates them', () => {
    const tasks = [row({ slug: 'newer', createdAt: NOW }), row({ slug: 'older', createdAt: T0 })];
    expect(nextFor('claude', tasks)?.slug).toBe('older');
  });

  it('returns null when nothing is startable', () => {
    expect(nextFor('claude', [row({ slug: 'a', assignee: 'cursor' })])).toBeNull();
  });
});
