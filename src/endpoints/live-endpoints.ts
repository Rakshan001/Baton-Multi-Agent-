// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Your endpoints as the dispatcher sees them right now: what is configured,
 * what answered, and what that means for money.
 *
 * One place builds this, and `route`, `pass` and `dispatch` all read it, because
 * three commands that disagree about whether the gateway is up is three
 * different answers to "why did this task go to Opus".
 *
 * `null` when nothing is configured — and then every caller passes `undefined`
 * downstream and the walk behaves exactly as it did before P16. Nobody who has
 * not configured an endpoint pays anything for this feature.
 */
import type { ChainCostPolicy, EntryCost, TierEntry } from '../routing.js';
import type { LaunchEndpoint } from '../executors/capability.js';
import { endpointForModel, loadEndpointsConfig, type EndpointConfig, type EndpointsConfig } from './config.js';
import { probeEndpoint, type EndpointHealth } from './health.js';
import { endpointLaunchEnv, resolveEndpointKey } from './launch-env.js';
import { endpointViaFor } from './reach.js';
import { registerRuntimeSecret } from '../memory.js';
import { loadProviderPolicy, providerLaunchRefusal, resolveProviderMode } from './policy.js';

export interface LiveEndpoints {
  config: EndpointsConfig;
  /** Empty when probing was skipped — an absent answer, never a bad one. */
  health: ReadonlyMap<string, EndpointHealth>;
  /** Every model your endpoints serve, for the "no endpoint serves it" message. */
  served: string[];
  /** What the walk needs to know about cost, for one tier's chain. */
  policyFor(tier: string | null, allowPaidFallback?: boolean): ChainCostPolicy;
  /** What `resolveLaunch` needs to refuse an impossible pairing. */
  endpointFor(model?: string): LaunchEndpoint;
}

export async function loadLiveEndpoints(
  root: string,
  opts: { env?: NodeJS.ProcessEnv; probe?: boolean } = {},
): Promise<LiveEndpoints | null> {
  const env = opts.env ?? process.env;
  const { config } = await loadEndpointsConfig(root, env);
  if (!config.endpoints.length) return null;

  const health = new Map<string, EndpointHealth>();
  if (opts.probe !== false) {
    // Only endpoints we could actually use: probing one we already know is
    // unusable spends a round trip to be told what config already said.
    await Promise.all(config.endpoints.filter((e) => e.usable).map(async (e) => {
      health.set(e.id, (await probeEndpoint(e, env)).state);
    }));
  }
  return buildLiveEndpoints(config, health);
}

/** Split out so tests (and P17) can build one from a known state. */
export function buildLiveEndpoints(config: EndpointsConfig, health: ReadonlyMap<string, EndpointHealth>): LiveEndpoints {
  const served = [...new Set(config.endpoints.flatMap((e) => e.models))];

  const blockOf = (endpoint: EndpointConfig): string | null => {
    if (!endpoint.usable) return `'${endpoint.id}' is unusable: ${endpoint.unusable}`;
    const state = health.get(endpoint.id);
    if (state === 'unreachable') return `'${endpoint.id}' did not answer`;
    if (state === 'unauthorized') return `'${endpoint.id}' rejected the credential`;
    // Indeterminate is not permission — and it must not promote to a paid model
    // either, which is exactly what treating it as "fine" would do.
    if (state === 'unknown') return `'${endpoint.id}' did not answer in time`;
    return null;
  };

  return {
    config,
    health,
    served,
    policyFor(tier, allowPaidFallback) {
      return {
        tier,
        served,
        allowPaidFallback: allowPaidFallback ?? config.allowPaidFallback,
        costOf: (entry: TierEntry): EntryCost => {
          const endpoint = entry.model ? endpointForModel(config, entry.model) : null;
          if (endpoint) return 'self-hosted';
          // Outside the self-hosted tier a model we do not serve is simply the
          // vendor's own — and it costs money, which is the thing that matters.
          return tier === 'local' ? 'unserved' : 'paid';
        },
        blocked: (entry: TierEntry): string | null => {
          const endpoint = entry.model ? endpointForModel(config, entry.model) : null;
          return endpoint ? blockOf(endpoint) : null;
        },
      };
    },
    endpointFor(model) {
      const endpoint = model ? endpointForModel(config, model) : null;
      return endpoint ? { endpoint, ...(health.has(endpoint.id) ? { health: health.get(endpoint.id) } : {}) } : { endpoint: null };
    },
  };
}

