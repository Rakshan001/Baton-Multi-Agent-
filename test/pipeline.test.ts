import { describe, it, expect } from 'vitest';
import {
  blockers, eligibleFor, integrationHold, isDeadlocked, isStalled, openPhase, phaseComplete,
  phaseOf, stateOf, STALL_GRACE_MS, takeable, type PipelineTask,
} from '../src/pipeline.js';

/** Terse task builder — `t('a', { phase: 1, state: 'done' })`. */
const t = (slug: string, extra: Partial<PipelineTask> = {}): PipelineTask => ({ slug, ...extra });

describe('stateOf / phaseOf — defaults for records that predate the pipeline', () => {
  it('an unstated task is queued', () => {
    expect(stateOf(t('x'))).toBe('queued');
    expect(stateOf(t('x', { state: 'active' }))).toBe('active');
  });

  it('a task with no phase sits at 0, the ungated bucket', () => {
    expect(phaseOf(t('x'))).toBe(0);
    expect(phaseOf(t('x', { phase: 3 }))).toBe(3);
  });

  it('treats a nonsense phase as ungated rather than trusting it', () => {
    expect(phaseOf(t('x', { phase: 0 }))).toBe(0);
    expect(phaseOf(t('x', { phase: -2 }))).toBe(0);
  });
});

describe('openPhase — the barrier', () => {
  it('is the lowest phase still holding work', () => {
    expect(openPhase([
      t('a', { phase: 1, state: 'done' }),
      t('b', { phase: 2 }),
      t('c', { phase: 3 }),
    ])).toBe(2);
  });

  it('holds at a phase while ANY of its tasks is unfinished', () => {
    expect(openPhase([
      t('a', { phase: 1, state: 'done' }),
      t('b', { phase: 1, state: 'active' }),
      t('c', { phase: 2 }),
    ])).toBe(1);
  });

  it('counts cancelled as finished, or one dropped task wedges the plan forever', () => {
    expect(openPhase([
      t('a', { phase: 1, state: 'done' }),
      t('b', { phase: 1, state: 'cancelled' }),
      t('c', { phase: 2 }),
    ])).toBe(2);
  });

  it('is Infinity when every phased task is finished', () => {
    expect(openPhase([t('a', { phase: 1, state: 'done' })])).toBe(Infinity);
    expect(openPhase([])).toBe(Infinity);
  });

  it('ignores phase-0 tasks — a stale legacy task must not lock every plan', () => {
    // The regression this guards: one un-finished pre-pipeline task would
    // otherwise be "the lowest unfinished phase" and hold the barrier at 0.
    expect(openPhase([t('legacy'), t('a', { phase: 1 })])).toBe(1);
  });
});

describe('eligibleFor — what an agent may start right now', () => {
  const plan = (): PipelineTask[] => [
    t('schema', { phase: 1, assignee: 'claude', state: 'done' }),
    t('api', { phase: 2, assignee: 'cursor', dependsOn: ['schema'] }),
    t('ui', { phase: 3, assignee: 'claude', dependsOn: ['api'] }),
    t('docs', { phase: 2, assignee: null }),
  ];

  it('offers a task assigned to this agent whose deps are done', () => {
    expect(eligibleFor('cursor', plan()).map((x) => x.slug)).toEqual(['api', 'docs']);
  });

  it('withholds another agent\'s task but keeps the unassigned pool', () => {
    // This is how an idle agent helps finish a phase full of someone else's work.
    expect(eligibleFor('antigravity', plan()).map((x) => x.slug)).toEqual(['docs']);
  });

  it('locks a later phase even when its own deps are satisfied', () => {
    const tasks = [
      t('api', { phase: 2, state: 'active' }),
      t('ui', { phase: 3, dependsOn: [] }), // no deps at all, still locked
    ];
    expect(eligibleFor('claude', tasks).map((x) => x.slug)).toEqual([]);
  });

  it('opens the next phase the moment the barrier lifts', () => {
    const tasks = [
      t('api', { phase: 2, state: 'done' }),
      t('ui', { phase: 3, dependsOn: ['api'] }),
    ];
    expect(eligibleFor('claude', tasks).map((x) => x.slug)).toEqual(['ui']);
  });

  it('never offers work that is already owned', () => {
    for (const state of ['claimed', 'active', 'blocked', 'review', 'done', 'cancelled'] as const) {
      expect(eligibleFor('claude', [t('x', { state })])).toEqual([]);
    }
  });

  it('withholds a task whose dependency was cancelled', () => {
    // Cancelled is terminal for the PHASE but is not success, so a dependent
    // must not silently proceed as though the work had been done.
    const tasks = [t('schema', { phase: 1, state: 'cancelled' }), t('api', { phase: 1, dependsOn: ['schema'] })];
    expect(eligibleFor('claude', tasks).map((x) => x.slug)).toEqual([]);
  });

  it('withholds a task pointing at a dependency that does not exist', () => {
    expect(eligibleFor('claude', [t('api', { dependsOn: ['ghost'] })])).toEqual([]);
  });

  it('keeps ungated legacy tasks available alongside a running plan', () => {
    const tasks = [t('legacy'), t('api', { phase: 2 }), t('ui', { phase: 3 })];
    expect(eligibleFor('claude', tasks).map((x) => x.slug)).toEqual(['legacy', 'api']);
  });

  describe('team mode — done must also mean fetchable', () => {
    const tasks = (): PipelineTask[] => [
      t('schema', { phase: 1, state: 'done', pushedSha: 'abc123' }),
      t('api', { phase: 1, dependsOn: ['schema'] }),
    ];

    it('starts once the dependency\'s commits can be fetched', () => {
      const isFetchable = (sha?: string) => sha === 'abc123';
      expect(eligibleFor('claude', tasks(), { isFetchable }).map((x) => x.slug)).toEqual(['api']);
    });

    it('waits while the dependency is done but unpushed', () => {
      // Otherwise the agent builds against a schema that exists only on a
      // teammate's disk.
      const unpushed = [t('schema', { phase: 1, state: 'done' }), t('api', { phase: 1, dependsOn: ['schema'] })];
      expect(eligibleFor('claude', unpushed, { isFetchable: () => false })).toEqual([]);
    });

    it('solo mode does not ask the question at all', () => {
      const unpushed = [t('schema', { phase: 1, state: 'done' }), t('api', { phase: 1, dependsOn: ['schema'] })];
      expect(eligibleFor('claude', unpushed).map((x) => x.slug)).toEqual(['api']);
    });
  });
});

