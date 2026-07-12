/**
 * `baton route "<task>"` — which agent/model should take this task, and why:
 * matched rule or severity score, the tier's fallback chain, and which chain
 * entry actually resolves on this machine.
 */
import { gitRoot } from '../git.js';
import { agentInstalled } from '../agents/roster.js';
import { CONFIG_FILE, loadRouting, resolveChain, suggestRoute } from '../routing.js';

const available = (agent: string): Promise<boolean> =>
  agent === 'any' ? Promise.resolve(true) : agentInstalled(agent);

export async function routeCmd(text: string): Promise<void> {
  const root = await gitRoot();
  const { config, path, errors } = await loadRouting(root);
  for (const e of errors) console.error(`! ${CONFIG_FILE}: ${e}`);

  const s = suggestRoute(text, config);
  const why =
    s.source === 'rule' ? `matched ${s.matched.map((m) => `'${m}'`).join(', ')}`
    : s.source === 'severity' ? `severity → ${s.tier} tier`
    : s.source === 'single' ? 'single-agent mode'
    : 'no rule matched — default';

  const resolved = await resolveChain(s.chain, available);
  const pick = resolved?.entry ?? s.chain[0];
  const model = pick.model ? ` (model: ${pick.model})` : '';

  console.log(`→ ${pick.agent}${model}   ${why}${s.confidence === 'low' ? ' · low confidence' : ''}`);
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
  if (!resolved) console.log(`  note: nothing in the chain is installed — install '${s.chain[0].agent}' or route elsewhere with --to`);
  console.log(`  mode: ${s.mode}${s.mode === 'manual' ? ' (suggestions are advisory — Baton will not auto-route)' : ''}`);
  console.log(`  config: ${path ?? 'built-in defaults (create baton.config.json to customize)'}`);
  console.log(`  hand off with: baton pass <slug> --to ${pick.agent}   (or omit --to to auto-route)`);
}
