// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `baton start <slug>` — run an agent headlessly in the task's worktree,
 * streaming its output. `baton stop <slug>` ends it. The same engine powers
 * the dashboard's start/stop buttons (POST /api/tasks/:slug/agent/*).
 */
import { bus } from '../events.js';
import { HEADLESS_AGENTS, stopAgent, waitForAgent } from '../spawn.js';
import { LocalExecutor } from '../executors/local.js';
import { activeBatonRoot } from '../store.js';

/**
 * P2-E5: routed through the executor seam so that when the Orca backend lands,
 * `baton start` gets it without another rewrite. Behaviour is unchanged and
 * that is asserted directly (executor-start-parity.test.ts) — the printed line
 * is a contract people read and scripts grep.
 */
const executor = new LocalExecutor();

export async function startCmd(slug: string, opts: { agent?: string; model?: string; prompt?: string }): Promise<void> {
  const unsub = bus.onType('agent.output', (e) => {
    if (e.event.type === 'agent.output' && e.event.slug === slug) {
      (e.event.stream === 'err' ? process.stderr : process.stdout).write(e.event.line + '\n');
    }
  });
  try {
    const r = await executor.launch({
      slug,
      agentId: opts.agent ?? '',
      nativeId: opts.agent ?? '',
      model: opts.model,
      cwd: '',
      prompt: opts.prompt ?? '',
      env: { BATON_ROOT: await activeBatonRoot() },
      mode: 'headless',
    });
    console.log(`▶ ${r.agentId}${r.model ? ` (model: ${r.model})` : ''} started in worktree (pid ${r.pid ?? '?'}) · prompt: ${r.promptSource === 'handoff' ? 'HANDOFF.md brief' : 'task description'}`);
    console.log('  Ctrl+C stops the agent\n');
    process.on('SIGINT', () => {
      stopAgent(slug);
    });
    await waitForAgent(slug);
  } finally {
    unsub();
  }
}

export async function stopCmd(slug: string): Promise<void> {
  console.log(stopAgent(slug)
    ? `✓ stopping headless agent for '${slug}'`
    : `no headless agent running for '${slug}' (agents started in your own terminal aren't managed by baton — supported here: ${HEADLESS_AGENTS.join(', ')})`);
}
