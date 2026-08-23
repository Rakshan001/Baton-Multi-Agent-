// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P16 step 3 — the most expensive way this feature can fail.
 *
 * `resolveChain` exists to walk a fallback chain the user asked for. A gateway
 * outage is not that. Silently promoting twenty queued tasks from free hardware
 * onto a frontier model is a bill discovered days later, and nobody would have
 * chosen it if asked.
 *
 * So the rule is: an entry that could not run BECAUSE ITS GATEWAY FAILED never
 * falls through to an entry that costs money. Falling through because a CLI is
 * not installed still does — that chain is the user's own configuration.
 * Distinguishing those two is the whole of this file.
 */
import { describe, expect, it } from 'vitest';
import { resolveChain, type ChainCostPolicy, type TierEntry } from '../src/routing.js';

const installed = async (): Promise<boolean> => true;

const LOCAL: TierEntry = { agent: 'aider', model: 'qwen3-coder' };
const LOCAL2: TierEntry = { agent: 'opencode', model: 'kimi-k2' };
const PAID: TierEntry = { agent: 'claude', model: 'opus' };

/** Everything self-hosted is served; nothing is blocked; consent is off. */
const policy = (over: Partial<ChainCostPolicy> = {}): ChainCostPolicy => ({
  tier: 'local',
  costOf: (e) => (e.agent === 'claude' ? 'paid' : 'self-hosted'),
  blocked: () => null,
  allowPaidFallback: false,
  ...over,
});

describe('a gateway outage never promotes a task to a paid model', () => {
  it('refuses instead of walking to the paid entry', async () => {
    const out = await resolveChain([LOCAL, PAID], installed, policy({
      blocked: (e) => (e.agent === 'aider' ? 'fleet did not answer' : null),
    }));
    expect(out && 'refused' in out && out.refused).toBe('paid-fallback');
    expect(out && 'refused' in out && out.from.agent).toBe('aider');
    expect(out && 'refused' in out && out.next.agent).toBe('claude');
    expect(out && 'refused' in out && out.reason).toContain('fleet did not answer');
  });

  it('walks to another self-hosted entry, which costs nothing to try', async () => {
    const out = await resolveChain([LOCAL, LOCAL2, PAID], installed, policy({
      blocked: (e) => (e.agent === 'aider' ? 'fleet did not answer' : null),
    }));
    expect(out && 'entry' in out && out.entry.agent).toBe('opencode');
    expect(out && 'entry' in out && out.promoted).toBeUndefined();
  });

  it('still refuses when the chain has no paid entry to promote to', async () => {
    const out = await resolveChain([LOCAL, LOCAL2], installed, policy({
      blocked: () => 'fleet did not answer',
    }));
    // Not "nothing in the chain is installed" — that sends someone to install
    // a CLI that is already there while the gateway stays down.
    expect(out && 'refused' in out && out.reason).toContain('fleet did not answer');
  });

  // The distinction the whole rule turns on.
  it('does fall through to a paid entry when the reason is an uninstalled CLI', async () => {
    const out = await resolveChain([LOCAL, PAID], async (a) => a !== 'aider', policy());
    expect(out && 'entry' in out && out.entry.agent).toBe('claude');
    expect(out && 'entry' in out && out.skipped).toEqual(['aider']);
    expect(out && 'entry' in out && out.promoted).toBeUndefined();
  });
});

describe('--allow-paid-fallback', () => {
  // P16-E7: consent is not silence. Every promotion is named.
  it('promotes, and says exactly what it promoted from and to', async () => {
    const out = await resolveChain([LOCAL, PAID], installed, policy({
      blocked: (e) => (e.agent === 'aider' ? 'fleet did not answer' : null),
      allowPaidFallback: true,
    }));
    expect(out && 'entry' in out && out.entry.agent).toBe('claude');
    expect(out && 'entry' in out && out.promoted).toEqual({
      from: LOCAL,
      to: PAID,
      reason: 'fleet did not answer',
    });
  });
});

// P16-E2 — a typo'd model should cost one line of output, not a debugging
// session that ends at a gateway which was fine all along.
describe('a local-tier model no endpoint serves', () => {
  it('refuses and lists what IS served', async () => {
    const out = await resolveChain([{ agent: 'aider', model: 'qwen3-codr' }], installed, policy({
      costOf: () => 'unserved',
      served: ['qwen3-coder', 'kimi-k2'],
    }));
    expect(out && 'refused' in out && out.refused).toBe('model-not-served');
    expect(out && 'refused' in out && out.reason).toContain('qwen3-codr');
    expect(out && 'refused' in out && out.reason).toContain('qwen3-coder');
  });

  // Order matters for the MESSAGE. When the gateway is what went wrong, saying
  // "no endpoint serves opus" sends someone to fix a config line that was
  // never the problem.
  it('names the gateway, not the unserved model, when a blocked entry came first', async () => {
    const out = await resolveChain([LOCAL, PAID], installed, policy({
      costOf: (e) => (e.agent === 'claude' ? 'unserved' : 'self-hosted'),
      blocked: (e) => (e.agent === 'aider' ? 'fleet did not answer' : null),
    }));
    expect(out && 'refused' in out && out.refused).toBe('paid-fallback');
    expect(out && 'refused' in out && out.reason).toContain('fleet did not answer');
  });

  it('offers the one-line fix for a paid model parked in the local tier', async () => {
    const out = await resolveChain([PAID], installed, policy({ costOf: () => 'unserved' }));
    expect(out && 'refused' in out && out.reason).toContain('move it out');
  });

  // Found by running it: the unserved path refused even with consent given,
  // so `allowPaidFallback` worked for one shape of paid entry and not the
  // other — and a local tier's fallback is usually the unserved shape.
  it('promotes an unserved local-tier entry too when consent was given', async () => {
    const out = await resolveChain([LOCAL, PAID], installed, policy({
      costOf: (e) => (e.agent === 'claude' ? 'unserved' : 'self-hosted'),
      blocked: (e) => (e.agent === 'aider' ? 'fleet did not answer' : null),
      allowPaidFallback: true,
    }));
    expect(out && 'entry' in out && out.entry.agent).toBe('claude');
    expect(out && 'entry' in out && out.promoted?.reason).toBe('fleet did not answer');
  });

  it('says nothing about a model outside the local tier — that is the vendor’s', async () => {
    const out = await resolveChain([PAID], installed, policy({ tier: 'heavy', costOf: () => 'unserved' }));
    expect(out && 'entry' in out && out.entry.agent).toBe('claude');
  });
});

describe('without a policy, the walk is exactly what it always was', () => {
  it('returns the first available entry', async () => {
    const out = await resolveChain([LOCAL, PAID], async (a) => a !== 'aider');
    expect(out && 'entry' in out && out.entry.agent).toBe('claude');
    expect(out && 'entry' in out && out.skipped).toEqual(['aider']);
  });

  it('returns null when nothing in the chain is installed', async () => {
    expect(await resolveChain([LOCAL, PAID], async () => false)).toBeNull();
  });

  it("keeps 'any' short-circuiting without a probe", async () => {
    const out = await resolveChain([{ agent: 'any' }], async () => {
      throw new Error('must not be probed');
    });
    expect(out && 'entry' in out && out.entry.agent).toBe('any');
  });
});
