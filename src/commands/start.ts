/**
 * `baton start <slug>` — run an agent headlessly in the task's worktree,
 * streaming its output. `baton stop <slug>` ends it. The same engine powers
 * the dashboard's start/stop buttons (POST /api/tasks/:slug/agent/*).
 */
import { bus } from '../events.js';
import { HEADLESS_AGENTS, startAgent, stopAgent, waitForAgent } from '../spawn.js';

export async function startCmd(slug: string, opts: { agent?: string; prompt?: string }): Promise<void> {
  const unsub = bus.onType('agent.output', (e) => {
    if (e.event.type === 'agent.output' && e.event.slug === slug) {
      (e.event.stream === 'err' ? process.stderr : process.stdout).write(e.event.line + '\n');
    }
  });
  try {
    const r = await startAgent(slug, opts);
    console.log(`▶ ${r.agent} started in worktree (pid ${r.pid ?? '?'}) · prompt: ${r.promptSource === 'handoff' ? 'HANDOFF.md brief' : 'task description'}`);
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
