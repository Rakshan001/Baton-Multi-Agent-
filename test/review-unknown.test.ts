// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Phase 7 / I11 — a reviewer Baton cannot identify (`unknown`, or a lenient
 * ancestry guess) could be the author under another name, so it may not give a
 * verdict. The refusal says exactly what to run instead.
 */
import { describe, it, expect } from 'vitest';
import type { Task } from '../src/store.js';
import { approve, reject, mayReview } from '../src/lifecycle.js';

const NOW = '2026-09-24T12:00:00.000Z';
const task = (): Task => ({
  slug: 'auth-api', task: 'the api', branch: 'baton/auth-api',
  worktreePath: '/tmp/wt/auth-api', baseBranch: 'main', baseCommit: 'aaa111',
  createdAt: NOW, phase: 1, dependsOn: [], assignee: null,
  state: 'review', requireReview: true, finishedSha: 'deadbee',
  claimedBy: { agent: 'claude', sessionSlug: 's1', at: NOW },
  contributors: [{ agent: 'claude', from: NOW, to: NOW }],
} as Task);

describe('mayReview', () => {
  it.each([
    [{ agent: 'unknown', source: 'none' as const }, false],
    [{ agent: 'unknown' }, false],
    [{ agent: 'cursor', source: 'ancestry-inferred' as const }, false],
    [{ agent: 'cursor', source: 'ancestry' as const }, true],
    [{ agent: 'cursor', source: 'env' as const }, true],
    [{ agent: 'cursor', source: 'client' as const }, true],
    [{ agent: 'cursor' }, true], // pre-phase-7 callers carry no source
  ])('%o → %s', (who, ok) => expect(mayReview(who)).toBe(ok));
});

describe('verdicts refuse an unidentified reviewer', () => {
  it('unknown cannot approve, and is told the exact command', () => {
    const r = approve([task()], 'auth-api', { agent: 'unknown', sessionSlug: 's9', source: 'none' }, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe('unidentified');
    expect(r.refusal.message).toContain('BATON_AGENT=<your name> baton review approve auth-api');
  });
  it('a lenient guess cannot reject', () => {
    const r = reject([task()], 'auth-api', { agent: 'cursor', sessionSlug: 's9', source: 'ancestry-inferred' }, 'nope', NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal.code).toBe('unidentified');
    expect(r.refusal.message).toContain('guessed "cursor"');
    expect(r.refusal.message).toContain('BATON_AGENT=<your name> baton review reject auth-api');
  });
  it('a strictly-identified non-contributor still approves', () => {
    expect(approve([task()], 'auth-api', { agent: 'cursor', sessionSlug: 's9', source: 'ancestry' }, NOW).ok).toBe(true);
  });
});
