// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What Orca can launch, as Baton believes it today.
 *
 * A snapshot on purpose. Orca ships on its own schedule, and Baton cannot ask a
 * daemon that is not running what it supports — so the alternative to a
 * snapshot is a capability map that is empty at exactly the moment the
 * dispatcher needs it. `baton doctor` reports drift; a dispatch never fails
 * because this list aged (P4-E5).
 *
 * Read out of Orca's own source rather than its docs:
 *   ids            `src/shared/tui-agent-config.ts`      (30 agents)
 *   model support  `src/shared/agent-session-option-catalog.ts` (5 catalogs)
 *
 * The plan said 36 agents and four with model support. Both were out of date at
 * the time of writing, which is the argument for the drift check rather than
 * against the snapshot.
 */
import type { AgentCapability } from './types.js';
import { endpointViaFor } from '../endpoints/reach.js';

/** Orca's TUI agent ids, in the order its config declares them. */
export const ORCA_AGENTS: readonly string[] = [
  'claude', 'openclaude', 'codex', 'autohand', 'ante', 'trae', 'opencode', 'pi',
  'omp', 'gemini', 'antigravity', 'aider', 'goose', 'amp', 'kilo', 'kiro',
  'crush', 'aug', 'cline', 'codebuff', 'continue', 'cursor', 'droid', 'kimi',
  'rovo', 'hermes', 'openclaw', 'copilot', 'grok', 'devin',
];

/**
 * The agents Orca will start with a chosen model.
 *
 * One entry per session-option catalog it registers. A model asked for on any
 * other agent is refused loudly by `resolveLaunch` — dropping it silently would
 * run a model the plan did not choose and bill the user for it.
 */
export const ORCA_MODEL_AGENTS: readonly string[] = ['claude', 'codex', 'gemini', 'cursor', 'grok'];

/**
 * Baton's id for an agent is Orca's id for the same agent.
 *
 * Both projects name agents after the tool, so this is the identity function
 * and is written as one rather than as a table: a table would be a second place
 * for the two naming schemes to drift apart, and there is nothing to drift.
 * It exists as a function so the day one id genuinely differs, there is a
 * single place to say so.
 */
export function batonToOrca(agentId: string): string {
  return agentId;
}

const MODEL_AGENTS = new Set(ORCA_MODEL_AGENTS);

/**
 * The capability map for the Orca backend.
 *
 * `interactive` only, and `acceptsPromptAtLaunch: false`, because that is what
 * the launch sequence actually is: `terminal create --command` starts the TUI,
 * then `wait --for tui-idle`, then `send`. Claiming a headless mode would let
 * the dispatcher skip the wait and type a pointer into a buffer that is not
 * ready to receive it (P4-E4).
 *
 * `installed: 'unknown'` because asking Orca costs a round trip per agent, and
 * `resolveLaunch` treats unknown as launchable rather than blocking on a guess.
 * The launch itself is where a missing CLI surfaces, with Orca's own message.
 */
export function orcaCapabilities(): Map<string, AgentCapability> {
  return new Map(ORCA_AGENTS.map((agentId) => [agentId, {
    agentId,
    nativeId: batonToOrca(agentId),
    modes: ['interactive'] as AgentCapability['modes'],
    supportsModel: MODEL_AGENTS.has(agentId),
    acceptsPromptAtLaunch: false,
    installed: 'unknown' as const,
    // A vendor property: routing through Orca does not make Antigravity
    // reachable by your gateway.
    endpointVia: endpointViaFor(agentId),
  }]));
}

export interface AgentDrift {
  /** In Orca now, missing from the snapshot. */
  added: string[];
  /** In the snapshot, gone from Orca. */
  removed: string[];
}

/**
 * Compare the snapshot against what a live Orca reports.
 *
 * Reports, never throws: this runs from `baton doctor`, and a stale list is a
 * thing to tell someone about, not a reason to stop dispatching.
 */
export function orcaAgentDrift(live: readonly string[]): AgentDrift {
  const known = new Set(ORCA_AGENTS);
  const now = new Set(live);
  return {
    added: live.filter((a) => !known.has(a)),
    removed: ORCA_AGENTS.filter((a) => !now.has(a)),
  };
}
