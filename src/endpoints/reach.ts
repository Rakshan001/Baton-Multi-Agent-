// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Which agents can be pointed at your own model servers, and how.
 *
 * This is a property of the agent vendors, not of anything Baton builds, and
 * it does not change with more hardware. Verified 2026-08:
 *
 *   claude    ANTHROPIC_BASE_URL → your gateway
 *   codex     custom model provider (OpenAI dialect)
 *   aider     native — `--model ollama/qwen3-coder`, no gateway at all
 *   opencode  native local providers
 *   cursor    ❌ IDE only, needs a PUBLIC https URL because Cursor's servers
 *             make the call, and the traffic still transits their infra
 *   antigravity ❌ cannot use Ollama, LM Studio, a custom key or a custom
 *             endpoint as its reasoning model — a local service can be an MCP
 *             *tool*, never the model
 *   gemini    ❌ Google endpoint only
 *
 * 🔴 The three `null`s are the researched answer, not a gap to fill in later.
 * If you are here to "add support", the vendor has to change first — check
 * their docs, then change the table and the test together.
 */
import type { EndpointKind } from './config.js';

export type EndpointVia = 'anthropic-base-url' | 'openai-base-url' | 'native-model-string' | null;

export const AGENT_ENDPOINT_REACH: Readonly<Record<string, EndpointVia>> = {
  claude: 'anthropic-base-url',
  codex: 'openai-base-url',
  cursor: null,
  gemini: null,
  antigravity: null,
  aider: 'native-model-string',
  opencode: 'native-model-string',
  // Detection-only in the registry: no launcher has been verified, so its
  // reach has not been either. Same rule as its flags.
  openclaw: null,
};

/** An agent nobody has classified — a custom `~/.baton/agents.json` entry —
 *  reaches nothing. The conservative answer is the honest one. */
export function endpointViaFor(agentId: string): EndpointVia {
  return AGENT_ENDPOINT_REACH[agentId] ?? null;
}

/**
 * `native-model-string` is Ollama only on purpose: aider's `--openai-api-base`
 * would plausibly reach an OpenAI-dialect gateway, but nobody has run it, and
 * a launch behind an unverified flag fails as a confusing agent error rather
 * than as a refusal that names the problem.
 */
export function reachesKind(via: EndpointVia, kind: EndpointKind): boolean {
  if (via === 'anthropic-base-url') return kind === 'anthropic-compatible';
  if (via === 'openai-base-url') return kind === 'openai-compatible';
  if (via === 'native-model-string') return kind === 'ollama';
  return false;
}

/** The agents `baton doctor` lists under an endpoint. */
export function agentsReachingKind(kind: EndpointKind): string[] {
  return Object.entries(AGENT_ENDPOINT_REACH)
    .filter(([, via]) => reachesKind(via, kind))
    .map(([id]) => id);
}

/**
 * Every agent this table classifies — including the ones that cannot be routed.
 *
 * The unavailable ones are returned on purpose (P27-E3): a settings pane that
 * hides Antigravity reads as "they forgot Antigravity", while one that shows it
 * with the vendor's reason answers the question before it is asked.
 */
export function knownAgentIds(): string[] {
  return Object.keys(AGENT_ENDPOINT_REACH);
}
