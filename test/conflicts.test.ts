// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { holderProjects, computeConflictsFromSets } from '../src/conflicts.js';

describe('computeConflictsFromSets', () => {
  it('flags files shared between tasks on both sides', () => {
    const sets = new Map([
      ['navbar', new Set(['src/Nav.tsx', 'src/a.ts'])],
      ['header', new Set(['src/Nav.tsx', 'src/b.ts'])],
    ]);
    const out = computeConflictsFromSets(sets);
    expect(out.get('navbar')).toEqual(['src/Nav.tsx']);
    expect(out.get('header')).toEqual(['src/Nav.tsx']);
  });

  it('reports no conflict for disjoint file sets', () => {
    const sets = new Map([
      ['a', new Set(['x.ts'])],
      ['b', new Set(['y.ts'])],
    ]);
    const out = computeConflictsFromSets(sets);
    expect(out.get('a')).toEqual([]);
    expect(out.get('b')).toEqual([]);
  });

  it('handles three-way overlap and sorts the result', () => {
    const sets = new Map([
      ['a', new Set(['z.ts', 'shared.ts'])],
      ['b', new Set(['shared.ts'])],
      ['c', new Set(['shared.ts', 'q.ts'])],
    ]);
    const out = computeConflictsFromSets(sets);
    expect(out.get('a')).toEqual(['shared.ts']);
    expect(out.get('b')).toEqual(['shared.ts']);
    expect(out.get('c')).toEqual(['shared.ts']);
  });

  it('a single task never conflicts with itself', () => {
    const sets = new Map([['solo', new Set(['a.ts', 'b.ts'])]]);
    expect(computeConflictsFromSets(sets).get('solo')).toEqual([]);
  });
});

/**
 * Only tasks record `projectId`, but three kinds of holder appear in signals.
 * Publishing the other two as null let them match ANY project on the receiving
 * side, so a teammate's `src/index.ts` in proj-a read as a hold on proj-b's.
 */
describe('holderProjects — which sub-project a holder belongs to', () => {
  const projects = [{ id: 'proj-a', path: '/hub/proj-a' }, { id: 'proj-b', path: '/hub/proj-b' }];

  it('takes a task\'s recorded projectId', () => {
    const m = holderProjects([{ slug: 'fix-auth', projectId: 'proj-a' }], projects);
    expect(m.get('fix-auth')).toBe('proj-a');
  });

  it('reads the id straight out of a co-* checkout slug', () => {
    const m = holderProjects([], projects);
    expect(m.get('co-proj-a')).toBe('proj-a');
    expect(m.get('co-proj-b')).toBe('proj-b');
  });

  it('places a root session by the checkout it connected from', () => {
    const m = holderProjects([], projects, [{ slug: 'sess-abc', root: '/hub/proj-b' }]);
    expect(m.get('sess-abc')).toBe('proj-b');
  });

  it('ignores a trailing separator on the session root', () => {
    const m = holderProjects([], projects, [{ slug: 'sess-abc', root: '/hub/proj-b/' }]);
    expect(m.get('sess-abc')).toBe('proj-b');
  });

  it('leaves a hub-root session unplaced — it belongs to no ONE project', () => {
    // Absent, not null-valued: callers must read this as "do not scope".
    // Guessing a project here would hide a real collision, which loses data.
    const m = holderProjects([], projects, [{ slug: 'sess-hub', root: '/hub' }]);
    expect(m.has('sess-hub')).toBe(false);
  });

  it('leaves a session with no root unplaced', () => {
    expect(holderProjects([], projects, [{ slug: 'sess-x', root: null }]).has('sess-x')).toBe(false);
  });

  it('a task\'s own projectId wins over a same-named session root', () => {
    const m = holderProjects([{ slug: 'dup', projectId: 'proj-a' }], projects, [{ slug: 'dup', root: '/hub/proj-b' }]);
    expect(m.get('dup')).toBe('proj-a');
  });

  it('places nothing in a single-repo setup, where there are no sub-projects', () => {
    expect(holderProjects([{ slug: 'fix' }], []).size).toBe(0);
  });
});
