import { describe, it, expect } from 'vitest';
import { matchAgentToWorktree, detectAgents, resetDetectAgentsCache } from '../src/agents.js';

describe('matchAgentToWorktree', () => {
  const wt = '/repo/.baton/wt/navbar';

  it('matches when cwd equals the worktree path', () => {
    expect(matchAgentToWorktree(wt, wt)).toBe(true);
  });

  it('matches when cwd is nested inside the worktree', () => {
    expect(matchAgentToWorktree('/repo/.baton/wt/navbar/src', wt)).toBe(true);
  });

  it('does not match a sibling worktree', () => {
    expect(matchAgentToWorktree('/repo/.baton/wt/header', wt)).toBe(false);
  });

  it('does not match a prefix-but-not-boundary path', () => {
    // "navbar-2" must not match "navbar"
    expect(matchAgentToWorktree('/repo/.baton/wt/navbar-2', wt)).toBe(false);
  });

  it('does not match an unrelated path', () => {
    expect(matchAgentToWorktree('/somewhere/else', wt)).toBe(false);
  });
});

describe('detectAgents TTL cache', () => {
  it('reuses the scan within 2s for the same paths, rescans after and on key change', async () => {
    resetDetectAgentsCache();
    let calls = 0;
    const scan = async () => { calls++; return new Map([['/wt/a', 'claude']]); };
    let t = 1_000_000;
    const now = () => t;

    const r1 = await detectAgents(['/wt/a'], { scan, now });
    expect(r1.get('/wt/a')).toBe('claude');
    expect(calls).toBe(1);

    const r2 = await detectAgents(['/wt/a'], { scan, now }); // within TTL
    expect(calls).toBe(1);
    expect(r2).not.toBe(r1); // defensive copy, not the cached Map itself
    expect([...r2.entries()]).toEqual([...r1.entries()]);

    t += 2001; // TTL expired
    await detectAgents(['/wt/a'], { scan, now });
    expect(calls).toBe(2);

    await detectAgents(['/wt/a', '/wt/b'], { scan, now }); // different key
    expect(calls).toBe(3);
  });

  it('returns an empty map for no paths without scanning', async () => {
    resetDetectAgentsCache();
    let calls = 0;
    const scan = async () => { calls++; return new Map<string, string>(); };
    expect((await detectAgents([], { scan })).size).toBe(0);
    expect(calls).toBe(0);
  });
});
