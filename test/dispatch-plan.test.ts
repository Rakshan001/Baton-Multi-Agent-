// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P3 step 2 — the decision, before anything spawns.
 *
 * Every refusal here is a process that did NOT start. That is the point: the
 * alternative to refusing is discovering mid-launch that the agent the plan
 * promised cannot run, having already claimed the task — the "looks busy and
 * isn't" state P3-E7 names as the worst one.
 *
 * Pure: no fs, no git, no clock. The whole failure matrix is a unit test.
 */
import { describe, it, expect } from 'vitest';
import { planDispatch, type DispatchInput, type DispatchTask } from '../src/dispatch.js';
import type { AgentCapability } from '../src/executors/types.js';
import type { RoutingConfig } from '../src/routing.js';

function cap(over: Partial<AgentCapability> & { agentId: string }): AgentCapability {
  return {
    nativeId: over.agentId, modes: ['headless'], supportsModel: true,
    acceptsPromptAtLaunch: true, installed: true, ...over,
  };
}

const CAPS = new Map<string, AgentCapability>([
  ['claude', cap({ agentId: 'claude' })],
  ['codex', cap({ agentId: 'codex' })],
  ['cursor', cap({ agentId: 'cursor', nativeId: 'cursor-agent', modes: ['interactive'], supportsModel: false })],
  ['antigravity', cap({ agentId: 'antigravity', modes: [] })],
  ['gemini', cap({ agentId: 'gemini', installed: false })],
]);

const ROUTING: RoutingConfig = {
  mode: 'auto', default: 'claude',
  rules: [{ match: ['frontend', 'ui'], agent: 'cursor' }],
  tiers: {},
};

function task(over: Partial<DispatchTask> & { slug: string }): DispatchTask {
  return { task: 'Do the thing.', phase: 1, state: 'queued', dependsOn: [], assignee: null, ...over };
}

function input(over: Partial<DispatchInput> = {}): DispatchInput {
  return {
    tasks: [task({ slug: 'a' })],
    caps: CAPS,
    backend: 'local',
    routing: ROUTING,
    running: { total: 0, byAgent: {} },
    limits: { maxConcurrent: 3, maxPerAgent: 1 },
    ...over,
  };
}

describe('planDispatch — precedence', () => {
  it('2: the plan\'s assignee is honoured even when routing disagrees', async () => {
    // The routing rule below says `cursor` for a frontend task. The plan says
    // codex. A plan's `@agent` is an instruction, not a hint.
    const r = await planDispatch(input({
      tasks: [task({ slug: 'a', task: 'frontend ui work', assignee: 'codex' })],
    }));
    expect(r.launches).toHaveLength(1);
    expect(r.launches[0]).toMatchObject({ slug: 'a', agentId: 'codex', source: 'plan' });
  });

  it('1: --agent outranks the plan, and says it did (P3-E12)', async () => {
    const r = await planDispatch(input({
      tasks: [task({ slug: 'a', assignee: 'codex' })],
      agentFlag: 'claude',
    }));
    expect(r.launches[0]).toMatchObject({ agentId: 'claude', source: 'flag' });
  });

  it('3: an unassigned task is routed, and the route is recorded as such', async () => {
    const r = await planDispatch(input({
      tasks: [task({ slug: 'a', task: 'Rework the frontend ui' })],
    }));
    expect(r.launches[0]).toMatchObject({ agentId: 'cursor', source: 'routing' });
  });

  it('3: routing availability is the executor capability map, not a binary probe', async () => {
    // `antigravity` has no launcher in the local backend. A probe would find
    // its CLI and say yes; the capability map knows it cannot be started, so
    // the chain falls through to the next entry instead of promising a launch.
    const r = await planDispatch(input({
      routing: { mode: 'auto', default: 'x', rules: [], tiers: { heavy: [{ agent: 'antigravity' }, { agent: 'claude' }] } },
      tasks: [task({ slug: 'a' })],
    }));
    expect(r.launches[0]).toMatchObject({ agentId: 'claude', source: 'routing' });
    expect(r.launches[0]!.skipped).toEqual(['antigravity']);
  });

  it('4: manual mode never dispatches — it asks', async () => {
    const r = await planDispatch(input({
      routing: { ...ROUTING, mode: 'manual' },
      tasks: [task({ slug: 'a' })],
    }));
    expect(r.launches).toEqual([]);
    expect(r.refusals[0]).toMatchObject({ slug: 'a', code: 'needs-agent' });
  });

  it('5: nothing resolvable stays queued and says why', async () => {
    const r = await planDispatch(input({
      routing: { mode: 'auto', default: 'gemini', rules: [], tiers: {} },
      tasks: [task({ slug: 'a' })],
    }));
    expect(r.launches).toEqual([]);
    expect(r.refusals[0]!.code).toBe('no-route');
  });
});

