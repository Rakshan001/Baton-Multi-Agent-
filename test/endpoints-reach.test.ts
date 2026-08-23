// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P15 step 2 — which agents can be pointed at your own servers.
 *
 * This is a property of the agent vendors, not of anything Baton builds, and
 * `null` for cursor, antigravity and gemini is the researched answer rather
 * than a gap someone should fill in later. The tests below are what stops a
 * future reader from "fixing" it.
 */
import { describe, expect, it } from 'vitest';
import { AGENTS } from '../src/agents/registry.js';
import { LocalExecutor } from '../src/executors/local.js';
import { orcaCapabilities } from '../src/executors/orca-agents.js';
import {
  AGENT_ENDPOINT_REACH,
  agentsReachingKind,
  endpointViaFor,
  reachesKind,
} from '../src/endpoints/reach.js';

describe('the reach table', () => {
  it('gives the four agents that can reach your servers a way to do it', () => {
    expect(endpointViaFor('claude')).toBe('anthropic-base-url');
    expect(endpointViaFor('codex')).toBe('openai-base-url');
    expect(endpointViaFor('aider')).toBe('native-model-string');
    expect(endpointViaFor('opencode')).toBe('native-model-string');
  });

  it('answers null for the agents whose vendors do not allow it', () => {
    // cursor: IDE-only, needs a public HTTPS URL, and the traffic still
    // transits their infrastructure — that is not "your own model".
    expect(endpointViaFor('cursor')).toBeNull();
    expect(endpointViaFor('antigravity')).toBeNull();
    expect(endpointViaFor('gemini')).toBeNull();
  });

  it('answers null for an agent nobody has verified, including a custom one', () => {
    expect(endpointViaFor('openclaw')).toBeNull();
    expect(endpointViaFor('some-custom-cli')).toBeNull();
  });

  // A new agent added to the registry without a reach entry would silently
  // read as "cannot reach your servers" — plausible, and possibly wrong.
  it('classifies every agent in the registry', () => {
    const unclassified = Object.keys(AGENTS).filter((id) => !(id in AGENT_ENDPOINT_REACH));
    expect(unclassified).toEqual([]);
  });
});

describe('reachesKind', () => {
  it('matches a dialect to the agents that speak it', () => {
    expect(reachesKind('anthropic-base-url', 'anthropic-compatible')).toBe(true);
    expect(reachesKind('openai-base-url', 'openai-compatible')).toBe(true);
    expect(reachesKind('native-model-string', 'ollama')).toBe(true);
  });

  it('refuses a dialect the agent does not speak', () => {
    expect(reachesKind('anthropic-base-url', 'openai-compatible')).toBe(false);
    expect(reachesKind('openai-base-url', 'anthropic-compatible')).toBe(false);
    // aider's --openai-api-base is unverified; claiming it here would put a
    // launch behind a flag nobody has run.
    expect(reachesKind('native-model-string', 'openai-compatible')).toBe(false);
  });

  it('never lets a null-reach agent reach anything', () => {
    for (const kind of ['anthropic-compatible', 'openai-compatible', 'ollama'] as const) {
      expect(reachesKind(null, kind), kind).toBe(false);
    }
  });

  it('lists who can reach a kind, for the line doctor prints', () => {
    expect(agentsReachingKind('anthropic-compatible')).toEqual(['claude']);
    expect(agentsReachingKind('openai-compatible')).toEqual(['codex']);
    expect(agentsReachingKind('ollama')).toEqual(['aider', 'opencode']);
  });
});

describe('the capability the dispatcher reads', () => {
  it('is carried by every local capability', async () => {
    const caps = await new LocalExecutor({ isInstalled: async () => true })
      .capabilities(process.cwd());
    expect(caps.get('claude')?.endpointVia).toBe('anthropic-base-url');
    expect(caps.get('antigravity')?.endpointVia).toBeNull();
  });

  it('is carried by every Orca capability too — the backend does not change the vendor', () => {
    const caps = orcaCapabilities();
    expect(caps.get('claude')?.endpointVia).toBe('anthropic-base-url');
    expect(caps.get('gemini')?.endpointVia).toBeNull();
  });
});
