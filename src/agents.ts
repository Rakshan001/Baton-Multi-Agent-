/**
 * Detect which AI coding agents are running locally and map each to a Baton
 * worktree (by the process's working directory).
 *
 * No daemon, no locks: we just read the process table and resolve each agent
 * process's cwd. Approach adapted from handler.dev's agent-detect.ts (MIT,
 * `pgrep -af` + per-agent matching) — here using `ps` for portability and
 * adding cwd→worktree mapping for the local case. See NOTICE.
 */
import { sep } from 'node:path';
import { execa } from 'execa';
import { AGENTS } from './agents/registry.js';

/** Agent CLIs we recognise (from the registry), matched against process command lines. */
const AGENT_PATTERNS: Array<{ id: string; re: RegExp }> = Object.values(AGENTS).map((a) => ({
  id: a.id,
  re: a.detect,
}));

/** True if `cwd` is the worktree path or nested inside it. Pure → unit-tested. */
export function matchAgentToWorktree(cwd: string, worktreePath: string): boolean {
  if (cwd === worktreePath) return true;
  return cwd.startsWith(worktreePath + sep);
}

function classify(command: string): string | null {
  for (const { id, re } of AGENT_PATTERNS) {
    if (re.test(command)) return id;
  }
  return null;
}

/**
 * Which agent owns a process, given its ancestor command lines (M1). Registry
 * detect patterns first (strict, tuned for CLI process scans), then a lenient
 * id-in-path pass — IDE hosts spawn MCP servers from paths like
 * /Applications/Cursor.app/… that the strict CLI patterns don't cover. Safe to
 * be lenient here: the chain is OUR OWN ancestry, not the whole process table.
 */
export function firstAgentIn(commands: string[]): string | null {
  for (const cmd of commands) {
    const strict = classify(cmd);
    if (strict) return strict;
  }
  for (const cmd of commands) {
    for (const { id } of AGENT_PATTERNS) {
      if (id && new RegExp(`(^|[/\\\\\\s])${id}`, 'i').test(cmd)) return id;
    }
  }
  return null;
}

/**
 * The agent that spawned this process — `baton mcp` runs as a child of the
 * agent session it serves, so walking parent pids identifies the agent with
 * zero configuration. Null when the chain holds no known agent (fail open).
 */
export async function detectParentAgent(maxDepth = 6): Promise<string | null> {
  const chain: string[] = [];
  let pid = process.ppid;
  for (let i = 0; i < maxDepth && pid > 1; i++) {
    try {
      const { stdout } = await execa('ps', ['-o', 'ppid=,command=', '-p', String(pid)]);
      const m = stdout.trim().match(/^(\d+)\s+(.*)$/);
      if (!m) break;
      chain.push(m[2]);
      pid = parseInt(m[1], 10);
    } catch {
      break;
    }
  }
  return firstAgentIn(chain);
}

async function listProcesses(): Promise<Array<{ pid: number; command: string }>> {
  try {
    // `ps -axo pid=,command=` works on macOS and Linux; '=' suppresses headers.
    const { stdout } = await execa('ps', ['-axo', 'pid=,command=']);
    const out: Array<{ pid: number; command: string }> = [];
    for (const line of stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (m) out.push({ pid: parseInt(m[1], 10), command: m[2] });
    }
    return out;
  } catch {
    return [];
  }
}

async function pidCwd(pid: number): Promise<string | null> {
  try {
    if (process.platform === 'linux') {
      const { stdout } = await execa('readlink', [`/proc/${pid}/cwd`]);
      return stdout.trim() || null;
    }
    // macOS / BSD: lsof field output, the cwd line starts with 'n'.
    const { stdout } = await execa('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    const line = stdout.split('\n').find((l) => l.startsWith('n'));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}

/**
 * Return a map of worktreePath → agentId for any agent process whose cwd is
 * inside one of the given worktrees. Only resolves cwd for processes that
 * actually look like an agent (cheap), and skips our own process.
 */
async function scanAgents(worktreePaths: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (worktreePaths.length === 0) return result;

  const procs = (await listProcesses()).filter((p) => p.pid !== process.pid);
  const candidates = procs
    .map((p) => ({ ...p, agent: classify(p.command) }))
    .filter((p): p is { pid: number; command: string; agent: string } => p.agent !== null);

  await Promise.all(
    candidates.map(async (c) => {
      const cwd = await pidCwd(c.pid);
      if (!cwd) return;
      const wt = worktreePaths.find((p) => matchAgentToWorktree(cwd, p));
      if (wt && !result.has(wt)) result.set(wt, c.agent);
    }),
  );

  return result;
}

// The process-table sweep (ps + per-pid lsof) is the daemon's most expensive
// poll-path call and gets hit by the board poller, /api/status and
// /api/signals concurrently — up to 12×/s measured. One shared 2s cache
// collapses those bursts; ≤2s staleness is invisible at the board's own 2s tick.
const DETECT_TTL_MS = 2000;
let detectCache: { key: string; at: number; result: Map<string, string> } | null = null;

/** Test-only: drop the cache between test cases. */
export function resetDetectAgentsCache(): void {
  detectCache = null;
}

export async function detectAgents(
  worktreePaths: string[],
  opts: { now?: () => number; scan?: (paths: string[]) => Promise<Map<string, string>> } = {},
): Promise<Map<string, string>> {
  if (worktreePaths.length === 0) return new Map();
  const now = opts.now ?? Date.now;
  const scan = opts.scan ?? scanAgents;
  const key = [...worktreePaths].sort().join('\n');
  const t = now();
  if (detectCache && detectCache.key === key && t - detectCache.at < DETECT_TTL_MS) {
    return new Map(detectCache.result);
  }
  const result = await scan(worktreePaths);
  detectCache = { key, at: t, result: new Map(result) };
  return new Map(result);
}
