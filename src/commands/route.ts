// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `baton route "<task>"` — which agent/model should take this task, and why:
 * matched rule or severity score, the tier's fallback chain, and which chain
 * entry actually resolves on this machine.
 */
import { agentInstalled } from '../agents/roster.js';
import { activeBatonRoot } from '../store.js';
import { CONFIG_FILE, entryLabel, loadRouting, resolveChain, suggestRoute } from '../routing.js';
import { loadLiveEndpoints } from '../endpoints/live-endpoints.js';

const available = (agent: string, root: string): Promise<boolean> =>
  agent === 'any' ? Promise.resolve(true) : agentInstalled(agent, root);

export async function routeCmd(text: string): Promise<void> {
  const root = await activeBatonRoot();
  const { config, path, errors } = await loadRouting(root);
  for (const e of errors) console.error(`! ${CONFIG_FILE}: ${e}`);

  const s = suggestRoute(text, config);
  const why =
    s.source === 'rule' ? `matched ${s.matched.map((m) => `'${m}'`).join(', ')}`
    : s.source === 'severity' ? `severity → ${s.tier} tier`
    : s.source === 'single' ? 'single-agent mode'
    : 'no rule matched — default';

  const live = await loadLiveEndpoints(root);
  const walked = await resolveChain(s.chain, (agent) => available(agent, root), live?.policyFor(s.tier));
  // `route` explains a decision, so a refusal is the answer here — not an
  // error. It still prints the chain and severity below.
  const refusal = walked && 'refused' in walked ? walked : null;
  const resolved = walked && 'entry' in walked ? walked : null;
  const pick = resolved?.entry ?? s.chain[0];
  const model = pick.model ? ` (model: ${pick.model})` : '';

  console.log(refusal
    ? `✗ refused   ${why}`
    : `→ ${pick.agent}${model}   ${why}${s.confidence === 'low' ? ' · low confidence' : ''}`);
  if (refusal) console.log(`  ${refusal.reason}`);
  if (resolved?.promoted) {
    console.log(`  ⚠ promoted ${entryLabel(resolved.promoted.from)} → ${entryLabel(resolved.promoted.to)} (paid): ${resolved.promoted.reason}`);
  }
  console.log(`  severity: ${s.severity}/100${s.signals.length ? `   ${s.signals.join(' · ')}` : ''}`);
  if (s.downshift) {
    const alt = s.downshift.chain.map((e) => e.agent + (e.model ? `:${e.model}` : '')).join(' → ');
    console.log(`  💡 cheaper option: ${alt} — ${s.downshift.reason}`);
  }
  if (s.chain.length > 1) {
    const chain = s.chain.map((e, i) => {
      const label = `${e.agent}${e.model ? `:${e.model}` : ''}`;
      return i === (resolved?.index ?? 0) ? `[${label}]` : label;
    });
    console.log(`  ${s.tier ? `${s.tier} tier ` : ''}chain: ${chain.join(' → ')}${resolved?.skipped.length ? `   (skipped, not installed: ${resolved.skipped.join(', ')})` : ''}`);
  }
  if (!refusal && !resolved) console.log(`  note: nothing in the chain is installed — install '${s.chain[0].agent}' or route elsewhere with --to`);
  console.log(`  mode: ${s.mode}${s.mode === 'manual' ? ' (suggestions are advisory — Baton will not auto-route)' : ''}`);
  console.log(`  config: ${path ?? 'built-in defaults (create baton.config.json to customize)'}`);
  console.log(`  hand off with: baton pass <slug> --to ${pick.agent}   (or omit --to to auto-route)`);
}