describe('planDispatch — refuse, never substitute', () => {
  it('refuses an assignee this backend cannot launch, rather than running another agent', async () => {
    // This refusal IS the feature. The alternative silently bills the user for
    // a model they did not choose and makes the plan\'s split a fiction.
    const r = await planDispatch(input({ tasks: [task({ slug: 'a', assignee: 'antigravity' })] }));
    expect(r.launches).toEqual([]);
    expect(r.refusals[0]).toMatchObject({ slug: 'a', code: 'no-mode', agentId: 'antigravity' });
    expect(r.refusals[0]!.reason).toMatch(/orca/i);
  });

  it('refuses an assignee whose CLI is not installed', async () => {
    const r = await planDispatch(input({ tasks: [task({ slug: 'a', assignee: 'gemini' })] }));
    expect(r.refusals[0]!.code).toBe('not-installed');
  });

  it('refuses an agent the backend has never heard of', async () => {
    const r = await planDispatch(input({ tasks: [task({ slug: 'a', assignee: 'nonesuch' })] }));
    expect(r.refusals[0]!.code).toBe('unknown-agent');
  });

  it('refuses a model the agent cannot be started with', async () => {
    const r = await planDispatch(input({
      tasks: [task({ slug: 'a', assignee: 'cursor', model: 'sonnet' })],
    }));
    expect(r.refusals[0]!.code).toBe('no-model');
  });

  it('routes around an agent that cannot honour the model the plan asked for', async () => {
    // A chain is a fallback the user declared, so walking past `cursor` here is
    // honouring their config -- not substituting for a named assignee.
    const r = await planDispatch(input({
      routing: { mode: 'auto', default: 'x', rules: [], tiers: { heavy: [{ agent: 'cursor' }, { agent: 'claude' }] } },
      tasks: [task({ slug: 'a', model: 'sonnet' })],
    }));
    expect(r.launches[0]).toMatchObject({ agentId: 'claude', model: 'sonnet' });
  });

  it('refuses an agent that would never be handed its brief', async () => {
    // aider and opencode take a prompt argument and use only the model. Started
    // headlessly they run with no task at all -- a claimed task with a process
    // that will never read HANDOFF.md is the P3-E7 state, reached on purpose.
    const caps = new Map(CAPS);
    caps.set('aider', cap({ agentId: 'aider', acceptsPromptAtLaunch: false }));
    const r = await planDispatch(input({ caps, tasks: [task({ slug: 'a', assignee: 'aider' })] }));
    expect(r.refusals[0]!.code).toBe('no-prompt');
  });

  it('carries the plan\'s model onto the launch', async () => {
    const r = await planDispatch(input({ tasks: [task({ slug: 'a', assignee: 'claude', model: 'sonnet' })] }));
    expect(r.launches[0]!.model).toBe('sonnet');
  });
});

describe('planDispatch — the barrier is not re-derived (P3-E5)', () => {
  const TASKS = [
    task({ slug: 'p1', phase: 1, assignee: 'claude' }),
    task({ slug: 'p2', phase: 2, assignee: 'claude' }),
  ];

  it('leaves a later phase locked while an earlier one has work left', async () => {
    const r = await planDispatch(input({ tasks: TASKS }));
    expect(r.launches.map((l) => l.slug)).toEqual(['p1']);
    expect(r.refusals.find((x) => x.slug === 'p2')).toMatchObject({ code: 'not-startable' });
    expect(r.refusals.find((x) => x.slug === 'p2')!.reason).toMatch(/phase 2 locked behind phase 1/);
  });

  it('holds the barrier when an integration gate says the phase has not landed', async () => {
    const tasks = [task({ slug: 'p1', phase: 1, state: 'done' }), task({ slug: 'p2', phase: 2 })];
    const r = await planDispatch(input({ tasks, gate: { integrated: () => false } }));
    expect(r.launches).toEqual([]);
    expect(r.refusals[0]!.reason).toMatch(/not integrated/);
  });

  it('will not start a task whose dependency is unfinished', async () => {
    const tasks = [task({ slug: 'a' }), task({ slug: 'b', dependsOn: ['a'] })];
    const r = await planDispatch(input({ tasks }));
    expect(r.launches.map((l) => l.slug)).toEqual(['a']);
    expect(r.refusals.find((x) => x.slug === 'b')!.reason).toMatch(/depends on 'a'/);
  });
});

