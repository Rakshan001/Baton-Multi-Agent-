// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The environment that points one agent at one of your servers, for one launch.
 *
 * 🔴 Per-launch only. The reference implementation we read writes
 * `ANTHROPIC_BASE_URL` into `~/.claude/settings.json`, which re-points every
 * Claude Code session on the machine — turn it on for one Baton task and
 * somebody's unrelated work starts hitting your gateway. Nothing in this file
 * touches a file, and a test fails if it ever does.
 *
 * Half an injection is worse than none: a base URL with no credential is a call
 * to your gateway that anyone on the network could have made. So an endpoint
 * whose key did not resolve injects NOTHING and the launch refuses upstream
 * (capability.ts), rather than being pointed somewhere it cannot authenticate.
 */
import type { EndpointConfig } from './config.js';
import type { EndpointVia } from './reach.js';
import { reachesKind } from './reach.js';

/** Where each dialect expects its credential when the endpoint does not say. */
const DEFAULT_AUTH_ENV: Record<EndpointConfig['kind'], string | null> = {
  'anthropic-compatible': 'ANTHROPIC_API_KEY',
  'openai-compatible': 'OPENAI_API_KEY',
  ollama: null,
};

/**
 * The key itself, read at launch. P15's config deliberately never carries it;
 * this is the one place that resolves it, and the value goes straight into a
 * child's env — never into a brief, a log line, or a return value that is
 * printed. `null` means "declared but absent", which is a refusal.
 */
export function resolveEndpointKey(endpoint: EndpointConfig, env: NodeJS.ProcessEnv): string | null {
  if (!endpoint.keyRef) return null;
  const [scheme, ...rest] = endpoint.keyRef.split(':');
  if (scheme !== 'env') return null;
  const value = env[rest.join(':').trim()];
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * `via` comes from the AGENT (endpoints/reach.ts), `endpoint` from config, and
 * both have to agree: an agent that speaks the Anthropic dialect cannot be
 * pointed at an Ollama box by setting a variable.
 */
export function endpointLaunchEnv(
  endpoint: EndpointConfig,
  via: EndpointVia,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  if (via === null || !endpoint.usable || !reachesKind(via, endpoint.kind)) return {};

  const key = resolveEndpointKey(endpoint, env);
  // Declared a credential and could not resolve it ⇒ inject nothing at all.
  if (endpoint.keyRef && key === null) return {};

  const authEnv = endpoint.authEnv ?? DEFAULT_AUTH_ENV[endpoint.kind];
  const auth = key !== null && authEnv ? { [authEnv]: key } : {};

  if (via === 'anthropic-base-url') return { ANTHROPIC_BASE_URL: endpoint.url, ...auth };
  if (via === 'openai-base-url') {
    // Both spellings: CLIs disagree about which one they read, and setting the
    // wrong one alone fails as a confusing auth error against the vendor.
    return { OPENAI_BASE_URL: endpoint.url, OPENAI_API_BASE: endpoint.url, ...auth };
  }
  // native-model-string: `ollama/qwen3-coder` carries the PROVIDER, not the
  // HOST. Without this an Ollama box on another machine is silently talked
  // past in favour of localhost — the wrong-server failure this phase exists
  // to prevent. (The plan's table said "nothing"; its reasoning covered the
  // model string, not the address.)
  return { OLLAMA_API_BASE: endpoint.url, ...auth };
}
