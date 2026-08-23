// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What an endpoint is actually serving — which is not always what config claims.
 *
 * Config's `models` list stops being the source of truth here and becomes the
 * fallback for when the gateway cannot be asked. A fallback list is marked
 * `verified: false` and every surface that renders it says so: a list nobody
 * confirmed, shown as if somebody had, is the same class of lie as reporting a
 * health check we could not run as "up".
 *
 * Cheap by construction (P17-E4): one fetch per endpoint per window, shared by
 * every caller — including callers that arrive while the first fetch is still
 * in the air, which a result-only cache would let through.
 */
import { classifyEgress } from './egress.js';
import { gatewayAdapterFor } from './gateways/registry.js';
import type { CatalogModel, GatewayCatalog } from './gateways/types.js';
import type { EndpointConfig } from './config.js';

export type { CatalogModel, GatewayCatalog } from './gateways/types.js';

/** The same window the install probe uses; long enough that a dispatch round
 *  asks once, short enough that a model loaded a minute ago appears. */
export const CATALOG_TTL_MS = 30_000;

const cache = new Map<string, { at: number; catalog: GatewayCatalog }>();
const inFlight = new Map<string, Promise<GatewayCatalog>>();

export function clearCatalogCache(): void {
  cache.clear();
  inFlight.clear();
}

const keyOf = (endpoint: EndpointConfig): string => `${endpoint.id} ${endpoint.url}`;

export async function endpointCatalog(
  endpoint: EndpointConfig,
  env: NodeJS.ProcessEnv,
  now: number = Date.now(),
): Promise<GatewayCatalog> {
  const key = keyOf(endpoint);
  const hit = cache.get(key);
  if (hit && now - hit.at < CATALOG_TTL_MS) return hit.catalog;

  // Twenty queued tasks asking at once must produce one request, not twenty.
  const running = inFlight.get(key);
  if (running) return running;

  const pending = ask(endpoint, env).then((catalog) => {
    cache.set(key, { at: now, catalog });
    inFlight.delete(key);
    return catalog;
  }, (e: unknown) => {
    inFlight.delete(key);
    throw e;
  });
  inFlight.set(key, pending);
  return pending;
}

async function ask(endpoint: EndpointConfig, env: NodeJS.ProcessEnv): Promise<GatewayCatalog> {
  const { adapter } = gatewayAdapterFor(endpoint);
  const egress = classifyEgress(endpoint);
  const fetchedAt = new Date().toISOString();
  const asModels = (ids: string[]): CatalogModel[] =>
    ids.map((id) => ({ id, endpointId: endpoint.id, egress }));

  const served = await adapter.catalog(endpoint, env);
  if (served !== null) return { models: asModels(served), verified: true, fetchedAt };

  return {
    models: asModels(endpoint.models),
    verified: false,
    fetchedAt,
    detail: endpoint.models.length
      ? `could not ask '${endpoint.id}' what it serves — showing the configured list, unverified`
      : `could not ask '${endpoint.id}' what it serves, and its config lists no models`,
  };
}
