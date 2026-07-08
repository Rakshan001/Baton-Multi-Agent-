import { describe, it, expect } from 'vitest';
import { scopesOverlap, overlappingScopes } from '../src/conflicts.js';
import type { Task } from '../src/store.js';

describe('scopesOverlap — do two sets of path globs touch the same area?', () => {
  it('non-overlapping directories do not conflict', () => {
    expect(scopesOverlap(['src/auth/**'], ['src/billing/**'])).toBe(false);
  });
  it('a directory glob contains a file under it', () => {
    expect(scopesOverlap(['src/auth/**'], ['src/auth/token.ts'])).toBe(true);
  });
  it('a broad glob contains a narrower one', () => {
    expect(scopesOverlap(['src/**'], ['src/auth/**'])).toBe(true);
  });
  it('distinct files do not conflict; identical files do', () => {
    expect(scopesOverlap(['src/a.ts'], ['src/b.ts'])).toBe(false);
    expect(scopesOverlap(['src/a.ts'], ['src/a.ts'])).toBe(true);
  });
  it('overlap if ANY pair across the two scope sets overlaps', () => {
    expect(scopesOverlap(['lib/x.ts', 'src/auth/**'], ['src/auth/y.ts'])).toBe(true);
  });
  it('an empty scope on either side makes no overlap claim', () => {
    expect(scopesOverlap([], ['src/**'])).toBe(false);
    expect(scopesOverlap(['src/**'], [])).toBe(false);
  });
  it('does not treat a shared prefix string as containment (auth vs authorization)', () => {
    expect(scopesOverlap(['src/auth/**'], ['src/authorization/**'])).toBe(false);
  });
});

describe('overlappingScopes — which existing tasks clash with a candidate scope', () => {
  const mk = (slug: string, scope?: string[]): Task => ({
    slug, task: slug, branch: `baton/${slug}`, worktreePath: `/wt/${slug}`,
    baseBranch: 'main', baseCommit: null, createdAt: '2026-07-08T00:00:00.000Z', scope,
  });

  it('returns only the tasks whose declared scope overlaps', () => {
    const tasks = [mk('billing', ['src/billing/**']), mk('auth-refactor', ['src/auth/**']), mk('no-scope')];
    const clashes = overlappingScopes(['src/auth/token.ts'], tasks);
    expect(clashes.map((c) => c.slug)).toEqual(['auth-refactor']);
  });

  it('returns nothing when the candidate has no scope', () => {
    expect(overlappingScopes([], [mk('auth-refactor', ['src/auth/**'])])).toEqual([]);
  });
});
