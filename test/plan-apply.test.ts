// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { applyPlan, renderDiff } from '../src/plan-apply.js';
import { loadPlan } from '../src/plan.js';
import type { Task } from '../src/store.js';

const OPTS = { wtRoot: '/repo/.baton/wt', now: '2026-08-05T10:00:00.000Z', actor: 'me' };

const plan = (body: string) => loadPlan(`---\nplan: auth\n---\n${body}`);

const P1 = plan('## Phase 1\n\n### auth-schema\n**scope:** `src/db/**`\n\nTables.\n');
const P2 = plan('## Phase 1\n\n### auth-schema\n**scope:** `src/db/**`\n\nTables.\n\n## Phase 2\n\n### auth-api\n**after:** auth-schema\n\nTokens.\n');

/** A recorded task as it exists on the board. */
function row(over: Partial<Task> & { slug: string }): Task {
  return {
    task: 'Tables.', branch: `baton/${over.slug}`, worktreePath: `/repo/.baton/wt/${over.slug}`,
    baseBranch: 'main', baseCommit: null, createdAt: OPTS.now,
    planId: 'auth', phase: 1, dependsOn: [], assignee: null,
    scope: ['src/db/**'], skills: [], principles: [], expects: [], state: 'queued',
    ...over,
  };
}

describe('applyPlan — creating', () => {
  it('creates a queued row per task on an empty board', () => {
    const r = applyPlan([], P2, OPTS);
    expect(r.entries.map((e) => [e.slug, e.change])).toEqual([['auth-schema', 'new'], ['auth-api', 'new']]);
    expect(r.tasks.map((t) => t.slug)).toEqual(['auth-schema', 'auth-api']);
    expect(r.blocking).toEqual([]);
  });

  /**
   * The row is a JSON record and nothing else — no branch, no worktree, no
   * commit. That laziness is what makes a 40-task plan free to write down and
   * cheap to throw away.
   */
  it('materializes nothing — the branch and path are intentions', () => {
    const [t] = applyPlan([], P1, OPTS).tasks;
    expect(t.baseCommit).toBeNull();
    expect(t.branch).toBe('baton/auth-schema');
    expect(t.worktreePath).toBe('/repo/.baton/wt/auth-schema');
    expect(t.state).toBe('queued');
  });

  it('carries the plan contract onto the row', () => {
    const [, api] = applyPlan([], P2, OPTS).tasks;
    expect(api.phase).toBe(2);
    expect(api.dependsOn).toEqual(['auth-schema']);
    expect(api.planId).toBe('auth');
  });

  it('is idempotent — applying twice changes nothing the second time', () => {
    const once = applyPlan([], P2, OPTS);
    const twice = applyPlan(once.tasks, P2, OPTS);
    expect(twice.entries.every((e) => e.change === 'keep')).toBe(true);
    expect(twice.dirty).toBe(false);
    expect(twice.tasks).toEqual(once.tasks);
  });
});

