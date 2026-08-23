// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Which adapter administers an endpoint.
 *
 * Every id here comes from the adapter's own `id` field rather than a literal,
 * so this file names no gateway — which is the rule `gateway-adapter.test.ts`
 * enforces across `src/`.
 *
 * **LiteLLM is deliberately absent** (D4). It ships dark until its adapter is
 * finished: not registered, so a hand-edited config cannot select it, and not
 * rendered, so no customer sees a "coming soon" they cannot use. A greyed-out
 * option is a support ticket; an option that is not there costs nothing.
 */
import type { EndpointConfig } from '../config.js';
import { directAdapter, omnirouteAdapter } from './omniroute.js';
import type { GatewayAdapter } from './types.js';

/** Registered adapters, keyed by their own declared id. */
export const GATEWAY_ADAPTERS: Readonly<Record<string, GatewayAdapter>> = Object.freeze(
  Object.fromEntries([omnirouteAdapter, directAdapter].map((a) => [a.id, a])),
);

/** The gateway assumed when an endpoint does not name one. */
const DEFAULT_ADAPTER = omnirouteAdapter;

/** `direct` is the absence of a gateway, not a choice of one. */
const NO_GATEWAY = directAdapter;

export function registeredGatewayIds(): string[] {
  return Object.keys(GATEWAY_ADAPTERS);
}

export interface GatewayChoice {
  adapter: GatewayAdapter;
  /** Set when the endpoint asked for something that is not registered. Never
   *  silent: substituting an adapter without saying so is how someone debugs a
   *  gateway that was never being used. */
  warning: string | null;
}

export function gatewayAdapterFor(endpoint: EndpointConfig): GatewayChoice {
  if (endpoint.gateway) {
    const adapter = GATEWAY_ADAPTERS[endpoint.gateway];
    if (adapter) return { adapter, warning: null };
    return {
      adapter: DEFAULT_ADAPTER,
      warning: `endpoints.${endpoint.id}.gateway: '${endpoint.gateway}' is not a gateway this build supports — administering it as ${DEFAULT_ADAPTER.id}`,
    };
  }
  // A model runtime with nothing in front of it: reached directly, and there is
  // no admin surface to ask about keys or grants.
  if (endpoint.kind === 'ollama') return { adapter: NO_GATEWAY, warning: null };
  return { adapter: DEFAULT_ADAPTER, warning: null };
}
