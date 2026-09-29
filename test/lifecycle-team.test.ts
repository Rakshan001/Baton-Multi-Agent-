// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Team Sync v2 §7.1 — a team row is a projection of the fold, so the local
 * lifecycle never writes team state onto it. The team state machine lives in
 * src/team/fold.ts; the row is recomputed by src/team/materialize.ts. Here:
 * the solo verdicts refuse a team row, and stay exactly as they were on a
 * local one.
 */
import { describe, it, expect } from 'vitest';
import * as lifecycle from '../src/lifecycle.js';
import { approve, reject, type Outcome } from '../src/lifecycle.js';
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

function refused(o: Outcome): string {
  if (o.ok) throw new Error(`expected a refusal, got state ${o.task.state}`);
  return o.refusal.code;
}

describe('team review goes through the fold, never the row (C7)', () => {
  const inReview = row({ slug: 'a', origin: 'team', state: 'review', finishedSha: 'abc', contributors: [{ agent: 'cursor', from: T0 }] });

  it('reject refuses a team row and points at the team log', () => {
    const o = reject([inReview], 'a', claude, 'rename it', NOW);
    expect(refused(o)).toBe('team-task');
    expect(!o.ok && o.refusal.message).toMatch(/review\.decide/);
  });

  it('approve refuses a team row too — no local `approved` write', () => {
    expect(refused(approve([inReview], 'a', claude, NOW))).toBe('team-task');
  });

  it('refuses before any other gate, whatever the row state', () => {
    // A self-review or a wrong state would otherwise answer first and hide
    // that no local verdict is possible at all.
    const own = { ...inReview, contributors: [{ agent: 'claude', from: T0 }] };
    expect(refused(reject([own], 'a', claude, 'x', NOW))).toBe('team-task');
    expect(refused(approve([{ ...inReview, state: 'active' }], 'a', claude, NOW))).toBe('team-task');
  });

  it('solo approve and reject are unchanged', () => {
    const local = [row({ slug: 'a', state: 'review', contributors: [{ agent: 'cursor', from: T0 }] })];
    expect((approve(local, 'a', claude, NOW) as Extract<Outcome, { ok: true }>).task.state).toBe('done');
    expect((reject(local, 'a', claude, 'nope', NOW) as Extract<Outcome, { ok: true }>).task.state).toBe('active');
    expect(refused(approve(local, 'a', { agent: 'cursor', sessionSlug: 's' }, NOW))).toBe('self-review');
  });
});

describe('no second team state machine (C3)', () => {
  it('lifecycle exports none of the removed team mutators', () => {
    for (const name of ['assign', 'ack', 'remind', 'take', 'hold', 'resume', 'requestChanges', 'markMerged', 'closeMerged', 'needsOwner', 'resolveOwner']) {
      expect(lifecycle).not.toHaveProperty(name);
    }
  });
});
