/**
 * `baton connect [--agents claude,cursor,codex,gemini] [--yes]` — wire the
 * `baton` coordination MCP server into every agent's config in one command, so
 * all agents on this repo can see each other's live edits, tasks, and reports.
 *
 * Project-scoped files (claude/cursor, inside the repo) are written immediately;
 * global files in $HOME (codex/gemini) are only written with --yes. The KB graph
 * wiring is separate (`baton kb mcp` / the dashboard) — this is coordination.
 */
import { resolveBatonRoot } from '../store.js';
import { connectAgents, type AgentConnectOutcome } from '../agents/connect.js';

export const DEFAULT_CONNECT_AGENTS = ['claude', 'cursor', 'codex', 'gemini'];

const LINE: Record<AgentConnectOutcome['status'], (o: AgentConnectOutcome) => string> = {
  connected: (o) => `  ✓ ${o.agent} — wired (${o.path})`,
  already: (o) => `  · ${o.agent} — already connected`,
  'needs-confirm': (o) => `  ! ${o.agent} — writes a global file (${o.path}); rerun with --yes to confirm`,
  unsupported: (o) => `  – ${o.agent} — no standard MCP config to write (start it in the worktree manually)`,
  'parse-error': (o) => `  ✗ ${o.agent} — existing config at ${o.path} is unparseable; left untouched`,
};

export async function connectCmd(opts: { agents?: string; yes?: boolean } = {}): Promise<void> {
  const root = await resolveBatonRoot();
  const agents = opts.agents
    ? opts.agents.split(',').map((a) => a.trim()).filter(Boolean)
    : DEFAULT_CONNECT_AGENTS;

  const outcomes = await connectAgents(root, agents, { confirmGlobal: opts.yes });
  console.log(`Connecting agents to Baton coordination in ${root}:`);
  for (const o of outcomes) console.log(LINE[o.status](o));

  const deferred = outcomes.filter((o) => o.status === 'needs-confirm');
  if (deferred.length) {
    console.log(`\n  ${deferred.length} agent(s) write to your home dir. Rerun to confirm:`);
    console.log(`    baton connect --agents ${deferred.map((o) => o.agent).join(',')} --yes`);
  }
}
