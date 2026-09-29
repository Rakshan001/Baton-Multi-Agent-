// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Team Sync v2 §7.3 — priority, urgency and the deterministic nextFor order.
 * The solo cases here are the contract that none of it changes a plan with no
 * priority fields set.
 */
import { describe, it, expect } from 'vitest';
import { compareForNext, nextFor } from '../src/lifecycle.js';
import { DEFAULT_PRIORITY, TASK_STATES, effectivePriority, eligibleFor, isTeamTask, priorityOf } from '../src/pipeline.js';
import type { Task } from '../src/store.js';
import { MAX_REMINDER_BOOST } from '../src/team/types.js';
import { rng } from './team-helpers.js';

const T0 = '2026-08-05T10:00:00.000Z';
const T1 = '2026-08-05T11:00:00.000Z';
const T2 = '2026-08-05T12:00:00.000Z';

function row(over: Partial<Task> & { slug: string }): Task {
  return {
    task: over.slug, branch: `baton/${over.slug}`, worktreePath: `/wt/${over.slug}`,
    baseBranch: 'main', baseCommit: null, createdAt: T0,
    phase: 1, dependsOn: [], assignee: null, scope: [], state: 'queued',
    ...over,
  };
}

describe('TaskState', () => {
  it('lists the team states after the original seven, in order', () => {
    expect(TASK_STATES).toEqual([
      'queued', 'claimed', 'active', 'blocked', 'review', 'done', 'cancelled',
      'assigned', 'acknowledged', 'paused', 'changes', 'approved', 'pushed', 'merged', 'needs-owner',
    ]);
  });
});

describe('origin', () => {
  it('defaults to local', () => {
    expect(isTeamTask(row({ slug: 'a' }))).toBe(false);
    expect(isTeamTask(row({ slug: 'a', origin: 'local' }))).toBe(false);
    expect(isTeamTask(row({ slug: 'a', origin: 'team' }))).toBe(true);
  });
});

describe('effectivePriority', () => {
  it('defaults to P2 when absent', () => {
    expect(DEFAULT_PRIORITY).toBe('P2');
    expect(priorityOf(row({ slug: 'a' }))).toBe('P2');
    expect(effectivePriority(row({ slug: 'a' }))).toBe(2);
  });

  it('is the stated priority with no reminders', () => {
    expect(effectivePriority(row({ slug: 'a', priority: 'P0' }))).toBe(0);
    expect(effectivePriority(row({ slug: 'a', priority: 'P3' }))).toBe(3);
  });

  it('counts at most the fold\'s MAX_REMINDER_BOOST reminders', () => {
    expect(MAX_REMINDER_BOOST).toBe(2);
    expect(effectivePriority(row({ slug: 'a', priority: 'P3', reminders: 50 }))).toBe(3 - MAX_REMINDER_BOOST);
  });

  it('bumps one level per unacknowledged reminder, counting at most two', () => {
    expect(effectivePriority(row({ slug: 'a', priority: 'P3', reminders: 1 }))).toBe(2);
    expect(effectivePriority(row({ slug: 'a', priority: 'P3', reminders: 2 }))).toBe(1);
    expect(effectivePriority(row({ slug: 'a', priority: 'P3', reminders: 9 }))).toBe(1);
  });

  it('is capped at P0', () => {
    expect(effectivePriority(row({ slug: 'a', priority: 'P1', reminders: 2 }))).toBe(0);
    expect(effectivePriority(row({ slug: 'a', priority: 'P0', reminders: 2 }))).toBe(0);
  });

  it('ignores nonsense reminder counts', () => {
    expect(effectivePriority(row({ slug: 'a', reminders: -3 }))).toBe(2);
    expect(effectivePriority(row({ slug: 'a', reminders: Number.NaN }))).toBe(2);
    // A hand-edited row with an unknown priority sorts as the default.
    expect(effectivePriority(row({ slug: 'a', priority: 'P9' as never }))).toBe(2);
  });
});

