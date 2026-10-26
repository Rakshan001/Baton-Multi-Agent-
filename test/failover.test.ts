// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { compilePatterns, matchLimit, runFailover, type FailoverDeps } from '../src/failover.js';
import type { AgentExit } from '../src/spawn.js';

type Script = { lines?: Array<[string, 'out' | 'err']>; exit: AgentExit | null };

function harness(script: Record<string, Script>) {
  const calls: string[] = [];
  let onLine: ((line: string, stream: 'out' | 'err') => void) | null = null;
  let current = '';

  const deps: FailoverDeps = {
    prepare: vi.fn(async (_slug: string, agent: string) => {
      calls.push(`prepare:${agent}`);
    }),
    start: vi.fn(async (_slug: string, agent: string) => {
      calls.push(`start:${agent}`);
      current = agent;
      for (const [line, stream] of script[agent]?.lines ?? []) onLine?.(line, stream);
    }),
    wait: vi.fn(async () => {
      calls.push(`wait:${current}`);
      return script[current]?.exit ?? null;
    }),
    stop: vi.fn(() => {
      calls.push(`stop:${current}`);
      return true;
    }),
    watch: vi.fn((_slug: string, cb: (line: string, stream: 'out' | 'err') => void) => {
      onLine = cb;
      return () => {
        onLine = null;
      };
    }),
    pass: vi.fn(async (_slug: string, from: string, to: string) => {
      calls.push(`pass:${from}->${to}`);
    }),
    reassign: vi.fn(async (_slug: string, from: string, to: string) => {
      calls.push(`reassign:${from}->${to}`);
    }),
    block: vi.fn(async (_slug: string, reason: string) => {
      calls.push(`block:${reason}`);
    }),
    publish: vi.fn((event) => {
      calls.push(`publish:${event.type}`);
    }),
    log: vi.fn((line: string) => {
      calls.push(`log:${line}`);
    }),
  };

  return { deps, calls };
}

const STOPPED: AgentExit = { code: null, stopped: true };
const FINISHED: AgentExit = { code: 0, stopped: false };

describe('matchLimit', () => {
  it('recognises provider limit signals', () => {
    expect(matchLimit('Error: 429 Too Many Requests')).not.toBeNull();
    expect(matchLimit('Claude usage limit reached')).not.toBeNull();
    expect(matchLimit('RESOURCE_EXHAUSTED')).not.toBeNull();
    expect(matchLimit('quota_exhausted')).not.toBeNull();
    expect(matchLimit('The API is overloaded right now')).not.toBeNull();
  });

  it('does not flag ordinary output', () => {
    expect(matchLimit('the rate limiter middleware is fine')).toBeNull();
    expect(matchLimit('error 500: bad gateway')).toBeNull();
    expect(matchLimit('all tests passed')).toBeNull();
    expect(matchLimit('')).toBeNull();
  });

  it('supports extra patterns and validates them', () => {
    expect(matchLimit('MY_PROVIDER_LIMIT', [/MY_PROVIDER_LIMIT/])).not.toBeNull();
    expect(compilePatterns(['foo', 'bar'])).toHaveLength(2);
    expect(() => compilePatterns(['(unclosed'])).toThrow(/invalid --pattern/);
  });
});

