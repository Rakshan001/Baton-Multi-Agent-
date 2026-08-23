// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The endpoints section of `baton doctor` — lines, not printing, so what it
 * claims is testable.
 *
 * This is the command someone runs when their own models are not being used,
 * so it answers the whole question in one pass: what is configured, which
 * resolve, which models each serves, who can reach them, and which agents
 * cannot be pointed at them at all.
 *
 * It names `keyRef`. It never prints what the ref resolved to.
 */
import type { EndpointsConfig } from './config.js';
import { shadowedModels } from './config.js';
import { AGENT_ENDPOINT_REACH, agentsReachingKind } from './reach.js';

/** Agents whose vendors do not allow a self-hosted model at all. */
const VENDOR_ONLY = Object.entries(AGENT_ENDPOINT_REACH).filter(([, via]) => via === null).map(([id]) => id);

export function endpointDoctorLines(config: EndpointsConfig, errors: string[] = []): string[] {
  // Silent when nothing is configured and nothing was wrong — the normal case
  // is not a finding.
  if (!config.endpoints.length && !errors.length) return [];

  const out = ['Endpoints:', ''];
  for (const ep of config.endpoints) {
    out.push(`  ${ep.usable ? '✓' : '✗'} ${ep.id} — ${ep.kind}  ${ep.url}`);
    out.push(`      models: ${ep.models.length ? ep.models.join(', ') : 'none declared — the gateway is asked at launch'}`);
    if (ep.keyRef) out.push(`      key: ${ep.keyRef}${ep.usable ? ' (resolved)' : ''}`);
    if (!ep.usable) {
      out.push(`      ⚠ unusable: ${ep.unusable}`);
      out.push('      → set it and re-run; Baton never calls a gateway without the key it was told to use');
    }
    const reachers = agentsReachingKind(ep.kind);
    out.push(`      reachable by: ${reachers.length ? reachers.join(', ') : 'no agent Baton knows speaks this dialect'}`);
  }

  for (const s of shadowedModels(config)) {
    out.push(`  ⚠ ${s.model} is served by ${[s.winner, ...s.shadowedBy].join(' and ')} — ${s.winner} wins (declared first)`);
  }

  // An unusable endpoint is already rendered above with its reason; repeating
  // its error here makes one problem look like two.
  const shownInline = config.endpoints.filter((e) => !e.usable).map((e) => `endpoints.${e.id}.keyRef:`);
  for (const e of errors) {
    if (!shownInline.some((prefix) => e.startsWith(prefix))) out.push(`  ✗ ${e}`);
  }

  if (config.allowPaidFallback) {
    out.push('  ⚠ allowPaidFallback is on — a gateway outage may move queued tasks onto a paid model');
  }
  // The second question, answered before it is asked: a mixed fleet is the
  // vendors' doing, not a setting anyone forgot.
  out.push(`  · ${VENDOR_ONLY.join(', ')} stay on their vendors' models — their vendors allow no custom endpoint`);
  return out;
}
