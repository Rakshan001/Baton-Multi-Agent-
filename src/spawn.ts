/**
 * Headless agent launch: start an agent CLI in a task's worktree with a
 * prompt (the HANDOFF.md brief when one exists), stream its output onto the
 * event bus, stop it on demand. This is "control agents from the UI and the
 * terminal" without PTYs — one-shot print modes only.
 *
 * Invocation concept adapted from Rover (Apache-2.0) — agent CLIs wrapped and
 * invoked with a prompt programmatically. No code vendored; see NOTICE.
 *
 * Safety: agents run with the user's own CLI auth and DEFAULT permission
 * settings — Baton never adds permission-bypass flags.
 */
import { execa, type ResultPromise } from 'execa';
import { gitRoot } from './git.js';
import { getTask } from './store.js';
import { readBrief } from './handoff/brief.js';
import { memoryBriefSection, recallMemories } from './memory.js';
import { tmuxSessionExists } from './util/tmux.js';
import { bus } from './events.js';
import { AGENTS, type HeadlessLauncher } from './agents/registry.js';

export type Launcher = HeadlessLauncher;

/** Agents with a non-interactive print/exec mode (from the registry). Others need a real terminal. */
export const LAUNCHERS: Record<string, Launcher> = Object.fromEntries(
  Object.values(AGENTS).flatMap((a) => (a.headless ? [[a.id, a.headless] as const] : [])),
);

export const HEADLESS_AGENTS = Object.keys(LAUNCHERS);

export class AgentRunningError extends Error {
  constructor(slug: string, agent: string) {
    super(`a headless ${agent} run is already active for '${slug}'`);
    this.name = 'AgentRunningError';
  }
}

export class TerminalConflictError extends Error {
  constructor(slug: string) {
    super(`an interactive terminal is already open for '${slug}' — close it (dashboard or \`tmux kill-session\`) before starting a headless run`);
    this.name = 'TerminalConflictError';
  }
}

interface RunningAgent {
  agent: string;
  model?: string;
  child: ResultPromise;
  startedAt: string;
  lines: string[]; // ring buffer (last 500) for late joiners
}

const running = new Map<string, RunningAgent>();

/** Is a headless run active for this slug? (terminals.ts uses this to refuse a second agent.) */
export function hasHeadlessRun(slug: string): boolean {
  return running.has(slug);
}

const LINE_CAP = 500;

function pushLines(slug: string, run: RunningAgent, chunk: string, stream: 'out' | 'err'): void {
  for (const raw of chunk.split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    run.lines.push(line);
    if (run.lines.length > LINE_CAP) run.lines.shift();
    bus.publish({ type: 'agent.output', slug, line: line.slice(0, 500), stream });
  }
}

export interface StartResult {
  slug: string;
  agent: string;
  model?: string;
  pid: number | undefined;
  promptSource: 'handoff' | 'task';
}

export async function startAgent(
  slug: string,
  opts: { agent?: string; model?: string; prompt?: string } = {},
  root?: string,
): Promise<StartResult> {
  const repoRoot = root ?? (await gitRoot());
  const task = await getTask(repoRoot, slug);
  if (!task) throw new Error(`No task '${slug}'`);
  const agent = opts.agent ?? 'claude';
  const launcher = LAUNCHERS[agent];
  if (!launcher) {
    throw new Error(`'${agent}' has no headless mode baton can drive — supported: ${HEADLESS_AGENTS.join(', ')}. Start it manually in ${task.worktreePath}`);
  }
  if (running.has(slug)) throw new AgentRunningError(slug, running.get(slug)!.agent);
  // Cross-PROCESS exclusion: the in-memory map only sees this process, but an
  // interactive terminal may be owned by the daemon (or survive it). The tmux
  // session name is deterministic, so tmux itself is the shared lock.
  if (await tmuxSessionExists(repoRoot, slug)) throw new TerminalConflictError(slug);

  // Prompt: prefer a HANDOFF.md brief (the curated knowledge pack), else the
  // task plus recalled project memory — a few hundred tokens of verified facts
  // beats the agent re-exploring the repo.
  let prompt = opts.prompt;
  let promptSource: StartResult['promptSource'] = 'task';
  if (!prompt) {
    const brief = await readBrief(task.worktreePath);
    if (brief && brief.meta.status !== 'done') {
      prompt = brief.body;
      promptSource = 'handoff';
    } else {
      let memory = '';
      try {
        const recalled = await recallMemories(repoRoot, { topic: task.task, limit: 6 });
        const section = memoryBriefSection(recalled.facts, recalled.staleDropped, recalled.staleGrounding);
        if (section) memory = `\n\n${section}`;
      } catch { /* memory is an enhancement — never block a launch */ }
      const scope = task.scope?.length
        ? `\n\nYour scope: ${task.scope.join(', ')}. Stay within it; if you must touch files outside it, check_files first — another agent may own that area.`
        : '';
      prompt = `${task.task}\n\nRead CODEBASE.md first for orientation. Work only inside this directory; commit when done.${scope}${memory}`;
    }
  }

  const child = execa(launcher.cmd, launcher.args(prompt, opts.model), {
    cwd: task.worktreePath,
    buffer: false,
    stdin: 'ignore',
    // Identity: the agent's `baton mcp` reads these to resolve the hub store
    // (BATON_ROOT) and to recognize its own edits (BATON_SLUG), instead of
    // guessing from a worktree cwd.
    env: { ...process.env, FORCE_COLOR: '0', BATON_ROOT: repoRoot, BATON_SLUG: slug, BATON_TASK: task.task },
  });
  const run: RunningAgent = { agent, model: opts.model, child, startedAt: new Date().toISOString(), lines: [] };
  running.set(slug, run);

  child.stdout?.on('data', (d: Buffer) => pushLines(slug, run, d.toString(), 'out'));
  child.stderr?.on('data', (d: Buffer) => pushLines(slug, run, d.toString(), 'err'));
  bus.publish({ type: 'agent.started', slug, agent });

  void child
    .then(() => {
      bus.publish({ type: 'agent.output', slug, line: `✓ ${agent} finished`, stream: 'out' });
    })
    .catch((e: { exitCode?: number; isTerminated?: boolean; message?: string }) => {
      const why = e.isTerminated ? 'stopped' : `exited ${e.exitCode ?? '?'}`;
      bus.publish({ type: 'agent.output', slug, line: `✗ ${agent} ${why}`, stream: 'err' });
    })
    .finally(() => {
      running.delete(slug);
      bus.publish({ type: 'agent.stopped', slug, agent });
    });

  return { slug, agent, model: opts.model, pid: child.pid, promptSource };
}

export function stopAgent(slug: string): boolean {
  const run = running.get(slug);
  if (!run) return false;
  run.child.kill('SIGTERM');
  const killTimer = setTimeout(() => run.child.kill('SIGKILL'), 5000);
  void run.child.catch(() => undefined).finally(() => clearTimeout(killTimer));
  return true;
}

export interface RunningInfo {
  slug: string;
  agent: string;
  model?: string;
  startedAt: string;
  recentLines: string[];
}

export function runningHeadless(): RunningInfo[] {
  return [...running.entries()].map(([slug, r]) => ({
    slug,
    agent: r.agent,
    model: r.model,
    startedAt: r.startedAt,
    recentLines: r.lines.slice(-50),
  }));
}

/** Wait for a run to finish (CLI streaming mode). Resolves when the agent exits. */
export async function waitForAgent(slug: string): Promise<void> {
  const run = running.get(slug);
  if (!run) return;
  await run.child.catch(() => undefined);
}