describe('applyPlan — editing', () => {
  const widened = plan('## Phase 1\n\n### auth-schema\n**scope:** `src/db/**`, `src/models/**`\n\nTables.\n');

  it('applies an edit to a queued task without ceremony', () => {
    const r = applyPlan([row({ slug: 'auth-schema' })], widened, OPTS);
    expect(r.entries[0]).toMatchObject({ change: 'update', fields: ['scope'] });
    expect(r.blocking).toEqual([]);
    expect(r.tasks[0].scope).toEqual(['src/db/**', 'src/models/**']);
  });

  /**
   * Moving scope under an agent that is editing those files is the failure this
   * whole module exists for: the agent's next edit is judged against a contract
   * it was never given.
   */
  it('will not move a live task without --force', () => {
    const live = [row({ slug: 'auth-schema', state: 'active', baseCommit: 'abc', claimedBy: { agent: 'cursor', sessionSlug: 's', at: OPTS.now } })];
    const r = applyPlan(live, widened, OPTS);
    expect(r.entries[0]).toMatchObject({ change: 'update-live', holder: 'cursor', state: 'active' });
    expect(r.blocking).toHaveLength(1);
    expect(r.tasks).toEqual(live);                       // nothing written
  });

  it('applies the same edit with --force', () => {
    const live = [row({ slug: 'auth-schema', state: 'active', baseCommit: 'abc' })];
    const r = applyPlan(live, widened, { ...OPTS, force: true });
    expect(r.tasks[0].scope).toEqual(['src/db/**', 'src/models/**']);
    expect(r.tasks[0].state).toBe('active');             // runtime state survives
  });

  /**
   * The plan states intent; history states fact. Intent does not get to edit
   * fact — a re-applied plan must never reopen finished work.
   */
  it('never rewinds a done task', () => {
    const done = [row({ slug: 'auth-schema', state: 'done', baseCommit: 'abc' })];
    const r = applyPlan(done, widened, { ...OPTS, force: true });
    expect(r.entries[0]).toMatchObject({ change: 'frozen', state: 'done' });
    expect(r.entries[0].note).toContain('will not rewind');
    expect(r.tasks[0]).toEqual(done[0]);
    expect(r.dirty).toBe(false);
  });

  it('leaves a task alone when the plan did not touch it', () => {
    const r = applyPlan([row({ slug: 'auth-schema' })], P1, OPTS);
    expect(r.entries[0].change).toBe('keep');
    expect(r.dirty).toBe(false);
  });
});

describe('applyPlan — removing', () => {
  const shrunk = plan('## Phase 1\n\n### auth-schema\n**scope:** `src/db/**`\n\nTables.\n');

  it('drops a queued task that never became real', () => {
    const before = [row({ slug: 'auth-schema' }), row({ slug: 'auth-api', phase: 2, task: 'Tokens.', scope: [] })];
    const r = applyPlan(before, shrunk, OPTS);
    expect(r.entries.find((e) => e.slug === 'auth-api')).toMatchObject({ change: 'drop' });
    expect(r.tasks.map((t) => t.slug)).toEqual(['auth-schema']);
  });

  /**
   * Deleting the row would orphan the branch and the worktree with nothing left
   * pointing at them. Cancel keeps them findable.
   */
  it('cancels rather than deletes a task that has work behind it', () => {
    const before = [
      row({ slug: 'auth-schema' }),
      row({ slug: 'auth-api', phase: 2, state: 'active', baseCommit: 'abc', claimedBy: { agent: 'claude', sessionSlug: 's', at: OPTS.now } }),
    ];
    const r = applyPlan(before, shrunk, { ...OPTS, force: true });
    const gone = r.tasks.find((t) => t.slug === 'auth-api');
    expect(gone).toBeDefined();                          // still on the board
    expect(gone!.state).toBe('cancelled');
    expect(gone!.worktreePath).toBe('/repo/.baton/wt/auth-api');
    expect(gone!.cancelledBy).toMatchObject({ actor: 'me', reason: 'removed from the plan' });
  });

  it('needs --force to cancel started work', () => {
    const before = [row({ slug: 'auth-schema' }), row({ slug: 'auth-api', phase: 2, state: 'active', baseCommit: 'abc' })];
    const r = applyPlan(before, shrunk, OPTS);
    expect(r.blocking.map((e) => e.change)).toEqual(['cancel']);
    expect(r.tasks).toEqual(before);
  });

  it('does not resurrect or re-cancel a done task dropped from the plan', () => {
    const before = [row({ slug: 'auth-schema' }), row({ slug: 'auth-api', phase: 2, state: 'done', baseCommit: 'abc' })];
    const r = applyPlan(before, shrunk, OPTS);
    expect(r.tasks.find((t) => t.slug === 'auth-api')!.state).toBe('done');
    expect(r.dirty).toBe(false);
  });
});