describe('nextFor ordering (§7.3)', () => {
  it('urgent beats priority', () => {
    const tasks = [row({ slug: 'p0', priority: 'P0' }), row({ slug: 'urgent', priority: 'P3', urgent: true })];
    expect(nextFor('claude', tasks)?.slug).toBe('urgent');
  });

  it('effective priority beats phase and age', () => {
    const tasks = [
      row({ slug: 'old-p2', phase: 0, createdAt: T0 }),
      row({ slug: 'new-p1', phase: 1, createdAt: T2, priority: 'P1' }),
    ];
    expect(nextFor('claude', tasks)?.slug).toBe('new-p1');
  });

  it('reminders raise effective priority', () => {
    const tasks = [
      row({ slug: 'p1', priority: 'P1', createdAt: T0 }),
      row({ slug: 'p3-nagged', priority: 'P3', reminders: 2, createdAt: T2 }),
    ];
    // Both effective P1 — so age decides, and the older one wins.
    expect(nextFor('claude', tasks)?.slug).toBe('p1');
    const bumped = [row({ slug: 'p2', createdAt: T0 }), row({ slug: 'p3-nagged', priority: 'P3', reminders: 2, createdAt: T2 })];
    expect(nextFor('claude', bumped)?.slug).toBe('p3-nagged');
  });

  it('breaks full ties by slug, so input order never decides', () => {
    const a = [row({ slug: 'b' }), row({ slug: 'a' })];
    const b = [row({ slug: 'a' }), row({ slug: 'b' })];
    expect(nextFor('claude', a)?.slug).toBe('a');
    expect(nextFor('claude', b)?.slug).toBe('a');
  });

  it('puts the task this agent holds first when ranking a mixed list', () => {
    const held = row({ slug: 'z-held', state: 'active', claimedBy: { agent: 'claude', sessionSlug: 's', at: T0 }, priority: 'P3' });
    const urgent = row({ slug: 'a-urgent', urgent: true, priority: 'P0' });
    const sorted = [urgent, held].sort(compareForNext('claude'));
    expect(sorted.map((t) => t.slug)).toEqual(['z-held', 'a-urgent']);
    // Someone else's hold is not this agent's hold.
    expect([urgent, held].sort(compareForNext('cursor')).map((t) => t.slug)).toEqual(['a-urgent', 'z-held']);
  });

  /**
   * The solo contract: with no priority fields, every row is P2 and not urgent,
   * so the order is exactly the pre-v2 one — phase, own-before-pool, oldest.
   */
  it('orders a solo plan with no priority fields exactly as before', () => {
    const tasks = [
      row({ slug: 'p2-pool-new', phase: 2, createdAt: T2 }),
      row({ slug: 'p1-pool-new', phase: 1, createdAt: T2 }),
      row({ slug: 'p1-mine-new', phase: 1, assignee: 'claude', createdAt: T2 }),
      row({ slug: 'p1-pool-old', phase: 1, createdAt: T0 }),
      row({ slug: 'ungated-mid', phase: 0, createdAt: T1 }),
      row({ slug: 'p2-mine-old', phase: 2, assignee: 'claude', createdAt: T0 }),
    ];
    const legacy = (a: Task, b: Task): number =>
      (a.phase && a.phase > 0 ? a.phase : 0) - (b.phase && b.phase > 0 ? b.phase : 0)
      || Number(a.assignee == null) - Number(b.assignee == null)
      || a.createdAt.localeCompare(b.createdAt);
    const expected = [...tasks].sort(legacy).map((t) => t.slug);
    expect([...tasks].sort(compareForNext('claude')).map((t) => t.slug)).toEqual(expected);
    expect(expected).toEqual(['ungated-mid', 'p1-mine-new', 'p1-pool-old', 'p1-pool-new', 'p2-mine-old', 'p2-pool-new']);
    // And nextFor picks the head of that order.
    expect(nextFor('claude', tasks)?.slug).toBe('ungated-mid');
  });
});

/** The pre-v2 comparator, verbatim — the contract a solo plan is held to. */
const legacy = (a: Task, b: Task): number =>
  (a.phase && a.phase > 0 ? a.phase : 0) - (b.phase && b.phase > 0 ? b.phase : 0)
  || Number(a.assignee == null) - Number(b.assignee == null)
  || a.createdAt.localeCompare(b.createdAt);

describe('solo order is unchanged (property)', () => {
  const AGENTS = ['claude', 'cursor', null] as const;
  const stamp = (n: number) => new Date(Date.UTC(2026, 7, 5, 0, 0, n)).toISOString();

  function soloSet(rand: () => number, n: number): Task[] {
    return Array.from({ length: n }, (_, i) => row({
      slug: `t${Math.floor(rand() * 1e6).toString(36)}-${i}`,
      phase: Math.floor(rand() * 4),
      assignee: AGENTS[Math.floor(rand() * AGENTS.length)],
      // A small range on purpose, so exact ties are common.
      createdAt: stamp(Math.floor(rand() * 6)),
    }));
  }

  it('agrees with the legacy comparator on every pair it orders, over random solo sets', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rand = rng(seed);
      const tasks = soloSet(rand, 2 + Math.floor(rand() * 10));
      const cmp = compareForNext('claude');
      for (const a of tasks) for (const b of tasks) {
        const old = legacy(a, b);
        if (old !== 0) expect(Math.sign(cmp(a, b))).toBe(Math.sign(old));
      }
    }
  });

  /**
   * Documented difference: where the legacy comparator TIES (same phase, same
   * pool side, identical createdAt) it left the order to the input; the new one
   * breaks the tie by slug, so every device agrees. With distinct timestamps the
   * sorted order is identical.
   */
  it('sorts identically when createdAt is distinct, and breaks exact ties by slug', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const rand = rng(seed);
      const tasks = soloSet(rand, 8).map((t, i) => ({ ...t, createdAt: stamp(100 + i * 7 - Math.floor(rand() * 5)) }));
      expect([...tasks].sort(compareForNext('claude')).map((t) => t.slug))
        .toEqual([...tasks].sort(legacy).map((t) => t.slug));
    }
    const tie = [row({ slug: 'b' }), row({ slug: 'a' })];
    expect(legacy(tie[0], tie[1])).toBe(0);
    expect([...tie].sort(compareForNext('claude')).map((t) => t.slug)).toEqual(['a', 'b']);
  });
});