describe('isStalled / takeable — computed, never stored', () => {
  const now = 1_800_000_000_000;
  const opts = (ageMs: number) => ({ now, livenessOf: () => now - ageMs });

  it('an active agent silent past the grace window is takeable', () => {
    expect(isStalled(t('x', { state: 'active' }), opts(STALL_GRACE_MS + 1))).toBe(true);
  });

  it('an agent inside the window is NOT takeable', () => {
    expect(isStalled(t('x', { state: 'active' }), opts(STALL_GRACE_MS - 1))).toBe(false);
  });

  /**
   * The flaw this pins: the MCP heartbeat only advances on tool calls, so an
   * agent running a 20-minute build looks silent. Liveness is the NEWER of the
   * heartbeat and the worktree's mtime — a heartbeat-only rule would hand a
   * healthy agent's live worktree to somebody else, which is the exact
   * double-write takeover exists to prevent.
   */
  it('a silent agent whose worktree is still changing is alive', () => {
    const heartbeat = now - 90 * 60_000;   // 90 min of no tool calls
    const mtime = now - 2 * 60_000;        // but files changed 2 min ago
    const livenessOf = () => Math.max(heartbeat, mtime);
    expect(isStalled(t('x', { state: 'active' }), { now, livenessOf })).toBe(false);
  });

  it('only active work can stall — queued and done never do', () => {
    for (const state of ['queued', 'done', 'cancelled', 'review'] as const) {
      expect(isStalled(t('x', { state }), opts(STALL_GRACE_MS * 10))).toBe(false);
    }
  });

  it('takeover ignores assignee — whoever is free finishes it', () => {
    const tasks = [t('a', { state: 'active', assignee: 'claude' }), t('b', { state: 'queued', assignee: 'claude' })];
    expect(takeable(tasks, opts(STALL_GRACE_MS + 1)).map((x) => x.slug)).toEqual(['a']);
  });
});

describe('blockers — an empty answer must carry its cause', () => {
  it('names the phase holding the barrier', () => {
    const tasks = [t('api', { phase: 2, state: 'active' }), t('ui', { phase: 3 })];
    expect(blockers(tasks)).toEqual([
      { slug: 'api', reason: 'active' },
      { slug: 'ui', reason: 'phase 3 locked behind phase 2' },
    ]);
  });

  it('reports a blocked task\'s own reason, so a human knows what to decide', () => {
    const tasks = [t('api', { phase: 1, state: 'blocked', stoppedReason: 'needs staging DB credentials' })];
    expect(blockers(tasks)[0].reason).toBe('blocked — needs staging DB credentials');
  });

  it('names who holds a claimed task', () => {
    const tasks = [t('api', { state: 'active', claimedBy: { agent: 'cursor', sessionSlug: 's', at: '' } })];
    expect(blockers(tasks)[0].reason).toBe('active (cursor)');
  });

  it('distinguishes an unpushed dependency from an unfinished one', () => {
    const done = [t('s', { state: 'done' }), t('a', { dependsOn: ['s'] })];
    expect(blockers(done, { isFetchable: () => false })[0].reason).toBe("waiting for 's' to be pushed");
    const undone = [t('s', { state: 'active' }), t('a', { dependsOn: ['s'] })];
    expect(blockers(undone).find((b) => b.slug === 'a')!.reason).toBe("depends on 's' (active)");
  });

  it('says so when a dependency was cancelled rather than letting it vanish', () => {
    const tasks = [t('s', { state: 'cancelled' }), t('a', { dependsOn: ['s'] })];
    expect(blockers(tasks)[0].reason).toBe("depends on 's', which was cancelled");
  });

  it('is empty when everything is finished', () => {
    expect(blockers([t('a', { state: 'done' }), t('b', { state: 'cancelled' })])).toEqual([]);
  });
});

