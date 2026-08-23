// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
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
import { activeBatonRoot } from './store.js';
import { getTask } from './store.js';
import { detectSecret } from './memory.js';
import { endpointLaunchInjection } from './endpoints/live-endpoints.js';
import { readBrief } from './handoff/brief.js';
import { fenceUntrusted } from './handoff/untrusted.js';
import { memoryBriefSection, recallMemories } from './memory.js';
import { tmuxSessionExists } from './util/tmux.js';
import { bus } from './events.js';
import { AGENTS, agentsFor, type HeadlessLauncher } from './agents/registry.js';

export type Launcher = HeadlessLauncher;

/** Agents with a non-interactive print/exec mode (from the registry). Others need a real terminal. */
export const LAUNCHERS: Record<string, Launcher> = Object.fromEntries(
  Object.values(AGENTS).flatMap((a) => (a.headless ? [[a.id, a.headless] as const] : [])),
);

export const HEADLESS_AGENTS = Object.keys(LAUNCHERS);

/** The per-root view: LAUNCHERS plus any headless agents the project's own
 *  `.baton/agents.json` teaches. Used wherever a root is in hand. */
export function launchersFor(root: string): Record<string, Launcher> {
  return Object.fromEntries(
    Object.values(agentsFor(root)).flatMap((a) => (a.headless ? [[a.id, a.headless] as const] : [])),
  );
}

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
  /** Trailing incomplete line per stream — see pushLines. */
  partial: { out: string; err: string };
}

const running = new Map<string, RunningAgent>();

/** Is a headless run active for this slug? (terminals.ts uses this to refuse a second agent.) */
export function hasHeadlessRun(slug: string): boolean {
  return running.has(slug);
}

const LINE_CAP = 500;

/**
 * An agent's own stdout, which is not ours and not reviewed.
 *
 * Every other durable surface redacts — memory facts, review findings, commit
 * subjects in a derived brief — because a credential that lands in a file is
 * read by every later agent. Agent output is the one that skipped it, and it is
 * the LEAST controlled text in the system: an agent echoing a .env, printing a
 * failing curl, or dumping its own environment publishes straight onto the
 * event bus, into the 500-line ring buffer, and out through
 * `GET /api/agents/running` — which any member of a `--host` daemon can read.
 */
export function redactLine(line: string): string {
  const what = detectSecret(line);
  return what ? `[redacted: ${what}]` : line;
}

/** A line held across chunks cannot grow forever — an agent may emit megabytes
 *  with no newline at all (a progress bar, a minified blob). Past this we give
 *  up on the line boundary and emit what we have. */
const PARTIAL_MAX = 8192;

/**
 * Turn stdout chunks into whole lines, then publish them.
 *
 * The buffering is not cosmetic. `data` events arrive on arbitrary byte
 * boundaries, so a single output line routinely lands in two chunks — and
 * treating each chunk as a set of lines both published half-lines as if they
 * were complete AND let a credential straddling the boundary walk straight past
 * `redactLine`, which only ever saw one half of it. Redaction that can be
 * defeated by a chunk boundary is not redaction.
 */
function pushLines(slug: string, run: RunningAgent, chunk: string, stream: 'out' | 'err'): void {
  const parts = (run.partial[stream] + chunk).split('\n');
  run.partial[stream] = parts.pop() ?? '';
  if (run.partial[stream].length > PARTIAL_MAX) {
    parts.push(run.partial[stream]);
    run.partial[stream] = '';
  }
  for (const raw of parts) emitLine(slug, run, raw, stream);
}

function emitLine(slug: string, run: RunningAgent, raw: string, stream: 'out' | 'err'): void {
  const line = redactLine(raw.trimEnd());
  if (!line) return;
  run.lines.push(line);
  if (run.lines.length > LINE_CAP) run.lines.shift();
  bus.publish({ type: 'agent.output', slug, line: line.slice(0, 500), stream });
}

/** Emit whatever never got its newline. An agent's LAST line commonly has none,
 *  and dropping it loses exactly the line that says how the run ended. */
function flushPartial(slug: string, run: RunningAgent): void {
  for (const stream of ['out', 'err'] as const) {
    const rest = run.partial[stream];
    run.partial[stream] = '';
    if (rest) emitLine(slug, run, rest, stream);
  }
}

/**
 * The prompt for a run with no brief to hand it: the task, quoted, plus what
 * Baton wants the agent to do about it.
 *
 * Pure, and exported, because the ordering here is a security property rather
 * than a formatting preference. The task text comes from a plan file that git
 * can deliver from anyone's branch, so it goes inside the fence as data;
 * everything that carries Baton's authority — the orientation pointer, the
 * isolation rule, the scope — stays outside it, after the terminator, where the
 * quoted text provably cannot have written it.
 */
