/**
 * `baton route "<task>"` — which agent should take this task, and why.
 * Uses the committable routing config (baton.config.json) or built-ins.
 */
import { execa } from 'execa';
import { gitRoot } from '../git.js';
import { loadRouting, suggestAgent, CONFIG_FILE } from '../routing.js';

async function onPath(agent: string): Promise<boolean> {
  if (agent === 'any') return true;
  try {
    await execa('which', [agent], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function routeCmd(text: string): Promise<void> {
  const root = await gitRoot();
  const { config, path, errors } = await loadRouting(root);
  for (const e of errors) console.error(`! ${CONFIG_FILE}: ${e}`);

  const s = suggestAgent(text, config);
  const why = s.source === 'rule' ? `matched ${s.matched.map((m) => `'${m}'`).join(', ')}` : `no rule matched — default`;
  const model = s.model ? ` (model: ${s.model})` : '';
  console.log(`→ ${s.agent}${model}   ${why}`);
  console.log(`  config: ${path ?? 'built-in defaults (create baton.config.json to customize)'}`);
  if (!(await onPath(s.agent))) {
    console.log(`  note: '${s.agent}' CLI not found on PATH — install it or route elsewhere with --to`);
  }
  console.log(`  hand off with: baton pass <slug> --to ${s.agent}   (or omit --to to auto-route)`);
}
