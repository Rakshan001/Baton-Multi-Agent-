import { describe, it, expect } from 'vitest';
import { matchAgentToWorktree, detectAgents, resetDetectAgentsCache, detectRootAgents, resetDetectRootAgentsCache } from '../src/agents.js';

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

describe('detectRootAgents — agents at a hub/repo root, not tied to any task worktree', () => {
  // ppid defaults to 0 (no matched parent) — no collapse unless a test wires a chain.
  const proc = (pid: number, agent: string, cwd: string, ppid = 0) => ({ pid, ppid, agent, cwd });

  it('keeps processes whose cwd is inside an include path', async () => {
    resetDetectRootAgentsCache();
    const scan = async () => [proc(1, 'claude', '/hub'), proc(2, 'claude', '/hub/proj-a'), proc(3, 'cursor', '/elsewhere')];
    const r = await detectRootAgents(['/hub'], [], { scan });
    expect(r.map((p) => p.pid).sort()).toEqual([1, 2]);
  });

  it('excludes processes already attached to a task worktree', async () => {
    resetDetectRootAgentsCache();
    const scan = async () => [proc(1, 'claude', '/hub'), proc(2, 'claude', '/hub/.baton/wt/fix-auth')];
    const r = await detectRootAgents(['/hub'], ['/hub/.baton/wt/fix-auth'], { scan });
    expect(r.map((p) => p.pid)).toEqual([1]);
  });

  it('returns every matching process — multiple agents/sessions at the same root', async () => {
    resetDetectRootAgentsCache();
    const scan = async () => [proc(1, 'claude', '/hub'), proc(2, 'claude', '/hub'), proc(3, 'cursor', '/hub/proj-b')];
    const r = await detectRootAgents(['/hub', '/hub/proj-b'], [], { scan });
    expect(r).toHaveLength(3);
  });

  it('returns empty with no include paths, without scanning', async () => {
    resetDetectRootAgentsCache();
    let calls = 0;
    const scan = async () => { calls++; return []; };
    expect(await detectRootAgents([], [], { scan })).toEqual([]);
    expect(calls).toBe(0);
  });

  it('collapses a wrapper/worker pair (child ppid is a matched agent) into one session', async () => {
    resetDetectRootAgentsCache();
    // A GUI-hosted agent (e.g. Claude Desktop's bundled Claude Code) shows up as
    // a launcher stub + its worker child sharing one cwd — that is ONE session.
    const scan = async () => [
      proc(100, 'claude', '/hub', 1),   // launcher stub
      proc(101, 'claude', '/hub', 100), // its worker → same session
      proc(200, 'claude', '/hub', 50),  // a separate terminal session
    ];
    const r = await detectRootAgents(['/hub'], [], { scan });
    expect(r.map((p) => p.pid).sort()).toEqual([100, 200]); // 101 collapsed into 100
  });

  it('caches by (include, exclude) key within the TTL', async () => {
    resetDetectRootAgentsCache();
    let calls = 0;
    const scan = async () => { calls++; return [proc(1, 'claude', '/hub')]; };
    let t = 1_000_000;
    const now = () => t;
    await detectRootAgents(['/hub'], [], { scan, now });
    await detectRootAgents(['/hub'], [], { scan, now });
    expect(calls).toBe(1);
    t += 2001;
    await detectRootAgents(['/hub'], [], { scan, now });
    expect(calls).toBe(2);
  });
});