export function composeTaskPrompt(taskText: string, scope: string[], memorySection: string): string {
  const scopeLine = scope.length
    ? `\n\nYour scope: ${scope.join(', ')}. Stay within it; if you must touch files outside it, check_files first — another agent may own that area.`
    : '';
  const memory = memorySection ? `\n\n${memorySection}` : '';
  return `Your task is described in the quoted block below.\n\n${fenceUntrusted('plan.task', taskText)}\n\nRead CODEBASE.md first for orientation. Work only inside this directory; commit when done.${scopeLine}${memory}`;
}

/** How a headless run ended. `code` is null when a signal ended it. */
export interface AgentExit {
  code: number | null;
  stopped: boolean;
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
  // activeBatonRoot, not gitRoot: `baton start` passes no root, and gitRoot
  // answers "the checkout I am standing in" — which throws at a hub root (not a
  // git repo at all) and returns the WORKTREE from inside one, whose .baton is
  // an empty shadow store, so the task reads as missing in the very worktree it
  // owns. Fifth instance of that shape; the other 23 commands were switched
  // already and this caller was missed.
  const repoRoot = root ?? (await activeBatonRoot());
  const task = await getTask(repoRoot, slug);
  if (!task) throw new Error(`No task '${slug}'`);
  const agent = opts.agent ?? 'claude';
  const launchers = launchersFor(repoRoot);
  const launcher = launchers[agent];
  if (!launcher) {
    throw new Error(`'${agent}' has no headless mode baton can drive — supported: ${Object.keys(launchers).join(', ')}. Start it manually in ${task.worktreePath}`);
  }
  if (running.has(slug)) throw new AgentRunningError(slug, running.get(slug)!.agent);
  // Cross-PROCESS exclusion: the in-memory map only sees this process, but an
  // interactive terminal may be owned by the daemon (or survive it). The tmux
  // session name is deterministic, so tmux itself is the shared lock.
  if (await tmuxSessionExists(repoRoot, slug)) throw new TerminalConflictError(slug);

  // Prompt: prefer a HANDOFF.md brief (the curated knowledge pack), else the
  // task plus recalled project memory — a few hundred tokens of verified facts
  // beats the agent re-exploring the repo. See composeTaskPrompt for the
  // fallback's shape and why the task text is quoted rather than interpolated.
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
      prompt = composeTaskPrompt(task.task, task.scope ?? [], memory);
    }
  }

  // P16 step 1. Per-launch only: the alternative everyone reaches for is
  // writing ~/.claude/settings.json, which re-points every Claude Code session
  // on the machine — including someone's unrelated work.
  const injected = await endpointLaunchInjection(repoRoot, agent, opts.model);
  // P27 — a gateway-mode agent whose gateway is unreachable does not launch.
  // Proceeding would send this repo to the vendor at the moment the developer
  // believed it was staying on their network.
  if (injected.refusal) throw new Error(injected.refusal);

  const child = execa(launcher.cmd, launcher.args(prompt, opts.model), {
    cwd: task.worktreePath,
    buffer: false,
    stdin: 'ignore',
    // Own process GROUP, so stopping the run can stop what the run started.
    // An agent CLI is a supervisor: it spawns npm, tsc, pytest, its own MCP
    // servers. Killing just the direct child left those running while the UI
    // reported "stopped" — a half-stopped agent still writing to the worktree
    // is worse than one that never stopped, because nobody is looking for it.
    // Windows has no process groups in this sense; see killTree.
    detached: process.platform !== 'win32',
    // Identity: the agent's `baton mcp` reads these to resolve the hub store
    // (BATON_ROOT), to recognize its own edits (BATON_SLUG), and to introduce
    // itself as the agent we actually launched (BATON_AGENT) instead of letting
    // `resolveAgentId` fall back to sniffing a parent process. That last one is
    // what `assignee` is matched against, so a guess here reads as a different
    // agent and gets refused from its own task.
    env: {
      ...process.env,
      // After process.env on purpose: the plan named a model that lives on
      // this endpoint, so an inherited ANTHROPIC_BASE_URL pointing somewhere
      // else would send it to a gateway that does not serve it.
      ...injected.env,
      FORCE_COLOR: '0',
      BATON_ROOT: repoRoot,
      BATON_SLUG: slug,
      BATON_TASK: task.task,
      BATON_AGENT: agent,
    },
  });
  const run: RunningAgent = {
    agent, model: opts.model, child, startedAt: new Date().toISOString(), lines: [], partial: { out: '', err: '' },
  };
  running.set(slug, run);
  armExitCleanup(); // detached children are ours to reap; execa no longer does it

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
      flushPartial(slug, run); // the last line often has no trailing newline
      running.delete(slug);
      bus.publish({ type: 'agent.stopped', slug, agent });
    });

  return { slug, agent, model: opts.model, pid: child.pid, promptSource };
}

