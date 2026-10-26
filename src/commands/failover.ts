// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `baton failover <slug> --agents claude,codex,gemini`
 *
 * Start the first headless agent on the task's worktree. If it reports a
 * provider limit, stop it, write a HANDOFF.md brief, and start the next agent on
 * the same worktree. The chain is bounded and every launch is printed; this is
 * a foreground supervisor, not a daemon.
 *
 * The interesting parts live in `src/failover.ts` (pure and unit-tested). This
 * file only wires the real spawner, handoff writer, claim bookkeeping and bus.
 */
import { activeBatonRoot, getTask, mutateTasks } from '../store.js';
import { hasHeadlessRun, launchersFor, startAgent, stopAgent, waitForAgent } from '../spawn.js';
import { compilePatterns, runFailover, type FailoverDeps } from '../failover.js';
import { passTask } from './pass.js';
import { claimTask } from './claim.js';
import { agentInstalled } from '../agents/roster.js';
import { block as blockTask, releaseClaim } from '../lifecycle.js';
import { bus } from '../events.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FailoverCmdOptions {
  agents?: string;
  max?: number;
  pattern?: string[];
}

/** The running map is deleted a microtask after the child exits; give it a
 *  moment before starting the next agent for the same slug. */
async function waitForSlot(slug: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (hasHeadlessRun(slug) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (hasHeadlessRun(slug)) {
    throw new Error(`the previous '${slug}' run is still shutting down`);
  }
}

/** Claim a queued pipeline task for the first agent. Plain `baton new` tasks
 *  have no pipeline state and are left alone. */
async function prepareTask(root: string, slug: string, agent: string): Promise<void> {
  const task = await getTask(root, slug);
  if (!task) throw new Error(`No task '${slug}'`);
  if (task.state === undefined) return; // pre-pipeline task: no claim to take
  if (task.claimedBy) {
    if (task.claimedBy.agent === agent && task.claimedBy.sessionSlug === slug) return;
    throw new Error(
      `'${slug}' is held by ${task.claimedBy.agent}. Finish it, or \`baton pause ${slug}\`, before starting a failover run.`,
    );
  }
  await claimTask(root, slug, { agent, sessionSlug: slug }, {});
}

/** Move a pipeline claim from the agent that just stopped to the next one.
 *  Plain tasks have nothing to move. */
async function reassignTask(root: string, slug: string, from: string, to: string): Promise<void> {
  const task = await getTask(root, slug);
  if (!task || task.state === undefined) return;
  if (!task.claimedBy || task.claimedBy.sessionSlug !== slug) {
    throw new Error(`'${slug}' is not held by this failover run`);
  }
  const released = await mutateTasks(root, (tasks) => {
    const who = { agent: from, sessionSlug: slug };
    const out = releaseClaim(tasks, slug, who);
    return { tasks: out.ok ? out.tasks : null, result: out };
  });
  if (!released.ok) throw new Error(released.refusal.message);
  await claimTask(root, slug, { agent: to, sessionSlug: slug }, { override: true });
}

/** Best effort: mark a pipeline task blocked. Plain tasks have no state row. */
async function blockTaskBySlug(root: string, slug: string, reason: string): Promise<void> {
  const task = await getTask(root, slug);
  if (!task || task.state === undefined) return;
  const agent = task.claimedBy?.agent ?? '';
  await mutateTasks(root, (tasks) => {
    const out = blockTask(tasks, slug, { agent, sessionSlug: slug }, reason, new Date().toISOString());
    return { tasks: out.ok ? out.tasks : null, result: out };
  });
}

export async function failoverCmd(slug: string, opts: FailoverCmdOptions): Promise<void> {
  const root = await activeBatonRoot();
  const agents = (opts.agents ?? '').split(',').map((a) => a.trim()).filter(Boolean);
  if (agents.length < 2) {
    throw new Error('pass --agents with at least two agents, e.g. --agents claude,codex');
  }
  if (opts.max !== undefined && (!Number.isInteger(opts.max) || opts.max < 1)) {
    throw new Error('--max must be a positive integer');
  }
  const launchers = launchersFor(root);
  for (const agent of agents) {
    if (!launchers[agent]) {
      throw new Error(
        `'${agent}' has no headless mode Baton can drive — supported: ${Object.keys(launchers).join(', ')}`,
      );
    }
    if (!(await agentInstalled(agent, root))) {
      throw new Error(
        `'${agent}' is not installed or not on PATH — Baton would not be able to start it. `
        + `Install it, or use a project agent in .baton/agents.json with an absolute command.`,
      );
    }
  }
  const patterns = compilePatterns(opts.pattern ?? []);

  // The next agent echoes the brief it reads; a brief can contain the previous
  // agent's limit line. Never treat those known texts as a new provider error.
  const ignoreLines: string[] = [];
  const initialTask = await getTask(root, slug);
  if (initialTask?.task) {
    ignoreLines.push(...initialTask.task.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  }

  // Print the live agent output. `startAgent` publishes it on the bus; the
  // supervisor subscribes separately to the same events for limit detection.
  const stopPrinting = bus.onType('agent.output', (e) => {
    if (e.event.type !== 'agent.output' || e.event.slug !== slug) return;
    (e.event.stream === 'err' ? process.stderr : process.stdout).write(e.event.line + '\n');
  });

  const deps: FailoverDeps = {
    prepare: (target, agent) => prepareTask(root, target, agent),
    async start(target, agent) {
      await waitForSlot(target);
      await startAgent(target, { agent }, root);
    },
    wait: (target) => waitForAgent(target),
    stop: (target) => stopAgent(target),
    watch(target, onLine) {
      return bus.onType('agent.output', (e) => {
        if (e.event.type === 'agent.output' && e.event.slug === target) {
          onLine(e.event.line, e.event.stream);
        }
      });
    },
    async pass(target, from, to, note) {
      const result = await passTask(target, { from, to, note, commitPending: true }, root);
      if (!result) throw new Error(`could not write a handoff for '${target}'`);
      const updated = await getTask(root, target);
      if (updated?.worktreePath) {
        try {
          const brief = readFileSync(join(updated.worktreePath, 'HANDOFF.md'), 'utf8');
          ignoreLines.push(...brief.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
        } catch {
          // The brief is optional for the supervisor; passTask already succeeded.
        }
      }
    },
    reassign: (target, from, to) => reassignTask(root, target, from, to),
    block: (target, reason) => blockTaskBySlug(root, target, reason),
    publish: (event) => bus.publish(event),
    log: (line) => console.log(line),
  };

  try {
    const result = await runFailover({ slug, agents, maxAttempts: opts.max, patterns, ignore: ignoreLines }, deps);
    if (result.outcome !== 'finished') process.exitCode = 1;
  } finally {
    stopPrinting();
  }
}