describe('applyPlan — slugs this plan does not own', () => {
  /**
   * Both rows would resolve to the branch `baton/auth-schema`. That is a real
   * collision, not bookkeeping, so --force cannot buy past it.
   */
  it('refuses a slug held by a hand-made task, even with --force', () => {
    const handmade = [{ ...row({ slug: 'auth-schema' }), planId: undefined, baseCommit: 'abc' }];
    const r = applyPlan(handmade, P1, { ...OPTS, force: true });
    expect(r.entries[0]).toMatchObject({ change: 'conflict' });
    expect(r.entries[0].note).toContain('hand-made');
    expect(r.tasks).toEqual(handmade);
  });

  it('refuses a slug owned by another plan', () => {
    const other = [{ ...row({ slug: 'auth-schema' }), planId: 'billing' }];
    const r = applyPlan(other, P1, { ...OPTS, force: true });
    expect(r.entries[0].note).toContain("plan 'billing'");
    expect(r.tasks).toEqual(other);
  });

  /**
   * The half-applied case, and the reason a conflict is not forceable: the
   * healthy tasks alongside it must not land either. A board holding half a
   * plan gates its phases on tasks nobody meant to create.
   */
  it('writes NOTHING when one slug conflicts, even though the rest are fine', () => {
    const handmade = [{ ...row({ slug: 'auth-schema' }), planId: undefined, baseCommit: 'abc' }];
    const r = applyPlan(handmade, P2, { ...OPTS, force: true });
    expect(r.entries.map((e) => e.change)).toEqual(['conflict', 'new']);
    expect(r.tasks.map((t) => t.slug)).toEqual(['auth-schema']);   // auth-api NOT created
  });

  it('reports the conflict as blocking so the dry run can refuse out loud', () => {
    const handmade = [{ ...row({ slug: 'auth-schema' }), planId: undefined }];
    expect(applyPlan(handmade, P1, OPTS).blocking.map((e) => e.change)).toEqual(['conflict']);
  });

  it('leaves another plan\'s tasks completely alone', () => {
    const other = [{ ...row({ slug: 'billing-api' }), planId: 'billing' }];
    const r = applyPlan(other, P1, OPTS);
    expect(r.entries.some((e) => e.slug === 'billing-api')).toBe(false);
    expect(r.tasks.find((t) => t.slug === 'billing-api')).toEqual(other[0]);
  });
});

describe('renderDiff', () => {
  it('marks each row so the dry run reads at a glance', () => {
    const before = [
      row({ slug: 'auth-schema', state: 'active', baseCommit: 'abc', claimedBy: { agent: 'antigravity', sessionSlug: 's', at: OPTS.now } }),
      row({ slug: 'login-ui', phase: 1, task: 'UI.', scope: [] }),
    ];
    const next = plan('## Phase 1\n\n### auth-schema\n**scope:** `src/auth/**`\n\nTables.\n\n### rate-limit\n**scope:** `src/mw/**`\n\nThrottle.\n');
    const lines = renderDiff(applyPlan(before, next, OPTS).entries).join('\n');
    expect(lines).toContain('~ auth-schema');
    expect(lines).toContain('ACTIVE (antigravity)');
    expect(lines).toContain('+ rate-limit');
    expect(lines).toContain('- login-ui');
  });
});

/**
 * P3 step 1 — the plan owns `model` the same way it owns `assignee`.
 */
describe('applyPlan — model', () => {
  const WITH = plan('## Phase 1\n\n### auth-schema\n**model:** sonnet\n\nTables.\n');
  const WITHOUT = plan('## Phase 1\n\n### auth-schema\n\nTables.\n');

  it('carries the plan\'s model onto a new row', () => {
    const { tasks } = applyPlan([], WITH, OPTS);
    expect(tasks[0]!.model).toBe('sonnet');
  });

  it('clears a model the plan no longer asks for', () => {
    // `merged` spreads the old row first, so an owned field the plan dropped
    // survives unless it is written back. A stale model is intent nobody holds.
    const { tasks } = applyPlan([row({ slug: 'auth-schema', model: 'sonnet' })], WITHOUT, OPTS);
    expect(tasks[0]!.model).toBeUndefined();
  });

  it('reports model as a moved field, so `plan apply` shows the change', () => {
    const { entries } = applyPlan([row({ slug: 'auth-schema' })], WITH, OPTS);
    expect(entries[0]!.fields).toContain('model');
  });
});
