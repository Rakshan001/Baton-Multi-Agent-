// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One answer to "what can I actually run right now, and does it leave the
 * network?" — assembled once, printed by the CLI, published on the bus, and
 * (P19) rendered by the desktop pane and the phone.
 *
 * Assembled once on purpose. At 200 clients the rule is one poller, one shared
 * snapshot, fan out over the bus: a viewer must never trigger an upstream call,
 * and the 201st viewer must cost the gateway nothing.
 *
 * The rendering never upgrades what it was given. An unverified list says so, an
 * indeterminate probe is not "up", and `unknown` egress reads as a warning —
 * because a developer who cannot tell which models leave the network is the
 * exact confusion this product exists to prevent.
 */
import { endpointCatalog } from './catalog.js';
import { loadEndpointsConfig, type EndpointKind } from './config.js';
import { classifyEgress, type EgressClass } from './egress.js';
import { gatewayAdapterFor } from './gateways/registry.js';
import type { CatalogModel } from './gateways/types.js';
import { probeEndpoint, type EndpointHealth } from './health.js';
import { AGENT_ENDPOINT_REACH, agentsReachingKind, reachesKind } from './reach.js';

export interface EndpointStatusRow {
  id: string;
  kind: EndpointKind;
  url: string;
  /** The adapter administering it — read from the adapter, never hard-coded. */
  gateway: string;
  egress: EgressClass;
  health: EndpointHealth;
  detail: string;
  models: CatalogModel[];
  /** false ⇒ these models came from config, not from the gateway. */
  verified: boolean;
  fetchedAt: string;
  usable: boolean;
  unusable: string | null;
  /** Agents whose vendor allows them to be pointed at this dialect. */
  reachableBy: string[];
  /** And the ones that cannot be — sent so the UI can state it as a fact
   *  instead of hiding the rows, which reads as "we forgot Antigravity". */
  unreachableBy: string[];
}

/** What each egress class is called in front of a human. */
const EGRESS_BADGE: Record<EgressClass, string> = {
  local: 'On your network',
  external: 'Leaves your network',
  unknown: 'Unverified — treated as leaving your network',
};

const HEALTH_GLYPH: Record<EndpointHealth, string> = {
  ok: '✓',
  unreachable: '✗',
  unauthorized: '✗',
  unknown: '?',
};

export async function endpointsStatus(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EndpointStatusRow[]> {
  const { config } = await loadEndpointsConfig(root, env);

  const rows = await Promise.all(config.endpoints.map(async (endpoint): Promise<EndpointStatusRow> => {
    // Probing an endpoint config already called unusable spends a round trip to
    // be told what config said, so it is asked only about the ones we could use.
    const [probe, catalog] = await Promise.all([
      endpoint.usable
        ? probeEndpoint(endpoint, env)
        // Never asked, so it cannot be `unauthorized` — that is a rejection the
        // gateway would have had to issue. `unknown` plus the config reason is
        // what we actually know (P16-E8 keeps the two causes apart).
        : Promise.resolve({ state: 'unknown' as const, detail: endpoint.unusable ?? 'unusable' }),
      endpointCatalog(endpoint, env),
    ]);
    return {
      id: endpoint.id,
      kind: endpoint.kind,
      url: endpoint.url,
      gateway: gatewayAdapterFor(endpoint).adapter.id,
      egress: classifyEgress(endpoint),
      health: probe.state,
      detail: probe.detail,
      models: catalog.models,
      verified: catalog.verified,
      fetchedAt: catalog.fetchedAt,
      usable: endpoint.usable,
      unusable: endpoint.unusable,
      // Computed here, never in a client: one table, in one repo, so a fork's
      // panel and a phone cannot drift from what the dispatcher believes.
      reachableBy: agentsReachingKind(endpoint.kind),
      unreachableBy: Object.entries(AGENT_ENDPOINT_REACH)
        .filter(([, via]) => !reachesKind(via, endpoint.kind))
        .map(([id]) => id),
    };
  }));

  // 🔴 Deliberately does NOT publish. This function answers a READ, and every
  // client that reads also re-fetches on any bus event — so publishing here
  // made read -> event -> read, forever. D5's rule is that a viewer never
  // triggers an upstream call; the `endpoints.status` event belongs to the
  // poller that will own the usage feed, not to this path.
  return rows;
}

/** Pure, so what this screen CLAIMS is a unit test rather than something you
 *  check by reading it. */
export function endpointStatusLines(rows: EndpointStatusRow[]): string[] {
  if (!rows.length) {
    return [
      'No endpoints configured.',
      '  Add an `endpoints` block to baton.config.json to run models on your own hardware.',
    ];
  }

  const out: string[] = [];
  for (const row of rows) {
    out.push(`${HEALTH_GLYPH[row.health]} ${row.id} — ${row.kind} via ${row.gateway}  ${row.url}`);
    out.push(`    ${EGRESS_BADGE[row.egress]}`);
    out.push(`    ${row.detail}`);
    if (!row.usable && row.unusable) out.push(`    ⚠ unusable: ${row.unusable}`);

    // Stated, not hidden. "Why is my Antigravity task not using the gateway"
    // is answered by seeing antigravity listed as unable to reach it.
    if (row.reachableBy.length) out.push(`    reachable by: ${row.reachableBy.join(', ')}`);
    if (row.unreachableBy.length) {
      out.push(`    cannot reach it: ${row.unreachableBy.join(', ')} — their vendors allow no custom endpoint, or a different dialect`);
    }

    const label = row.verified ? 'serving' : 'configured (unverified)';
    out.push(`    ${label}, as of ${row.fetchedAt}:`);
    if (!row.models.length) {
      out.push('      (no models)');
    } else {
      for (const model of row.models) {
        // Per model, not per endpoint: two endpoints can serve the same name,
        // and a row a developer reads must carry its own answer.
        out.push(`      ${model.id}   ${EGRESS_BADGE[model.egress]}`);
      }
    }
  }
  return out;
}
