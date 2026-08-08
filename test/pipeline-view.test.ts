// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * §10 phase 7 — the swimlane projection.
 *
 * The view exists so the browser never re-derives a pipeline rule. These tests
 * hold it to that: every lane status and every blocker string must be the
 * answer `pipeline.ts` already gives, not a second opinion computed for
 * display. A board that says "startable" while every agent is refused the task
 * is worse than no board.
 */
import { describe, it, expect } from 'vitest';
import { pipelineView } from '../src/pipeline-view.js';
import { blockers, openPhase, type PipelineTask } from '../src/pipeline.js';
import { loadPlan } from '../src/plan.js';
import { DEMO_PIPELINE, DEMO_PLAN_MD } from '../web/src/lib/demoPipeline.js';

const t = (over: Partial<PipelineTask> & { slug: string }): PipelineTask & { task?: string } => ({
  phase: 1, state: 'queued', ...over,
});

const board: (PipelineTask & { task?: string })[] = [
  t({ slug: 'schema', task: 'Design the schema', phase: 1, state: 'done', planId: 'auth' }),
  t({ slug: 'api', task: 'Wire the API', phase: 2, state: 'active', planId: 'auth',
    claimedBy: { agent: 'claude', sessionSlug: 's1', at: '2026-08-01T00:00:00.000Z' } }),
  t({ slug: 'ui', task: 'Build the UI', phase: 2, state: 'queued', planId: 'auth' }),
  t({ slug: 'e2e', task: 'End to end', phase: 3, state: 'queued', dependsOn: ['api'], planId: 'auth' }),
  t({ slug: 'stray', task: 'A hand-made task', phase: 0, state: 'queued' }),
];

describe('pipelineView — lanes', () => {
  it('groups by phase in order, ungated work first', () => {
    const v = pipelineView(board);
    expect(v.lanes.map((l) => l.phase)).toEqual([0, 1, 2, 3]);
    expect(v.lanes.find((l) => l.phase === 2)!.tasks.map((x) => x.slug)).toEqual(['api', 'ui']);
  });

  it('labels each lane: ungated, complete, open, locked', () => {
    const v = pipelineView(board);
    const status = (p: number) => v.lanes.find((l) => l.phase === p)!.status;
    expect(status(0)).toBe('ungated');
    expect(status(1)).toBe('complete');
    expect(status(2)).toBe('open');
    expect(status(3)).toBe('locked');
  });

  it('reports done/total per lane so a header can show progress', () => {
    const v = pipelineView(board);
    expect(v.lanes.find((l) => l.phase === 1)).toMatchObject({ done: 1, total: 1 });
    expect(v.lanes.find((l) => l.phase === 2)).toMatchObject({ done: 0, total: 2 });
  });

  it('counts a cancelled task as finished for the lane, not for `done`', () => {
    // A cancelled task no longer holds the barrier, so a lane that shows it as
    // outstanding would claim the phase is still running when it is over.
    const v = pipelineView([
      t({ slug: 'a', phase: 1, state: 'done' }),
      t({ slug: 'b', phase: 1, state: 'cancelled' }),
    ]);
    expect(v.lanes[0]).toMatchObject({ done: 2, total: 2, status: 'complete' });
    expect(v.totals).toMatchObject({ done: 1, cancelled: 1 });
  });
});

describe('pipelineView — it never re-decides a rule', () => {
  it('carries the blocker string verbatim from blockers()', () => {
    const v = pipelineView(board);
    const fromRule = new Map(blockers(board).map((b) => [b.slug, b.reason]));
    for (const lane of v.lanes) {
      for (const task of lane.tasks) {
        expect(task.blocker).toBe(fromRule.get(task.slug) ?? null);
      }
    }
    // And it is a real one, not all-null passing vacuously.
    const e2e = v.lanes.flatMap((l) => l.tasks).find((x) => x.slug === 'e2e')!;
    expect(e2e.blocker).toMatch(/phase 3 locked behind phase 2/);
  });

  it('reports the same open phase the CLI holds agents at', () => {
    expect(pipelineView(board).openPhase).toBe(openPhase(board));
  });

  it('shows the integration hold, and marks the holding lane as the cause', () => {
    // Phase 1 is finished but not on the base. The barrier is the point of the
    // lane: without naming it, phase 2 reads as locked for no visible reason.
    const opts = { integrated: (p: number) => p !== 1 };
    const done1: PipelineTask[] = [
      t({ slug: 'schema', phase: 1, state: 'done' }),
      t({ slug: 'api', phase: 2, state: 'queued' }),
    ];
    const v = pipelineView(done1, opts);
    expect(v.integrationHold).toBe(1);
    expect(v.openPhase).toBe(1);
    expect(v.lanes.find((l) => l.phase === 1)!.status).toBe('holding');
    expect(v.lanes.find((l) => l.phase === 2)!.status).toBe('locked');
    expect(v.lanes.find((l) => l.phase === 2)!.tasks[0].blocker).toMatch(/not integrated/);
  });

  it('surfaces deadlock rather than an empty-looking board', () => {
    const stuck: PipelineTask[] = [t({ slug: 'a', phase: 1, state: 'blocked', stoppedReason: 'needs a key' })];
    const v = pipelineView(stuck);
    expect(v.deadlocked).toBe(true);
    expect(v.lanes[0].tasks[0].blocker).toMatch(/needs a key/);
  });
});