describe('team rows in eligibleFor and nextFor (C4)', () => {
  const team = (over: Partial<Task> & { slug: string }): Task => row({ origin: 'team', teamId: over.slug, ...over });
  const held = { agent: 'claude', sessionSlug: 's', at: T0 };

  it('offers the agent its own assigned and acknowledged team rows', () => {
    const tasks = [
      team({ slug: 'mine-assigned', state: 'assigned', assignee: 'claude', member: 'priya', assignLamport: 5 }),
      team({ slug: 'mine-acked', state: 'acknowledged', assignee: 'claude', member: 'priya', assignLamport: 4 }),
      team({ slug: 'theirs', state: 'assigned', assignee: 'cursor', member: 'priya', assignLamport: 3 }),
      team({ slug: 'member-only', state: 'assigned', assignee: null, member: 'priya', assignLamport: 2 }),
    ];
    expect(eligibleFor('claude', tasks).map((t) => t.slug)).toEqual(['mine-assigned', 'mine-acked']);
    // A task assigned to this device's member with no agent named is this agent's too.
    expect(eligibleFor('claude', tasks, { member: 'priya' }).map((t) => t.slug))
      .toEqual(['mine-assigned', 'mine-acked', 'member-only']);
    expect(eligibleFor('claude', tasks, { member: 'dev-c' }).map((t) => t.slug)).toEqual(['mine-assigned', 'mine-acked']);
  });

  it('still applies the phase barrier and deps to assigned rows', () => {
    const tasks = [
      row({ slug: 'p1', phase: 1, state: 'active' }),
      team({ slug: 'p2', phase: 2, state: 'assigned', assignee: 'claude' }),
      team({ slug: 'dep', phase: 1, state: 'acknowledged', assignee: 'claude', dependsOn: ['p1'] }),
    ];
    expect(eligibleFor('claude', tasks)).toEqual([]);
  });

  it('returns the held team row, and nextFor ranks it first', () => {
    const tasks = [
      team({ slug: 'z-held', state: 'paused', claimedBy: held, priority: 'P3', phase: 3 }),
      team({ slug: 'a-urgent', state: 'assigned', assignee: 'claude', urgent: true, priority: 'P0', assignLamport: 1 }),
      row({ slug: 'solo', priority: 'P0', urgent: true }),
    ];
    expect(eligibleFor('claude', tasks).map((t) => t.slug)).toContain('z-held');
    expect(nextFor('claude', tasks)?.slug).toBe('z-held');
    // Not held by cursor, so cursor never sees it.
    expect(eligibleFor('cursor', tasks).map((t) => t.slug)).not.toContain('z-held');
  });

  it('a blocked or finished team row is not offered as held work', () => {
    for (const state of ['blocked', 'review', 'done', 'cancelled'] as const) {
      expect(eligibleFor('claude', [team({ slug: 'x', state, claimedBy: held })])).toEqual([]);
    }
  });

  it('a held SOLO row is still not eligible — solo eligibility is unchanged', () => {
    expect(eligibleFor('claude', [row({ slug: 'x', state: 'active', claimedBy: held })])).toEqual([]);
  });

  it('breaks team ties by assignLamport then task id, like the fold, ignoring createdAt', () => {
    const tasks = [
      team({ slug: 's1', teamId: 'dev-9', assignee: 'claude', state: 'assigned', assignLamport: 7, createdAt: T0 }),
      team({ slug: 's2', teamId: 'dev-2', assignee: 'claude', state: 'assigned', assignLamport: 3, createdAt: T2 }),
      team({ slug: 's3', teamId: 'dev-1', assignee: 'claude', state: 'assigned', assignLamport: 7, createdAt: T1 }),
      team({ slug: 's0', teamId: 'dev-0', state: 'queued', createdAt: T0 }), // open pool: no lamport, last
    ];
    expect([...tasks].sort(compareForNext('claude')).map((t) => t.slug)).toEqual(['s2', 's3', 's1', 's0']);
  });
});
