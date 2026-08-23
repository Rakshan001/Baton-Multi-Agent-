// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P4 — what Orca can launch, as Baton believes it today.
 *
 * A snapshot, deliberately. Orca ships on its own schedule and Baton cannot ask
 * a stopped daemon what it supports, so the alternative to a snapshot is a
 * capability map that is empty exactly when it is needed. `baton doctor`
 * reports drift; dispatch never fails because the list aged (P4-E5).
 *
 * Every entry was read out of Orca's own source in ../orcabaton:
 *   ids           `src/shared/tui-agent-config.ts`
 *   model support `src/shared/agent-session-option-catalog.ts`
 */
import { describe, it, expect } from 'vitest';
import {
  ORCA_AGENTS,
  ORCA_MODEL_AGENTS,
  batonToOrca,
  orcaCapabilities,
  orcaAgentDrift,
} from '../src/executors/orca-agents.js';
import { AGENTS } from '../src/agents/registry.js';

describe('the map from Baton ids to Orca ids', () => {
  it('is the identity for every agent Baton knows', () => {
    // Both projects name agents after the tool. A translation table would be a
    // second place for the names to drift apart.
    for (const id of Object.keys(AGENTS)) {
      expect(batonToOrca(id), id).toBe(id);
    }
  });

  it('covers all eight of Baton\'s built-ins — including the two it cannot launch itself', () => {
    // This is the whole point of the backend: antigravity and openclaw are
    // detection-only locally, and Orca launches both.
    for (const id of Object.keys(AGENTS)) {
      expect(ORCA_AGENTS, id).toContain(id);
    }
    expect(ORCA_AGENTS).toContain('antigravity');
    expect(ORCA_AGENTS).toContain('openclaw');
  });
});

describe('orcaCapabilities', () => {
  const caps = orcaCapabilities();

  it('reports every Orca agent as launchable in both modes', () => {
    const claude = caps.get('claude')!;
    expect(claude.modes).toEqual(['interactive']);
    expect(claude.installed).toBe('unknown');
  });

  it('makes antigravity launchable, which is the reason this backend exists', () => {
    expect(caps.get('antigravity')?.modes).toEqual(['interactive']);
  });

  it('marks model support for exactly the agents whose catalogs define it', () => {
    for (const id of ORCA_MODEL_AGENTS) expect(caps.get(id)?.supportsModel, id).toBe(true);
    expect(caps.get('aider')?.supportsModel).toBe(false);
    expect(caps.get('antigravity')?.supportsModel).toBe(false);
  });

  it('includes grok, which the spec\'s four-agent list missed', () => {
    // `agent-session-option-catalog.ts` registers five catalogs, not four.
    // Writing four would have refused a model on grok that Orca honours.
    expect(ORCA_MODEL_AGENTS).toContain('grok');
  });

  it('says the prompt is not delivered at launch', () => {
    // `terminal create --command` starts the TUI; the pointer is a separate
    // `terminal send` after `wait --for tui-idle`. Claiming otherwise would let
    // the dispatcher skip the wait and type into a buffer that is not ready.
    expect(caps.get('claude')?.acceptsPromptAtLaunch).toBe(false);
  });
});

describe('orcaAgentDrift — P4-E5', () => {
  it('is silent when the live list matches the snapshot', () => {
    expect(orcaAgentDrift([...ORCA_AGENTS])).toEqual({ added: [], removed: [] });
  });

  it('names agents Orca gained, so the snapshot can be refreshed', () => {
    expect(orcaAgentDrift([...ORCA_AGENTS, 'newthing']).added).toEqual(['newthing']);
  });

  it('names agents Orca dropped', () => {
    expect(orcaAgentDrift(ORCA_AGENTS.filter((a) => a !== 'aider')).removed).toEqual(['aider']);
  });

  it('reports rather than throws — a stale list must never fail a dispatch', () => {
    expect(() => orcaAgentDrift([])).not.toThrow();
    expect(orcaAgentDrift([]).removed.length).toBe(ORCA_AGENTS.length);
  });
});
