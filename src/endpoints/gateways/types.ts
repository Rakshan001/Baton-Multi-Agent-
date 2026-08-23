// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The gateway adapter boundary (D4).
 *
 * Routing does not belong here and never will: both supported gateways speak
 * OpenAI-compatible HTTP over an endpoint's `url` + `keyRef`, so a request goes
 * out the same way whichever one is in front of it. What differs is
 * **administration** — asking what this key may reach, and later, issuing keys
 * and reading usage. That is the whole surface an adapter covers.
 *
 * The rule that makes the second gateway nearly free: nothing outside this
 * directory may name a gateway. `gateway-adapter.test.ts` fails on a quoted
 * gateway id found anywhere else in `src/`, because such a literal is a branch
 * on which gateway is running, and one branch turns the LiteLLM migration from
 * a config change back into a rewrite.
 */
import type { EndpointConfig } from '../config.js';
import type { EgressClass } from '../egress.js';

export interface CatalogModel {
  id: string;
  /** Which endpoint serves it — two endpoints may serve the same name (GW-E4). */
  endpointId: string;
  /** Computed from the endpoint, never from `id`. See egress.ts. */
  egress: EgressClass;
}

export interface GatewayCatalog {
  models: CatalogModel[];
  /**
   * `true` only when the gateway itself answered. A list that fell back to
   * config is a list nobody confirmed, and rendering it as current is the same
   * class of lie as reporting a health check we could not run as "up".
   */
  verified: boolean;
  /** ISO. Every consumer shows the age rather than implying "now". */
  fetchedAt: string;
  /** Why it is unverified, when it is. */
  detail?: string;
}

export interface GatewayAdapter {
  /** The registry key. Declared here so no other file has to spell it. */
  id: string;
  /**
   * What this endpoint serves right now, as THIS KEY sees it — a gateway that
   * filters by key policy is doing the picker's filtering for us, and one that
   * does not is handled by P18's grants.
   *
   * `null` means "could not ask", which is a different answer from "serves
   * nothing"; the caller falls back to config and labels it unverified.
   */
  catalog(endpoint: EndpointConfig, env: NodeJS.ProcessEnv): Promise<string[] | null>;
  /**
   * Issue a credential belonging to ONE member (P18).
   *
   * Absent when the gateway has no admin surface to ask — a model runtime
   * reached directly (GW-E7). That is deliberately an absent method rather than
   * one returning null, so a caller can tell "there is nobody to ask" from "we
   * asked and were refused"; enrollment says different things about each.
   *
   * `null` means the gateway refused, or answered something that was not a key.
   * It never means "carry on without one": the shared company key is not a
   * fallback, and treating a refusal as success is how it would become one.
   */
  mintMemberKey?(
    endpoint: EndpointConfig,
    env: NodeJS.ProcessEnv,
    request: MintRequest,
  ): Promise<MintedKey | null>;
  /**
   * Kill a credential this host issued (P18-E2). `true` also covers a key the
   * gateway does not have — already gone is the state we wanted, and reporting
   * it as a failure makes a leaver's revoke look unfinished. `false` means we
   * were refused or could not ask, so the caller must say the credential may
   * still be live rather than report a revocation that did not happen.
   */
  revokeMemberKey?(endpoint: EndpointConfig, env: NodeJS.ProcessEnv, keyId: string): Promise<boolean>;
}

export interface MintRequest {
  /** Named on the key at the gateway, so the company can see whose is whose. */
  memberId: string;
  /** ISO, or null for a credential with no expiry. */
  expiresAt: string | null;
}

export interface MintedKey {
  value: string;
  expiresAt: string | null;
  /** The gateway's handle for this key, so it can be revoked later (P18-E2).
   *  `null` when the gateway issued one without telling us what to call it —
   *  the key works, and it can only be retired by expiry. */
  keyId: string | null;
}
