// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Team Sync v2 §7.1 — the fold task → pipeline row projection.
 */
import { describe, it, expect } from 'vitest';
import { TASK_STATES, effectivePriority, isTeamTask, type TaskState } from '../src/pipeline.js';
import { matchProjects, normalizeRemote } from '../src/team/projects.js';
import {
  TASK_STATE_OF, TEAM_STATE_OF, isHeldHere, levelOf, materialize, priorityFromLevel,
  projectDefOf, projectionMatches, taskStateOf, teamStateOf,
} from '../src/team/materialize.js';
import { MAX_REMINDER_BOOST, type PriorityLevel, type TaskLifecycle, type TeamTask, type TeamTaskState } from '../src/team/types.js';

/** Every fold state. Typed as a Record so adding one to TeamTaskState fails to compile here. */
const TEAM_STATES = Object.keys({
  unassigned: 1, assigned: 1, acknowledged: 1, active: 1, blocked: 1, paused: 1, review: 1,
  changes: 1, approved: 1, pushed: 1, merged: 1, done: 1, cancelled: 1, 'needs-owner': 1,
} satisfies Record<TeamTaskState, 1>) as TeamTaskState[];

function lifecycle(over: Partial<TaskLifecycle> = {}): TaskLifecycle {
  return {
    state: 'unassigned', assignee: null, agent: null, assignLamport: null, acked: false, ackEvent: null,
    reminders: 0, holder: null, reviewSha: null, approvedSha: null, pushRequestSha: null, ...over,
  };
}

function teamTask(over: Partial<TeamTask> = {}, L: Partial<TaskLifecycle> = {}): TeamTask {
  return {
    id: 'dev1-4', project: 'prj_web1', createdBy: 'rakshan', createdEvent: 'e'.repeat(64), parent: null,
    title: 'Admin table', group: null, priority: 2, urgent: false, brief: null, briefRev: 0, noteRef: null,
    phase: null, dependsOn: [], review: true, lifecycle: lifecycle(L), effectivePriority: 2,
    conflict: null, lostClaims: [], lastEvent: 'f'.repeat(64), lastLamport: 1, ...over,
  };
}

describe('priority label ↔ level (C1)', () => {
  it('round-trips every level and label', () => {
    for (const lvl of [0, 1, 2, 3] as PriorityLevel[]) expect(levelOf(priorityFromLevel(lvl))).toBe(lvl);
    for (const p of ['P0', 'P1', 'P2', 'P3'] as const) expect(priorityFromLevel(levelOf(p))).toBe(p);
    expect(priorityFromLevel(0)).toBe('P0');
    expect(levelOf('P3')).toBe(3);
  });

  it('reads nonsense as the default', () => {
    expect(levelOf('P9' as never)).toBe(2);
    expect(priorityFromLevel(7 as never)).toBe('P2');
  });

  it('the row\'s effective priority equals the fold\'s formula for every priority × reminders', () => {
    for (const priority of [0, 1, 2, 3] as PriorityLevel[]) {
      for (let reminders = 0; reminders <= 5; reminders++) {
        const fold = Math.max(0, priority - Math.min(reminders, MAX_REMINDER_BOOST));
        expect(effectivePriority({ slug: 'x', ...materialize(teamTask({ priority }, { reminders })) })).toBe(fold);
      }
    }
  });
});

describe('state mapping (C2)', () => {
  it('is total and exhaustive over the fold states', () => {
    expect(Object.keys(TASK_STATE_OF).sort()).toEqual([...TEAM_STATES].sort());
    for (const s of TEAM_STATES) expect(TASK_STATES).toContain(taskStateOf(s));
  });

  it('is total over the row states', () => {
    expect(Object.keys(TEAM_STATE_OF).sort()).toEqual([...TASK_STATES].sort());
  });

  it('unassigned ↔ queued, the rest one-to-one', () => {
    expect(taskStateOf('unassigned')).toBe('queued');
    expect(teamStateOf('queued')).toBe('unassigned');
    for (const s of TEAM_STATES) {
      if (s !== 'unassigned') expect(taskStateOf(s)).toBe(s);
      expect(teamStateOf(taskStateOf(s))).toBe(s); // every fold state round-trips
    }
  });

  it('is injective, and only the local-only `claimed` has no team state', () => {
    expect(new Set(TEAM_STATES.map(taskStateOf)).size).toBe(TEAM_STATES.length);
    const unmapped = TASK_STATES.filter((s: TaskState) => teamStateOf(s) === null);
    expect(unmapped).toEqual(['claimed']);
    for (const s of TASK_STATES) {
      const t = teamStateOf(s);
      if (t !== null) expect(taskStateOf(t)).toBe(s);
    }
  });
});