describe('pipelineView — the Infinity trap', () => {
  /*
   * `openPhase` answers Infinity for a finished plan, and JSON.stringify turns
   * Infinity into null with no error anywhere. So a finished plan and a
   * serialization accident would arrive at the browser looking identical. The
   * conversion is done once, on purpose, in the view.
   */
  const finished: PipelineTask[] = [
    t({ slug: 'a', phase: 1, state: 'done' }),
    t({ slug: 'b', phase: 2, state: 'done' }),
  ];

  it('reports null — explicitly, not by falling through JSON', () => {
    const v = pipelineView(finished);
    expect(openPhase(finished)).toBe(Infinity);
    expect(v.openPhase).toBeNull();
    expect(v.deadlocked).toBe(false);           // finished is success, not stuck
    expect(v.lanes.every((l) => l.status === 'complete')).toBe(true);
  });

  it('survives the round trip the daemon actually performs', () => {
    const wire = JSON.parse(JSON.stringify(pipelineView(finished)));
    expect(wire.openPhase).toBeNull();
    expect(wire.lanes).toHaveLength(2);
  });
});

describe('pipelineView — plans and rows', () => {
  it('summarises each plan, and ignores hand-made tasks', () => {
    expect(pipelineView(board).plans).toEqual([{ id: 'auth', total: 4, done: 1, cancelled: 0 }]);
  });

  it('carries who is on a task, and who it is reserved for', () => {
    const v = pipelineView([
      t({ slug: 'api', state: 'active', claimedBy: { agent: 'claude', sessionSlug: 's1', at: 'x' } }),
      t({ slug: 'ui', assignee: 'cursor' }),
    ]);
    const rows = v.lanes[0].tasks;
    expect(rows.find((r) => r.slug === 'api')!.holder).toEqual({ agent: 'claude', sessionSlug: 's1', at: 'x' });
    expect(rows.find((r) => r.slug === 'ui')!.assignee).toBe('cursor');
    expect(rows.find((r) => r.slug === 'ui')!.holder).toBeNull();
  });

  it('falls back to the slug when a row has no title', () => {
    expect(pipelineView([t({ slug: 'orphan' })]).lanes[0].tasks[0].title).toBe('orphan');
  });

  it('an empty board is an empty board, not a crash', () => {
    expect(pipelineView([])).toMatchObject({ openPhase: null, deadlocked: false, lanes: [], plans: [] });
  });
});

describe('the demo showcase must teach a real format', () => {
  /*
   * Demo mode is the showcase (CLAUDE.md), and a showcase that invents syntax
   * is worse than none: someone copies the plan they saw, `baton plan apply`
   * answers "no tasks", and the demo is where they learned it. The first draft
   * of this fixture used a `- [ ] slug` checkbox list that src/plan.ts does not
   * parse — caught here rather than by a user.
   *
   * This is the one place the backend reads a web fixture, deliberately: the
   * only way to prove the demo plan is a real plan is to hand it to the real
   * parser.
   */
  it('the demo plan document parses with the actual plan parser', () => {
    const plan = loadPlan(DEMO_PLAN_MD, 'auth');
    expect(plan.tasks.length).toBeGreaterThan(0);
    expect(plan.goal).toMatch(/recover/);
  });

  it('and the demo board describes the same plan as the demo document', () => {
    // Two fixtures that disagree would show a board whose plan does not
    // contain its tasks — the exact inconsistency the screen exists to expose.
    const plan = loadPlan(DEMO_PLAN_MD, 'auth');
    const inDoc = plan.tasks.map((t) => t.slug).sort();
    const onBoard = DEMO_PIPELINE.lanes.flatMap((l) => l.tasks).map((t) => t.slug).sort();
    expect(onBoard).toEqual(inDoc);

    for (const t of plan.tasks) {
      const row = DEMO_PIPELINE.lanes.flatMap((l) => l.tasks).find((x) => x.slug === t.slug)!;
      expect(row.phase, `${t.slug} phase`).toBe(t.phase);
      expect([...row.dependsOn].sort(), `${t.slug} deps`).toEqual([...t.dependsOn].sort());
    }
  });

  it('the demo lanes agree with the rule the daemon would apply to them', () => {
    // Run the real projection over the fixture's own rows: the statuses the
    // fixture hard-codes must be the statuses the code would compute.
    const rows = DEMO_PIPELINE.lanes.flatMap((l) => l.tasks) as unknown as PipelineTask[];
    const computed = pipelineView(rows);
    expect(computed.lanes.map((l) => [l.phase, l.status]))
      .toEqual(DEMO_PIPELINE.lanes.map((l) => [l.phase, l.status]));
    expect(computed.openPhase).toBe(DEMO_PIPELINE.openPhase);
    expect(computed.totals).toEqual(DEMO_PIPELINE.totals);
  });
});