/**
 * Signal the agent AND everything it spawned.
 *
 * `detached: true` above made the child a process-group leader, and a negative
 * pid addresses that whole group — so a `npm install` the agent kicked off dies
 * with it. Falls back to the direct child when the group is already gone (the
 * agent exited between the check and the signal) or on Windows, which has no
 * equivalent; there the descendants survive, which is the pre-existing
 * behaviour rather than a new gap.
 */
function killTree(run: RunningAgent, signal: NodeJS.Signals): void {
  // Never signal a GROUP for a process we have already reaped. `child.kill()`
  // no-ops once the child is gone, but `process.kill(-pid)` does not: the OS
  // may have handed that pid to somebody else, and we would be killing a
  // stranger's whole process group. `running.delete` happens a microtask after
  // exit, so this window is real, not theoretical.
  // execa 10 moved the process fields off the returned promise; the underlying
  // ChildProcess still carries them, so this reads exactly what it read before
  // (null while alive, and null too when a signal took it — unchanged either way).
  if (run.child.nodeChildProcess.exitCode !== null) return;
  const pid = run.child.pid;
  if (pid && process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch { /* no such group — the direct kill below is the honest fallback */ }
  }
  try { run.child.kill(signal); } catch { /* already gone */ }
}

/**
 * Put back the kill-on-parent-exit that `detached` takes away.
 *
 * execa only installs its own cleanup for NON-detached children
 * (`terminate/cleanup.js`: `if (!cleanup || detached) return`), and detaching
 * also setsid()s the child out of our session so a terminal hangup no longer
 * reaches it either. Without this, `baton start` killed by anything but Ctrl-C
 * — a closed terminal, a `kill`, an uncaught throw — leaves the agent and
 * everything it spawned running forever with no parent and no record.
 *
 * Signals are only claimed when nobody else has: the daemon already stops
 * agents inside its own SIGINT/SIGTERM handler, and `baton start` owns SIGINT
 * for its own message. Taking a signal that has a listener would either
 * suppress their shutdown or race it.
 */
const SIGNAL_EXIT_CODE: Record<string, number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
let cleanupArmed = false;

function armExitCleanup(): void {
  if (cleanupArmed) return;
  cleanupArmed = true;
  // 'exit' runs on normal termination and on process.exit(); sync only, which
  // is all a signal needs to be.
  process.once('exit', () => {
    for (const run of running.values()) killTree(run, 'SIGKILL');
  });
  for (const sig of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) {
    if (process.listenerCount(sig) > 0) continue; // its owner has a shutdown path
    process.once(sig, () => {
      stopAllAgents();
      process.exit(SIGNAL_EXIT_CODE[sig]);
    });
  }
}

export function stopAgent(slug: string): boolean {
  const run = running.get(slug);
  if (!run) return false;
  killTree(run, 'SIGTERM');
  const killTimer = setTimeout(() => killTree(run, 'SIGKILL'), 5000);
  void run.child.catch(() => undefined).finally(() => clearTimeout(killTimer));
  return true;
}

/**
 * Stop every run this process owns. The daemon calls this on its way out:
 * detaching the children opted them out of execa's own cleanup-on-exit, so
 * without this a `baton serve` restart would leave a fleet of agents editing
 * worktrees with nothing left that knows they exist.
 */
export function stopAllAgents(): void {
  for (const run of running.values()) killTree(run, 'SIGTERM');
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
/**
 * Wait for a headless run and report HOW it ended.
 *
 * The outcome is the return value rather than a bus message because the caller
 * that needs it — the dispatcher — has to turn it into a task state, and
 * parsing our own `✗ agent exited 1` line back out of the bus would be a second
 * encoding of the same fact.
 *
 * `null` when nothing was running under that slug: a caller must be able to
 * tell "it finished" from "it was never here".
 */
export async function waitForAgent(slug: string): Promise<AgentExit | null> {
  const run = running.get(slug);
  if (!run) return null;
  const e = await run.child.then(
    () => ({ code: 0, stopped: false }),
    (err: { exitCode?: number; isTerminated?: boolean }) => ({
      code: err.exitCode ?? null,
      stopped: err.isTerminated === true,
    }),
  );
  return e;
}
