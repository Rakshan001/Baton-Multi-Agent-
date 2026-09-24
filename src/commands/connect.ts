// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
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
import {
  DEFAULT_ORIENT_AGENTS, connectAgents, disconnectOrient,
  type AgentConnectOutcome,
} from '../agents/connect.js';

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

  /* Connecting now also writes a "call orient first" block into each agent's own
     instruction file — a file the USER owns. That must never happen silently:
     every write is named here, every backup path is printed, and an agent that
     could not be bound is listed rather than skipped. */
  const wrote = outcomes.filter((o) => o.orient === 'bound' || o.orient === 'updated');
  const unbindable = outcomes.filter((o) => o.orient === 'unbound');
  const failed = outcomes.filter((o) => o.orient === 'failed');
  if (wrote.length || failed.length || unbindable.length) {
    console.log('\nSession-start instruction (tells the agent to call `orient` first):');
    for (const o of wrote) {
      console.log(`  ✓ ${o.agent} — ${o.orient === 'updated' ? 'refreshed' : 'added'} in ${o.orientPath}`
        + (o.orientBackup ? `\n      your original: ${o.orientBackup}` : ''));
    }
    for (const o of outcomes.filter((x) => x.orient === 'already')) {
      console.log(`  · ${o.agent} — already in ${o.orientPath}`);
    }
    for (const o of unbindable) console.log(`  – ${o.agent} — no instruction file Baton knows to write`);
    for (const o of failed) console.log(`  ✗ ${o.agent} — couldn't write ${o.orientPath}; left untouched`);
    console.log('  Edit these files freely outside the marked block. `baton disconnect` removes it.');
  }

  const deferred = outcomes.filter((o) => o.status === 'needs-confirm');
  if (deferred.length) {
    console.log(`\n  ${deferred.length} agent(s) write to your home dir. Rerun to confirm:`);
    console.log(`    baton connect --agents ${deferred.map((o) => o.agent).join(',')} --yes`);
  }
}

/**
 * `baton disconnect [--agents ...]` — take back the session-start instruction
 * `connect` wrote into the user's own CLAUDE.md / AGENTS.md / GEMINI.md.
 *
 * `connect` writes into files the user owns, so there has to be a way out that
 * is a command rather than "go and hand-edit your CLAUDE.md". Only the marked
 * block is removed; a file Baton created and that holds nothing else is deleted
 * rather than left empty, and a file with the user's own content keeps it.
 *
 * This does NOT remove the MCP server registration — that lives in a different
 * file with a different lifetime, and quietly unwiring it here would be a
 * bigger action than the command's name promises.
 */
export async function disconnectCmd(opts: { agents?: string } = {}): Promise<void> {
  const root = await resolveBatonRoot();
  const agents = opts.agents
    ? opts.agents.split(',').map((a) => a.trim()).filter(Boolean)
    : DEFAULT_ORIENT_AGENTS;

  const results = await disconnectOrient(root, agents);
  console.log(`Removing the Baton session-start instruction in ${root}:`);
  for (const r of results) {
    if (r.status === 'unbound') console.log(`  \u2713 ${r.agent} \u2014 removed (${r.path})`);
    else if (r.status === 'absent') console.log(`  \u00b7 ${r.agent} \u2014 nothing to remove`);
    else console.log(`  \u2717 ${r.agent} \u2014 could not edit ${r.path ?? 'its instruction file'}; left untouched`);
  }
  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length) {
    console.log('\nSome files could not be edited. They are unchanged \u2014 nothing was partially removed.');
  }
  console.log('\nThe MCP server registration is untouched; this only removes the "call orient first" block.');
}
