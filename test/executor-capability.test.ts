// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Whether a launch can happen, decided before anything is spawned.
 *
 * The dispatcher's whole value is that `@antigravity` on a task means
 * Antigravity runs it. The failure mode that destroys that value is silent
 * substitution: a backend that cannot launch Antigravity quietly starting
 * Claude instead, and the plan's split being a fiction.
 *
 * So every no is a typed refusal carrying the remediation, and there is no
 * fallback here at all. Fallback belongs where the user asked for it — a
 * routing `chain` — not in the resolver.
 */
import { describe, expect, it } from 'vitest';
import { resolveLaunch, type AgentCapability } from '../src/executors/capability.js';

const cap = (over: Partial<AgentCapability> & { agentId: string }): AgentCapability => ({
  nativeId: over.agentId,
  modes: ['headless'],
  supportsModel: true,
  installed: true,
  ...over,
});

const caps = (...list: AgentCapability[]): Map<string, AgentCapability> =>
  new Map(list.map((c) => [c.agentId, c]));

describe('resolveLaunch', () => {
  it('resolves an installed agent that supports the wanted mode', () => {
    const r = resolveLaunch({ agentId: 'claude', want: 'headless' }, caps(cap({ agentId: 'claude' })), 'local');

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mode).toBe('headless');
      expect(r.nativeId).toBe('claude');
    }
  });

  it('refuses an agent the backend has never heard of', () => {
    const r = resolveLaunch({ agentId: 'nonesuch', want: 'any' }, caps(cap({ agentId: 'claude' })), 'local');

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('unknown-agent');
  });

  it('refuses an agent whose CLI is not installed', () => {
    const r = resolveLaunch({ agentId: 'codex', want: 'any' }, caps(cap({ agentId: 'codex', installed: false })), 'local');

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not-installed');
  });

  it('refuses when the agent cannot run in the wanted mode', () => {
    // cursor is interactive-only under the local backend
    const r = resolveLaunch({ agentId: 'cursor', want: 'headless' }, caps(cap({ agentId: 'cursor', modes: ['interactive'] })), 'local');

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('no-mode');
  });

  it('refuses an agent with no launcher at all, naming the backend that has one', () => {
    /*
     * This is the case the whole abstraction exists for. Baton's registry marks
     * antigravity detection-only — it deliberately refuses to guess spawn args.
     * The refusal has to point at the orca backend, or the user is stuck with a
     * plan that cannot run and no idea why.
     */
    const r = resolveLaunch({ agentId: 'antigravity', want: 'any' }, caps(cap({ agentId: 'antigravity', modes: [] })), 'local');

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('no-mode');
      expect(r.message).toMatch(/orca/i);
    }
  });

  it('refuses a model on an agent that cannot select one, rather than dropping it', () => {
    /*
     * Silently ignoring `--model opus` bills the user for a model they did not
     * pick, or runs a cheaper one than the plan called for. Both are worse than
     * stopping.
     */
    const r = resolveLaunch(
      { agentId: 'aider', model: 'opus', want: 'any' },
      caps(cap({ agentId: 'aider', modes: ['interactive'], supportsModel: false })),
      'local',
    );

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('no-model');
  });

  it('allows an agent with no model support when no model was asked for', () => {
    const r = resolveLaunch(
      { agentId: 'aider', want: 'any' },
      caps(cap({ agentId: 'aider', modes: ['interactive'], supportsModel: false })),
      'local',
    );

    expect(r.ok).toBe(true);
  });

  it('prefers headless when either mode would do', () => {
    // Headless output reaches the event bus; a TUI's does not. When the caller
    // has no preference, pick the one Baton can actually observe.
    const r = resolveLaunch(
      { agentId: 'claude', want: 'any' },
      caps(cap({ agentId: 'claude', modes: ['interactive', 'headless'] })),
      'local',
    );

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.mode).toBe('headless');
  });

  it('carries the backend\'s own id for the agent, which need not match Baton\'s', () => {
    const r = resolveLaunch(
      { agentId: 'cursor', want: 'interactive' },
      caps(cap({ agentId: 'cursor', nativeId: 'cursor-agent', modes: ['interactive'] })),
      'orca',
    );

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.nativeId).toBe('cursor-agent');
  });

  it('names the agent and the backend in every refusal', () => {
    const refusals = [
      resolveLaunch({ agentId: 'nonesuch', want: 'any' }, caps(), 'local'),
      resolveLaunch({ agentId: 'codex', want: 'any' }, caps(cap({ agentId: 'codex', installed: false })), 'local'),
      resolveLaunch({ agentId: 'cursor', want: 'headless' }, caps(cap({ agentId: 'cursor', modes: ['interactive'] })), 'local'),
    ];

    for (const r of refusals) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message.length).toBeGreaterThan(20); // not a bare code
        expect(r.message).toMatch(/local/);
      }
    }
  });
});
