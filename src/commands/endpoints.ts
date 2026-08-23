// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `baton endpoints status` — what your own model servers are doing.
 *
 * The command someone runs when their local models are not being used, so it
 * answers the whole question on one screen: reachable or not, what each one is
 * serving right now, whether that list was confirmed or merely configured, and
 * for every model whether using it keeps the code on their network.
 */
import { activeBatonRoot } from '../store.js';
import { endpointsStatus, endpointStatusLines } from '../endpoints/status.js';
import { applyEnrollment, fetchEnrollment } from '../endpoints/enrollment.js';
import { endpointForModel, loadEndpointsConfig, type EndpointConfig } from '../endpoints/config.js';
import { probeEndpoint } from '../endpoints/health.js';
import { endpointLaunchEnv } from '../endpoints/launch-env.js';
import { endpointViaFor } from '../endpoints/reach.js';
import {
  loadProviderPolicy,
  providerLaunchRefusal,
  resolveProviderMode,
  setUserProviderMode,
} from '../endpoints/policy.js';
import { classifyEgress } from '../endpoints/egress.js';
import { grantEnforcement, grantModel, loadGrants, revokeModelGrant, withGrants } from '../endpoints/grants.js';
import { loadHostLink } from '../host-link.js';

export async function endpointsStatusCmd(): Promise<void> {
  const root = await activeBatonRoot();
  const rows = await endpointsStatus(root);
  for (const line of endpointStatusLines(rows)) console.log(line);
}

/**
 * `baton endpoints refresh` — re-pull the company's endpoints (P18 step 3).
 *
 * The command someone runs after the company adds a model or rotates a key.
 * It only ever replaces what the company published; a personal endpoint in the
 * same file is untouched (P18-E3).
 */
export async function endpointsRefreshCmd(): Promise<void> {
  const root = await activeBatonRoot();
  const link = await loadHostLink(root);
  if (!link) {
    console.error('This machine is not linked to a host, so there is nothing to refresh.');
    console.error('  Join one:  baton join <host-url> --token baton_…');
    process.exitCode = 1;
    return;
  }

  const { payload, error } = await fetchEnrollment(link);
  if (!payload) {
    // Nothing is written on a failure. A half-refreshed fleet would point this
    // machine at a gateway with no credential and read as a broken install.
    console.error(`✗ could not refresh from ${link.url}: ${error ?? 'the host returned no usable enrollment'}`);
    console.error('  Nothing was changed.');
    process.exitCode = 1;
    return;
  }

  await applyEnrollment(root, payload);
  const withKeys = payload.credentials.length;
  console.log(`✓ ${payload.endpoints.length} company endpoint(s) written, ${withKeys} with a credential of your own`);
  for (const note of payload.notes) console.log(`  ! ${note}`);
  console.log('  Your own endpoints in baton.config.json were left alone.');
}

/* ------------------------------------------------------------------ */
/* Grants — who may run a model that leaves the network                */
/* ------------------------------------------------------------------ */

export async function endpointsGrantCmd(
  member: string,
  model: string,
  opts: { endpoint?: string } = {},
): Promise<void> {
  const root = await activeBatonRoot();
  const { config } = await loadEndpointsConfig(root);
  const endpoint = pickEndpoint(config, model, opts.endpoint);
  if (!endpoint) return;

  // Saying this rather than silently recording a grant nobody needs: the whole
  // point of the egress badge is that people can trust what it means.
  if (classifyEgress(endpoint) === 'local') {
    console.log(`'${model}' runs on your own network via '${endpoint.id}' — everyone can already use it. No grant needed.`);
    return;
  }

  await withGrants(root, (reg) =>
    grantModel(reg, {
      memberId: member,
      endpointId: endpoint.id,
      model,
      grantedBy: 'owner',
      at: new Date().toISOString(),
    }),
  );
  console.log(`✓ ${member} may now use '${model}' on '${endpoint.id}' — which leaves your network.`);
  if (grantEnforcement(endpoint) !== 'gateway') {
    // GW-E7 — say what this does and does not do, rather than implying a
    // control that is not there.
    console.log(`  Note: '${endpoint.id}' has no gateway in front of it, so this is a record of who may use it,`);
    console.log('  not something the network enforces. Everyone reaching it shares one credential.');
  }
}

export async function endpointsRevokeGrantCmd(
  member: string,
  model: string,
  opts: { endpoint?: string } = {},
): Promise<void> {
  const root = await activeBatonRoot();
  const { config } = await loadEndpointsConfig(root);
  const endpoint = pickEndpoint(config, model, opts.endpoint);
  if (!endpoint) return;

  await withGrants(root, (reg) => revokeModelGrant(reg, member, endpoint.id, model, new Date().toISOString()));
  console.log(`✓ ${member} may no longer start new work on '${model}' via '${endpoint.id}'.`);
  // GW-E2 — stated up front, because an admin expecting an immediate stop and
  // not getting one will go looking for a bug.
  console.log('  A run already under way finishes on the model it started with.');
}