describe('planDispatch — capacity (P3-E4)', () => {
  const FIVE = ['a', 'b', 'c', 'd', 'e'].map((s) => task({ slug: s, assignee: null }));

  it('queues the overflow under refusals rather than dropping it', async () => {
    const r = await planDispatch(input({
      tasks: FIVE, limits: { maxConcurrent: 2, maxPerAgent: 9 },
    }));
    expect(r.launches).toHaveLength(2);
    expect(r.refusals.filter((x) => x.code === 'at-capacity')).toHaveLength(3);
  });

  it('counts runs already in flight against the cap', async () => {
    const r = await planDispatch(input({
      tasks: FIVE, limits: { maxConcurrent: 2, maxPerAgent: 9 },
      running: { total: 2, byAgent: { claude: 2 } },
    }));
    expect(r.launches).toEqual([]);
    expect(r.refusals.every((x) => x.code === 'at-capacity')).toBe(true);
  });

  it('enforces the per-agent cap separately from the total', async () => {
    const r = await planDispatch(input({
      tasks: FIVE, limits: { maxConcurrent: 9, maxPerAgent: 1 },
    }));
    expect(r.launches).toHaveLength(1);
    expect(r.refusals[0]!.code).toBe('per-agent-capacity');
  });

  it('--max caps this run without touching the configured limits', async () => {
    const r = await planDispatch(input({
      tasks: FIVE, limits: { maxConcurrent: 9, maxPerAgent: 9 }, max: 2,
    }));
    expect(r.launches).toHaveLength(2);
    expect(r.refusals.filter((x) => x.code === 'at-capacity')).toHaveLength(3);
  });

  it('gives the slots to the earliest phase, in plan order', async () => {
    const tasks = [
      task({ slug: 'late', phase: 1 }),
      task({ slug: 'early', phase: 1 }),
    ];
    const r = await planDispatch(input({ tasks, limits: { maxConcurrent: 1, maxPerAgent: 9 } }));
    expect(r.launches[0]!.slug).toBe('late'); // plan order, not alphabetical
  });
});

describe('planDispatch — re-dispatch is a no-op (P3-E3)', () => {
  it('skips a task somebody already holds', async () => {
    const tasks = [task({
      slug: 'a', state: 'active', assignee: 'claude',
      claimedBy: { agent: 'claude', sessionSlug: 'a', at: '2026-08-22T10:00:00Z' },
    })];
    const r = await planDispatch(input({ tasks }));
    expect(r.launches).toEqual([]);
    expect(r.refusals[0]).toMatchObject({ code: 'not-startable' });
    expect(r.refusals[0]!.reason).toMatch(/claude/);
  });

  it('says nothing at all about finished work', async () => {
    // A done task is not a refusal. Listing it would make every re-dispatch of
    // a nearly-complete plan read as a wall of failures.
    const r = await planDispatch(input({ tasks: [task({ slug: 'a', state: 'done' })] }));
    expect(r.launches).toEqual([]);
    expect(r.refusals).toEqual([]);
  });
});

describe('planDispatch — scope', () => {
  it('considers only the plan being dispatched', async () => {
    const tasks = [
      task({ slug: 'mine', planId: 'p1', assignee: 'claude' }),
      task({ slug: 'theirs', planId: 'p2', assignee: 'claude' }),
    ];
    const r = await planDispatch(input({ tasks, planId: 'p1' }));
    expect(r.launches.map((l) => l.slug)).toEqual(['mine']);
    expect(r.refusals.find((x) => x.slug === 'theirs')).toBeUndefined();
  });

  it('still reads the whole board when deciding whether a phase is open', async () => {
    // Another plan's unfinished phase-1 task does not gate this plan, but this
    // plan's own dependencies may point at tasks outside the filter.
    const tasks = [
      task({ slug: 'dep', planId: 'p2', state: 'queued' }),
      task({ slug: 'mine', planId: 'p1', dependsOn: ['dep'], assignee: 'claude' }),
    ];
    const r = await planDispatch(input({ tasks, planId: 'p1' }));
    expect(r.launches).toEqual([]);
    expect(r.refusals[0]!.reason).toMatch(/depends on 'dep'/);
  });

  it('an `any` chain entry resolves to something that can actually launch', async () => {
    const r = await planDispatch(input({
      routing: { mode: 'auto', default: 'x', rules: [], tiers: { heavy: [{ agent: 'any' }] } },
      tasks: [task({ slug: 'a' })],
    }));
    expect(r.launches[0]!.agentId).toBe('claude'); // first launchable, deterministically
  });
});