export interface LaunchInjection {
  env: Record<string, string>;
  /**
   * P27's rule, carried to the caller. Non-null means this launch must NOT
   * happen — and it is a separate field from `env` on purpose: an empty `env`
   * is indistinguishable from a healthy vendor launch, so signalling a refusal
   * by absence would BE the silent fallback the rule forbids.
   */
  refusal: string | null;
  /** The credential that went into `env`, so the launcher can register it for
   *  redaction — and so an interactive launcher can refuse to carry it. */
  secret: string | null;
  endpointId: string | null;
}

/**
 * The environment for ONE launch. No probe: dispatch already refused if the
 * gateway was down, and a launch is not the place to discover it again.
 */
export async function endpointLaunchInjection(
  root: string,
  agentId: string,
  model: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LaunchInjection> {
  const none: LaunchInjection = { env: {}, secret: null, endpointId: null, refusal: null };

  /*
   * P27 — is this agent even supposed to be routed?
   *
   * Resolved before anything else, because the answer decides whether a
   * missing or unreachable endpoint is a non-event (vendor mode: the agent uses
   * its own key, as it always has) or a refusal (gateway mode: the developer
   * believes their code is staying on their network).
   */
  const decision = resolveProviderMode(agentId, await loadProviderPolicy(root), env);
  if (decision.mode === 'unavailable') return none;

  const live = await loadLiveEndpoints(root, { env, probe: decision.mode === 'gateway' });
  const endpoint = live && model ? endpointForModel(live.config, model) : null;

  if (decision.mode === 'gateway') {
    const refusal = providerLaunchRefusal(decision, endpoint, endpoint ? live!.health.get(endpoint.id) ?? 'unknown' : 'unknown');
    if (refusal) return { ...none, refusal };
  }

  // Vendor mode keeps P16's behaviour exactly: naming a model an endpoint
  // serves is itself the request to use it, and that has been true since P16.
  // P27 adds the gateway mode on top; it does not take that away.
  if (!model || !endpoint) return none;

  const injected = endpointLaunchEnv(endpoint, endpointViaFor(agentId), env);
  if (!Object.keys(injected).length) return none;
  const key = resolveEndpointKey(endpoint, env);
  const carriesKey = key !== null && Object.values(injected).includes(key);
  if (carriesKey) registerRuntimeSecret(key);
  return { env: injected, secret: carriesKey ? key : null, endpointId: endpoint.id, refusal: null };
}

/**
 * Interactive launches go through tmux, where every variable becomes a shell
 * `NAME=value` prefix on the agent's own command line — visible in `ps` to
 * anyone on the machine, for as long as the agent runs. A base URL there is
 * fine; a credential is not, so this refuses instead of leaking one.
 *
 * Nothing in the researched fleet hits this: the only agents that are
 * interactive-only (aider, opencode) reach `ollama` endpoints, which need no
 * credential. It fires when someone puts an `authEnv` on one.
 */
export function interactiveLaunchEnv(
  injection: LaunchInjection,
  agentId: string,
): { env: Record<string, string> } | { refuse: string } {
  if (injection.secret === null) return { env: injection.env };
  return {
    refuse: `'${agentId}' runs in a terminal, and pointing it at '${injection.endpointId}' would put that endpoint's credential on its command line where any process on this machine can read it. Run this agent headlessly, or serve the model from an endpoint that needs no key.`,
  };
}