describe('materialize (C3, C5 naming)', () => {
  it('projects a fold task onto team row fields', () => {
    const brief = { goal: 'g', inScope: ['a'], outOfScope: [], acceptance: ['ok'], skills: [] };
    const t = teamTask(
      { priority: 1, urgent: true, brief, briefRev: 3, phase: 2, dependsOn: ['dev1-1', 'dev2-9'], review: false },
      { state: 'acknowledged', assignee: 'priya', agent: 'claude', assignLamport: 42, reminders: 1 },
    );
    const p = materialize(t, { slugOf: (id) => (id === 'dev1-1' ? 'schema' : undefined) });
    expect(p).toEqual({
      origin: 'team', teamId: 'dev1-4', task: 'Admin table', state: 'acknowledged',
      priority: 'P1', urgent: true,
      member: 'priya',   // the PERSON  = lifecycle.assignee
      assignee: 'claude', // the AGENT = lifecycle.agent
      reminders: 1, briefRev: 3, brief, phase: 2, assignLamport: 42,
      dependsOn: ['schema', 'dev2-9'], // unknown ids stay, and so block
      requireReview: false,
    });
    expect(isTeamTask({ slug: 'x', ...p })).toBe(true);
  });

  it('maps nulls to the solo defaults and drops an unstructured brief', () => {
    const p = materialize(teamTask({ brief: 'free text' }));
    expect(p).toMatchObject({ state: 'queued', member: null, assignee: null, priority: 'P2' });
    expect(p.phase).toBeUndefined();
    expect(p.assignLamport).toBeUndefined();
    expect(p.brief).toBeUndefined();
  });

  it('is pure: same input, same output, input untouched', () => {
    const t = teamTask({ dependsOn: ['a'] }, { state: 'active', holder: 'dev1' });
    const snapshot = structuredClone(t);
    expect(materialize(t)).toEqual(materialize(t));
    expect(t).toEqual(snapshot);
  });

  it('isHeldHere names only the holder device', () => {
    const t = teamTask({}, { state: 'active', holder: 'dev1' });
    expect(isHeldHere(t, 'dev1')).toBe(true);
    expect(isHeldHere(t, 'dev2')).toBe(false);
  });
});

describe('projectionMatches', () => {
  const t = teamTask({ phase: 1 }, { state: 'review', assignee: 'priya', agent: 'claude', assignLamport: 3 });

  it('accepts a row carrying the projection plus its own local fields', () => {
    const row = { slug: 'admin-table', worktreePath: '/wt/x', claimedBy: { agent: 'claude', sessionSlug: 's', at: 'now' }, ...materialize(t) };
    expect(projectionMatches(row, t)).toBe(true);
  });

  it('flags a row whose team state was edited locally', () => {
    expect(projectionMatches({ ...materialize(t), state: 'approved' }, t)).toBe(false);
    expect(projectionMatches({ ...materialize(t), member: 'dev-c' }, t)).toBe(false);
    expect(projectionMatches({ ...materialize(t), dependsOn: ['x'] }, t)).toBe(false);
  });

  it('flags a row the fold has moved past', () => {
    const row = materialize(t);
    expect(projectionMatches(row, { ...t, lifecycle: { ...t.lifecycle, state: 'approved' } })).toBe(false);
  });
});

describe('fold project → ProjectDef (C5)', () => {
  const repo = (top: string, urls: string[]) => ({
    gitToplevel: top,
    remotes: urls.map((u, i) => ({ name: `r${i}`, url: u, normalized: normalizeRemote(u) })),
    rootCommits: [],
  });

  it('a null subpath becomes an absent one, and the project resolves', () => {
    const def = projectDefOf('prj_web1', { name: 'web', remotes: ['github.com/acme/web'], rootCommits: ['abc'], subpath: null });
    expect(def).toEqual({ key: 'prj_web1', name: 'web', remotes: ['github.com/acme/web'], rootCommits: ['abc'] });
    expect('subpath' in def).toBe(false);
    const out = matchProjects([def], [repo('/home/p/site', ['git@github.com:acme/web.git'])]);
    expect(out.prj_web1).toEqual({ match: 'remote', gitToplevel: '/home/p/site', candidates: ['/home/p/site'], needsChoice: false });
  });

  it('a set subpath is carried through to the resolution', () => {
    const def = projectDefOf('prj_pkg', { name: 'pkg', remotes: ['https://github.com/acme/mono'], rootCommits: [], subpath: 'packages/web' });
    const out = matchProjects([def], [repo('/m', ['https://github.com/acme/mono.git'])]);
    expect(out.prj_pkg).toMatchObject({ match: 'remote', gitToplevel: '/m', subpath: 'packages/web', needsChoice: false });
  });
});