describe('isDeadlocked — needs you, versus finished', () => {
  it('a finished plan is not deadlocked', () => {
    expect(isDeadlocked([t('a', { state: 'done' })])).toBe(false);
    expect(isDeadlocked([])).toBe(false);
  });

  it('work in progress is not deadlocked', () => {
    expect(isDeadlocked([t('a', { state: 'active' }), t('b', { phase: 2 })])).toBe(false);
  });

  it('every remaining task waiting on a human IS deadlocked', () => {
    const tasks = [
      t('api', { phase: 1, state: 'blocked', assignee: 'claude' }),
      t('ui', { phase: 2, assignee: 'cursor', dependsOn: ['api'] }),
    ];
    expect(isDeadlocked(tasks)).toBe(true);
  });

  it('is NOT deadlocked while an unassigned task is still startable', () => {
    const tasks = [
      t('api', { phase: 1, state: 'blocked' }),
      t('spare', { phase: 1, assignee: null }),
    ];
    expect(isDeadlocked(tasks)).toBe(false);
  });

  it('catches the team-mode deadlock: everything done but nothing pushed', () => {
    const tasks = [t('s', { phase: 1, state: 'done' }), t('a', { phase: 1, dependsOn: ['s'] })];
    expect(isDeadlocked(tasks, { isFetchable: () => false })).toBe(true);
  });
});

describe('phaseComplete — when the barrier may lift', () => {
  it('requires every task in the phase to be terminal', () => {
    const tasks = [t('a', { phase: 1, state: 'done' }), t('b', { phase: 1, state: 'active' })];
    expect(phaseComplete(tasks, 1)).toBe(false);
  });

  it('accepts done and cancelled together', () => {
    const tasks = [t('a', { phase: 1, state: 'done' }), t('b', { phase: 1, state: 'cancelled' })];
    expect(phaseComplete(tasks, 1)).toBe(true);
  });

  it('an empty phase is not "complete" — there is nothing to integrate', () => {
    expect(phaseComplete([t('a', { phase: 2 })], 1)).toBe(false);
  });
});

describe('integrationHold — a phase is over when it lands, not when it is marked done', () => {
  // Phase 1 finished; phase 2 waiting. `integrated` is the injected git fact.
  const plan = [
    t('schema', { phase: 1, state: 'done' }),
    t('seed', { phase: 1, state: 'done' }),
    t('api', { phase: 2 }),
  ];

  it('holds the barrier at a finished phase whose branches have not landed', () => {
    expect(integrationHold(plan, { integrated: () => false })).toBe(1);
    expect(openPhase(plan, { integrated: () => false })).toBe(1);
  });

  it('lifts the moment that phase is integrated', () => {
    expect(integrationHold(plan, { integrated: () => true })).toBe(null);
    expect(openPhase(plan, { integrated: () => true })).toBe(2);
  });

  it('keeps the old behaviour when nobody injects the fact', () => {
    // Solo mode never asks git, and must not start reporting a hold it cannot
    // check — omitting `integrated` has to mean exactly what it meant before.
    expect(integrationHold(plan)).toBe(null);
    expect(openPhase(plan)).toBe(2);
  });

  it('withholds phase-2 work from every agent while phase 1 is unlanded', () => {
    expect(eligibleFor('claude', plan, { integrated: () => false })).toEqual([]);
    expect(eligibleFor('claude', plan, { integrated: () => true }).map((x) => x.slug)).toEqual(['api']);
  });

  it('says the phase is finished-but-unintegrated, not that it is still running', () => {
    // "locked behind phase 1" would send someone hunting for an agent that
    // finished hours ago. The outstanding thing is the branches.
    const [b] = blockers(plan, { integrated: () => false });
    expect(b?.reason).toContain('phase 1 is finished but not integrated');
    expect(b?.reason).toContain('baton integrate');
  });

  it('holds at the LOWEST unintegrated phase, not the most recent one', () => {
    const two = [
      t('a', { phase: 1, state: 'done' }),
      t('b', { phase: 2, state: 'done' }),
      t('c', { phase: 3 }),
    ];
    expect(integrationHold(two, { integrated: (p) => p !== 1 })).toBe(1);
  });

  it('reports no hold once the plan is finished — nothing is waiting on it', () => {
    // Every task terminal: there is no next phase to lock, so a hold here would
    // turn "your plan is done" into a false alarm about branches.
    const finished = [t('a', { phase: 1, state: 'done' }), t('b', { phase: 2, state: 'done' })];
    expect(integrationHold(finished, { integrated: () => false })).toBe(null);
  });

  it('does not hold on a phase that never had any tasks', () => {
    // phaseComplete is false for an empty phase, so a plan numbered 1 then 3
    // must not wedge on the gap between them.
    const gap = [t('a', { phase: 1, state: 'done' }), t('c', { phase: 3 })];
    expect(integrationHold(gap, { integrated: (p) => p !== 2 })).toBe(null);
  });
});
