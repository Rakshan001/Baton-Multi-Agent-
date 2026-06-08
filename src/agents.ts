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

/** Agent CLIs we recognise, matched against process command lines. */
const AGENT_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: 'claude', re: /(^|\/|\s)claude(\s|$)/ },
  { id: 'codex', re: /(^|\/|\s)codex(\s|$)/ },
  { id: 'cursor', re: /cursor-agent/ },
  { id: 'gemini', re: /(^|\/|\s)gemini(\s|$)/ },
  { id: 'aider', re: /(^|\/|\s)aider(\s|$)/ },
  { id: 'opencode', re: /(^|\/|\s)opencode(\s|$)/ },
];

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
export async function detectAgents(worktreePaths: string[]): Promise<Map<string, string>> {
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
