import { describe, it, expect } from 'vitest';
import { computeConflictsFromSets } from '../src/conflicts.js';

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
