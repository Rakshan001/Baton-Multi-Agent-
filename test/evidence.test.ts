// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { outOfScopeFiles, renderChecks, verdictFor, type Evidence } from '../src/evidence.js';

const base = (over: Partial<Evidence> = {}): Evidence => ({
  commits: 2, headSha: 'abc1234def', files: ['src/auth/token.ts'],
  scope: ['src/auth/**'], dirtyFiles: [], conflictFiles: [], expects: [], attested: false,
  ...over,
});

describe('verdictFor', () => {
  it('passes clean work', () => {
    const v = verdictFor(base());
    expect(v.pass).toBe(true);
    expect(v.refusals).toEqual([]);
  });

  /**
   * The one failure this gate catches completely, and the most expensive one in
   * a five-agent pipeline: an agent that ran out of context and reported success
   * anyway. Every downstream phase would then build on nothing.
   */
  it('refuses done with zero commits', () => {
    const v = verdictFor(base({ commits: 0 }));
    expect(v.pass).toBe(false);
    expect(v.refusals[0].label).toContain('no commits');
    expect(v.refusals[0].detail).toContain('baton pause');
  });

  /** A merge takes the branch; anything left in the worktree is silently lost. */
  it('refuses uncommitted changes', () => {
    const v = verdictFor(base({ dirtyFiles: ['src/auth/token.ts'] }));
    expect(v.pass).toBe(false);
    expect(v.refusals[0].label).toContain('uncommitted');
  });

  it('refuses conflict markers', () => {
    const v = verdictFor(base({ conflictFiles: ['src/auth/token.ts'] }));
    expect(v.refusals[0].label).toContain('conflict markers');
  });

  /**
   * Recorded, never refused. A real fix often needs one line somewhere the plan
   * did not predict, and refusing would just teach agents to declare `**`.
   */
  it('records out-of-scope edits without blocking', () => {
    const v = verdictFor(base({ files: ['src/auth/token.ts', 'src/db/schema.ts'] }));
    expect(v.pass).toBe(true);
    expect(v.outOfScope).toEqual(['src/db/schema.ts']);
    expect(v.checks.some((c) => c.level === 'warn')).toBe(true);
  });

  it('treats an undeclared scope as a claim about nothing', () => {
    const v = verdictFor(base({ scope: [], files: ['anywhere.ts'] }));
    expect(v.outOfScope).toEqual([]);
    expect(v.pass).toBe(true);
  });

  /** An attestation is an agent's claim. Labelled so nobody reads it as a test run. */
  it('holds the task until the agent attests to what the plan expects', () => {
    const v = verdictFor(base({ expects: ['vitest test/auth passes'] }));
    expect(v.pass).toBe(false);
    expect(v.checks.some((c) => c.level === 'attest')).toBe(true);
  });

  it('passes once attested, and says the claim is unverified', () => {
    const v = verdictFor(base({ expects: ['vitest test/auth passes'], attested: true }));
    expect(v.pass).toBe(true);
    expect(v.checks.find((c) => c.label.startsWith('attested'))?.detail).toContain('not verified');
  });

  /** --attest must not buy past a real refusal — it is a claim about tests, not
   *  a claim that commits exist. */
  it('does not let an attestation override zero commits', () => {
    const v = verdictFor(base({ commits: 0, expects: ['it works'], attested: true }));
    expect(v.pass).toBe(false);
    expect(v.refusals[0].label).toContain('no commits');
  });

  it('reports every problem at once', () => {
    const v = verdictFor(base({ commits: 0, dirtyFiles: ['a.ts'], conflictFiles: ['b.ts'] }));
    expect(v.refusals).toHaveLength(3);
  });
});

describe('outOfScopeFiles', () => {
  it('accepts a file beneath a declared glob', () => {
    expect(outOfScopeFiles(['src/db/schema.ts'], ['src/db/**'])).toEqual([]);
  });
  it('flags a sibling directory', () => {
    expect(outOfScopeFiles(['src/ui/App.tsx'], ['src/db/**'])).toEqual(['src/ui/App.tsx']);
  });
  it('does not confuse a name prefix for a directory', () => {
    expect(outOfScopeFiles(['src/dbutil.ts'], ['src/db/**'])).toEqual(['src/dbutil.ts']);
  });
});

describe('renderChecks', () => {
  it('marks each level distinctly', () => {
    const text = renderChecks(verdictFor(base({ commits: 0, files: ['x.ts', 'src/auth/a.ts'] })).checks).join('\n');
    expect(text).toContain('✗');
    expect(text).toContain('ok');
  });
});
