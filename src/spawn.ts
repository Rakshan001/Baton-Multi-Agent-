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
import { bus } from './events.js';

export interface Launcher {
  cmd: string;
  args: (prompt: string) => string[];
}

/** Agents with a non-interactive print/exec mode. Others need a real terminal. */
export const LAUNCHERS: Record<string, Launcher> = {
  claude: { cmd: 'claude', args: (p) => ['-p', p] },
  codex: { cmd: 'codex', args: (p) => ['exec', p] },
  gemini: { cmd: 'gemini', args: (p) => ['-p', p] },
};

export const HEADLESS_AGENTS = Object.keys(LAUNCHERS);

export class AgentRunningError extends Error {
  constructor(slug: string, agent: string) {
    super(`a headless ${agent} run is already active for '${slug}'`);
    this.name = 'AgentRunningError';
  }
}

interface RunningAgent {
  agent: string;
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
  pid: number | undefined;
  promptSource: 'handoff' | 'task';
}

export async function startAgent(
  slug: string,
  opts: { agent?: string; prompt?: string } = {},
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

  // Prompt: prefer a HANDOFF.md brief (the curated knowledge pack), else the task.
  let prompt = opts.prompt;
  let promptSource: StartResult['promptSource'] = 'task';
  if (!prompt) {
    const brief = await readBrief(task.worktreePath);
    if (brief && brief.meta.status !== 'done') {
      prompt = brief.body;
      promptSource = 'handoff';
    } else {
      prompt = `${task.task}\n\nRead CODEBASE.md first for orientation. Work only inside this directory; commit when done.`;
    }
  }

  const child = execa(launcher.cmd, launcher.args(prompt), {
    cwd: task.worktreePath,
    buffer: false,
    stdin: 'ignore',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  const run: RunningAgent = { agent, child, startedAt: new Date().toISOString(), lines: [] };
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

  return { slug, agent, pid: child.pid, promptSource };
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
  startedAt: string;
  recentLines: string[];
}

export function runningHeadless(): RunningInfo[] {
  return [...running.entries()].map(([slug, r]) => ({
    slug,
    agent: r.agent,
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