export async function endpointsGrantsCmd(): Promise<void> {
  const root = await activeBatonRoot();
  const reg = await loadGrants(root);
  const live = reg.grants.filter((g) => !g.revokedAt);

  if (!reg.administered) {
    console.log('Nobody administers this machine, so every model is yours to use.');
    console.log('  Add a member (`baton member add`) and models that leave your network become grant-only.');
    return;
  }
  if (!live.length) {
    console.log('No grants. Models on your own network are open to everyone; nothing external is.');
    console.log('  Grant one:  baton endpoints grant <member> <model> --endpoint <id>');
    return;
  }
  console.log('member                endpoint             model');
  for (const g of live) {
    console.log(`${g.memberId.padEnd(21)} ${g.endpointId.padEnd(20)} ${g.model}`);
  }
  console.log(`\n  ${live.length} grant(s). Every one of these lets that person send code off your network.`);
}

/** The endpoint an admin meant. Named explicitly when two serve one model
 *  (GW-E4) — guessing there would grant against the wrong one silently. */
function pickEndpoint(
  config: { endpoints: EndpointConfig[] },
  model: string,
  wanted: string | undefined,
): EndpointConfig | null {
  if (wanted) {
    const found = config.endpoints.find((e) => e.id === wanted);
    if (!found) {
      console.error(`✗ no endpoint '${wanted}'. Configured: ${config.endpoints.map((e) => e.id).join(', ') || 'none'}`);
      process.exitCode = 1;
      return null;
    }
    return found;
  }
  const serving = config.endpoints.filter((e) => e.models.includes(model));
  if (serving.length === 1) return serving[0];
  if (!serving.length) {
    console.error(`✗ no configured endpoint serves '${model}'. Name one with --endpoint <id>.`);
  } else {
    console.error(`✗ ${serving.length} endpoints serve '${model}' (${serving.map((e) => e.id).join(', ')}). Name one with --endpoint <id>.`);
  }
  process.exitCode = 1;
  return null;
}

/* ------------------------------------------------------------------ */
/* P27 — per-agent provider routing                                    */
/* ------------------------------------------------------------------ */

/**
 * `baton endpoints preview <agent>` — exactly what launching this agent would
 * change, before it changes it.
 *
 * The point is that nothing is hidden. A developer deciding whether to route
 * their work through a company gateway should be able to see the actual
 * variables, the actual endpoint and the actual refusal, rather than trusting a
 * toggle. Credential VALUES are never printed — the variable name is the useful
 * part, and the value is the part that ends up in a screenshot.
 */
export async function endpointsPreviewCmd(agent: string, opts: { model?: string } = {}): Promise<void> {
  const root = await activeBatonRoot();
  const policy = await loadProviderPolicy(root);
  const decision = resolveProviderMode(agent, policy, process.env);
  const { config } = await loadEndpointsConfig(root);

  console.log(`${agent}: ${decision.mode}${decision.source === 'default' ? '' : `  (from ${decision.source})`}`);
  console.log(`  ${decision.detail}`);

  if (decision.mode !== 'gateway') {
    console.log('  Launch would set: nothing.');
    return;
  }

  const model = opts.model;
  const endpoint = model ? endpointForModel(config, model) : (config.endpoints[0] ?? null);
  const health = endpoint ? (await probeEndpoint(endpoint, process.env)).state : 'unreachable';
  const refusal = providerLaunchRefusal(decision, endpoint, health);
  if (refusal) {
    console.log(`\n  ✗ ${refusal}`);
    process.exitCode = 1;
    return;
  }

  const injected = endpointLaunchEnv(endpoint!, endpointViaFor(agent), process.env);
  console.log(`\n  endpoint  ${endpoint!.id} (${endpoint!.url})`);
  console.log(`  egress    ${classifyEgress(endpoint!)}`);
  console.log('  launch would set:');
  for (const [name, value] of Object.entries(injected)) {
    // A base URL is information; a credential is not. Naming the variable says
    // everything useful without putting the key in someone's terminal history.
    console.log(`    ${name}=${name.toLowerCase().includes('key') || name === endpoint!.authEnv ? '<credential, not shown>' : value}`);
  }
  if (!Object.keys(injected).length) {
    console.log('    nothing — this agent reaches this endpoint natively, with no variable to set');
  }
}

export async function endpointsUseCmd(agent: string, mode: string): Promise<void> {
  const root = await activeBatonRoot();
  if (mode !== 'vendor' && mode !== 'gateway') {
    console.error(`✗ '${mode}' is not a mode. Use 'vendor' (its own subscription) or 'gateway' (your own models).`);
    process.exitCode = 1;
    return;
  }
  const policy = await loadProviderPolicy(root);
  const before = resolveProviderMode(agent, policy, process.env);
  if (before.mode === 'unavailable') {
    // P27-E3 — say why, rather than writing a setting that can never apply.
    console.error(`✗ ${before.detail}`);
    process.exitCode = 1;
    return;
  }
  await setUserProviderMode(root, agent, mode);

  const after = resolveProviderMode(agent, await loadProviderPolicy(root), process.env);
  console.log(`✓ ${agent}: ${after.mode}`);
  if (after.mode !== mode) {
    // The setting was written but something outranks it. Silence here is how
    // someone concludes the toggle is broken.
    console.log(`  Note: this repo's own config asks for '${before.source === 'repo' ? policy.repo[agent] : after.mode}', which wins here.`);
  }
  console.log('  Applies to the next launch. Anything running now keeps the provider it started with.');
}
