/**
 * `baton disconnect [--agents claude,cursor,codex,gemini] [--yes]` — the
 * inverse of `baton connect`. Removes the MCP servers Baton wrote and nothing
 * else, so uninstalling Baton doesn't leave every agent launching a `baton`
 * binary that no longer exists.
 *
 * Same scope policy as connecting: project files are rewritten immediately,
 * global files in $HOME only with --yes.
 */
import { resolveBatonRoot } from '../store.js';
import { disconnectAgents, type AgentDisconnectOutcome } from '../agents/connect.js';
import { DEFAULT_CONNECT_AGENTS } from './connect.js';

const LINE: Record<AgentDisconnectOutcome['status'], (o: AgentDisconnectOutcome) => string> = {
  disconnected: (o) => `  ✓ ${o.agent} — removed ${o.removed.join(', ')} (${o.path})`,
  nothing: (o) => `  · ${o.agent} — nothing of Baton's to remove`,
  'needs-confirm': (o) => `  ! ${o.agent} — would remove ${o.removed.join(', ')} from a global file (${o.path}); rerun with --yes`,
  unsupported: (o) => `  – ${o.agent} — no standard MCP config Baton writes`,
  'parse-error': (o) => `  ✗ ${o.agent} — existing config at ${o.path} is unparseable; left untouched`,
  failed: (o) => `  ✗ ${o.agent} — could not read ${o.path}: ${o.error}`,
};

export async function disconnectCmd(opts: { agents?: string; yes?: boolean } = {}): Promise<void> {
  const root = await resolveBatonRoot();
  const agents = opts.agents
    ? opts.agents.split(',').map((a) => a.trim()).filter(Boolean)
    : DEFAULT_CONNECT_AGENTS;

  const outcomes = await disconnectAgents(root, agents, { confirmGlobal: opts.yes });
  console.log(`Disconnecting agents from Baton coordination in ${root}:`);
  for (const o of outcomes) {
    console.log(LINE[o.status](o));
    // A look-alike we refused to touch is reported, never silently kept: a
    // partial removal the user can't see is worse than no removal at all.
    for (const s of o.skipped) console.log(`      ○ kept ${s.name} — ${s.why}`);
  }

  const deferred = outcomes.filter((o) => o.status === 'needs-confirm');
  if (deferred.length) {
    console.log(`\n  ${deferred.length} agent(s) keep Baton in your home dir. Rerun to confirm:`);
    console.log(`    baton disconnect --agents ${deferred.map((o) => o.agent).join(',')} --yes`);
  }
}