describe('runFailover', () => {
  it('hands off to the next agent when the first reports a limit', async () => {
    const { deps, calls } = harness({
      claude: { lines: [['Error: 429 Too Many Requests', 'err']], exit: STOPPED },
      codex: { exit: FINISHED },
    });

    const result = await runFailover({ slug: 'add-auth', agents: ['claude', 'codex'] }, deps);

    expect(result).toMatchObject({ outcome: 'finished', attempts: 2, lastAgent: 'codex' });
    expect(calls).toContain('prepare:claude');
    expect(calls).toContain('stop:claude');
    expect(calls).toContain('pass:claude->codex');
    expect(calls).toContain('reassign:claude->codex');
    expect(calls).toContain('publish:agent.failover');
    expect(calls).toContain('start:codex');
  });

  it('blocks when every agent in the chain is limited', async () => {
    const { deps, calls } = harness({
      claude: { lines: [['rate limit exceeded', 'err']], exit: STOPPED },
      codex: { lines: [['usage limit reached', 'err']], exit: STOPPED },
    });

    const result = await runFailover({ slug: 'add-auth', agents: ['claude', 'codex'] }, deps);

    expect(result.outcome).toBe('exhausted');
    expect(calls.filter((c) => c.startsWith('pass:'))).toEqual(['pass:claude->codex']);
    expect(calls.some((c) => c.startsWith('block:all agents in the failover chain'))).toBe(true);
    expect(calls.filter((c) => c.startsWith('start:'))).toEqual(['start:claude', 'start:codex']);
  });

  it('does not hand off on an ordinary non-zero exit', async () => {
    const { deps, calls } = harness({
      claude: { lines: [['error: tests failed', 'err']], exit: { code: 1, stopped: false } },
      codex: { exit: FINISHED },
    });

    const result = await runFailover({ slug: 'add-auth', agents: ['claude', 'codex'] }, deps);

    expect(result.outcome).toBe('failed');
    expect(calls.some((c) => c.startsWith('pass:'))).toBe(false);
    expect(calls.some((c) => c.startsWith('block:the agent exited 1'))).toBe(true);
    expect(calls).not.toContain('start:codex');
  });

  it('finishes without a handoff when the first agent exits 0', async () => {
    const { deps, calls } = harness({ claude: { exit: FINISHED } });

    const result = await runFailover({ slug: 'add-auth', agents: ['claude', 'codex'] }, deps);

    expect(result).toMatchObject({ outcome: 'finished', attempts: 1, lastAgent: 'claude' });
    expect(calls.some((c) => c.startsWith('pass:'))).toBe(false);
    expect(calls).not.toContain('start:codex');
  });

  it('honours --max and reports exhaustion without trying the rest of the chain', async () => {
    const { deps, calls } = harness({
      claude: { lines: [['429', 'err']], exit: STOPPED },
      codex: { exit: FINISHED },
    });

    const result = await runFailover({ slug: 'add-auth', agents: ['claude', 'codex'], maxAttempts: 1 }, deps);

    expect(result.outcome).toBe('exhausted');
    expect(calls.some((c) => c.startsWith('pass:'))).toBe(false);
    expect(calls).not.toContain('start:codex');
  });

  it('accepts a custom limit pattern', async () => {
    const { deps } = harness({
      claude: { lines: [['MY_PROVIDER_LIMIT_SENTINEL', 'out']], exit: STOPPED },
      codex: { exit: FINISHED },
    });

    const result = await runFailover({
      slug: 'add-auth',
      agents: ['claude', 'codex'],
      patterns: [/MY_PROVIDER_LIMIT_SENTINEL/],
    }, deps);

    expect(result.outcome).toBe('finished');
  });

  it('ignores limit-looking lines copied from the handoff brief', async () => {
    const briefLine = '> Note: previous agent hit Error: 429 Too Many Requests';
    const { deps, calls } = harness({
      claude: { lines: [[briefLine, 'out']], exit: FINISHED },
    });

    const result = await runFailover({
      slug: 'add-auth',
      agents: ['claude', 'codex'],
      ignore: [briefLine],
    }, deps);

    expect(result.outcome).toBe('finished');
    expect(calls.some((c) => c.startsWith('stop:'))).toBe(false);
    expect(calls.some((c) => c.startsWith('pass:'))).toBe(false);
  });

  it('blocks when the run cannot be observed', async () => {
    const { deps, calls } = harness({});

    const result = await runFailover({ slug: 'add-auth', agents: ['claude', 'codex'] }, deps);

    expect(result.outcome).toBe('failed');
    expect(calls.some((c) => c.startsWith('block:the claude run could not be observed'))).toBe(true);
  });

  it('requires at least two distinct agents', async () => {
    const { deps } = harness({});
    await expect(runFailover({ slug: 's', agents: ['claude'] }, deps)).rejects.toThrow(/at least two agents/);
    await expect(runFailover({ slug: 's', agents: ['claude', 'claude'] }, deps)).rejects.toThrow(/duplicate agent/);
  });

  it('does not start anything when the task is held by another agent', async () => {
    const { deps, calls } = harness({});
    deps.prepare = vi.fn(async () => {
      throw new Error("'add-auth' is held by codex");
    });

    await expect(runFailover({ slug: 'add-auth', agents: ['claude', 'codex'] }, deps)).rejects.toThrow(/held by codex/);
    expect(calls.filter((c) => c.startsWith('start:'))).toEqual([]);
  });
});
