import { describe, it, expect } from 'vitest';
import { agentActiveLoads, pickHandoffTarget } from '../src/handoff/workload.js';

/**
 * S5 — workload-aware handoff. Routing picks an agent by task type; this layer
 * adds "who's actually free" so a busy agent isn't handed yet another task.
 */
describe('agentActiveLoads', () => {
  it('counts each agent\'s actively-churning (dirty/conflict) tasks, ignoring clean and unassigned', () => {
    const loads = agentActiveLoads([
      { agent: 'claude', status: 'dirty' },
      { agent: 'claude', status: 'conflict' },
      { agent: 'claude', status: 'clean' },   // committed / idle → not counted
      { agent: 'codex', status: 'dirty' },
      { agent: null, status: 'dirty' },        // unassigned → ignored
    ]);
    expect(loads).toEqual({ claude: 2, codex: 1 });
  });
});

describe('pickHandoffTarget', () => {
  it('prefers the least-loaded candidate', () => {
    const r = pickHandoffTarget({ candidates: ['claude', 'codex'], loads: { claude: 2, codex: 0 } });
    expect(r.agent).toBe('codex');
  });

  it('breaks a tie in favor of the routing pick (best fit AND free)', () => {
    const r = pickHandoffTarget({ candidates: ['claude', 'codex'], loads: {}, routingPick: 'claude' });
    expect(r.agent).toBe('claude');
  });

  it('load-balances away from a busy routing pick', () => {
    const r = pickHandoffTarget({ candidates: ['claude', 'codex'], loads: { claude: 3 }, routingPick: 'claude' });
    expect(r.agent).toBe('codex');
    expect(r.reason.toLowerCase()).toContain('claude'); // explains it steered off the busy pick
  });

  it('excludes the current agent', () => {
    const r = pickHandoffTarget({ candidates: ['claude', 'codex'], loads: {}, exclude: 'claude' });
    expect(r.agent).toBe('codex');
  });

  it('returns null when no other agent is available', () => {
    const r = pickHandoffTarget({ candidates: ['claude'], loads: {}, exclude: 'claude' });
    expect(r.agent).toBeNull();
  });
});
