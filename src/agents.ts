// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
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
import { AGENTS, agentsFor } from './agents/registry.js';

/** Agent CLIs we recognise (from the registry), matched against process command lines. */
const AGENT_PATTERNS: Array<{ id: string; re: RegExp }> = Object.values(AGENTS).map((a) => ({
  id: a.id,
  re: a.detect,
}));

/** The per-root pattern list — global patterns plus any agents the project's
 *  own `.baton/agents.json` teaches. Accepts several roots because a hub scans
 *  its sub-projects' checkouts too, and each sub-project may teach its own
 *  agents; the union is deduped by id, first root wins. Cheap: the underlying
 *  load is stat-cached. */
function patternsFor(root?: string | string[]): Array<{ id: string; re: RegExp }> {
  const roots = root === undefined ? [] : Array.isArray(root) ? root : [root];
  if (!roots.length) return AGENT_PATTERNS;
  const seen = new Map<string, RegExp>();
  for (const r of roots) {
    for (const a of Object.values(agentsFor(r))) if (!seen.has(a.id)) seen.set(a.id, a.detect);
  }
  return [...seen.entries()].map(([id, re]) => ({ id, re }));
}

/** Cache-key fragment for a root or root set — NUL-joined, no path collisions. */
function rootKey(root?: string | string[]): string {
  return root === undefined ? '' : Array.isArray(root) ? root.join('\x00') : root;
}

/**
 * Which roots' `.baton/agents.json` must be read to recognise the agents
 * working in `tasks`.
 *
 * In a hub, a task's worktree belongs to its OWN repo (`task.repoRoot`), and
 * that repo's file is what teaches Baton the CLI its team uses. Detecting with
 * the served root alone left a sub-project's custom agent unclassified in its
 * own worktree — the board drew the row idle while an agent was plainly
 * working in it, which is the one thing the board exists to get right.
 *
 * The served root stays FIRST: `patternsFor` dedupes by id, first root wins,
 * so a hub-level definition still overrides a sub-project's. A single repo
 * yields `[root]`, whose cache key is byte-identical to the old scalar form —
 * no cache split, no extra scans.
 */
export function detectionRoots(root: string, tasks: Array<{ repoRoot?: string }>): string[] {
  const roots = [root];
  for (const t of tasks) if (t.repoRoot && !roots.includes(t.repoRoot)) roots.push(t.repoRoot);
  return roots;
}

/** True if `cwd` is the worktree path or nested inside it. Pure → unit-tested. */
export function matchAgentToWorktree(cwd: string, worktreePath: string): boolean {
  if (cwd === worktreePath) return true;
  return cwd.startsWith(worktreePath + sep);
}

function classify(command: string, patterns: Array<{ id: string; re: RegExp }> = AGENT_PATTERNS): string | null {
  for (const { id, re } of patterns) {
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
export function firstAgentIn(commands: string[], root?: string): string | null {
  const patterns = patternsFor(root);
  for (const cmd of commands) {
    const strict = classify(cmd, patterns);
    if (strict) return strict;
  }
  for (const cmd of commands) {
    for (const { id } of patterns) {
      if (id && new RegExp(`(^|[/\\\\\\s])${id}`, 'i').test(cmd)) return id;
    }
  }
  return null;
}

/**
 * The agent that spawned this process — `baton mcp` runs as a child of the
 * agent session it serves, so walking parent pids identifies the agent with
 * zero configuration. Null when the chain holds no known agent (fail open).
 * `root` lets the project's own `.baton/agents.json` agents claim the session
 * too — without it a project-defined CLI registers with a null identity.
 */
export async function detectParentAgent(maxDepth = 6, root?: string): Promise<string | null> {
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
  return firstAgentIn(chain, root);
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
async function scanAgents(worktreePaths: string[], patterns = AGENT_PATTERNS): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (worktreePaths.length === 0) return result;

  const procs = (await listProcesses()).filter((p) => p.pid !== process.pid);
  const candidates = procs
    .map((p) => ({ ...p, agent: classify(p.command, patterns) }))
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
// /api/signals concurrently — up to 12×/s measured. One shared cache collapses
// those bursts. 5s (not the poller's 2s): a TTL equal to the poll interval
// expires on every tick, so the ps+lsof sweep still ran at full poll rate;
// agent attach/detach appearing ≤5s late is invisible in practice.
const DETECT_TTL_MS = 5000;
let detectCache: { key: string; at: number; result: Map<string, string> } | null = null;

/** Test-only: drop the cache between test cases. */
export function resetDetectAgentsCache(): void {
  detectCache = null;
}

export async function detectAgents(
  worktreePaths: string[],
  opts: { now?: () => number; scan?: (paths: string[]) => Promise<Map<string, string>>; root?: string | string[] } = {},
): Promise<Map<string, string>> {
  if (worktreePaths.length === 0) return new Map();
  const now = opts.now ?? Date.now;
  // `root` widens the patterns with the project's own `.baton/agents.json`.
  // It joins the cache key: same paths under a different root (or none) must
  // not reuse a scan taken with different patterns.
  const scan = opts.scan ?? ((paths: string[]) => scanAgents(paths, patternsFor(opts.root)));
  const key = `${rootKey(opts.root)}|${[...worktreePaths].sort().join('\n')}`;
  const t = now();
  if (detectCache && detectCache.key === key && t - detectCache.at < DETECT_TTL_MS) {
    return new Map(detectCache.result);
  }
  const result = await scan(worktreePaths);
  detectCache = { key, at: t, result: new Map(result) };
  return new Map(result);
}

export interface RootAgentSession {
  pid: number;
  ppid: number;
  agent: string;
  cwd: string;
}

/** ps with ppid, so we can collapse a launcher/worker pair into one session. */
async function listProcessesWithPpid(): Promise<Array<{ pid: number; ppid: number; command: string }>> {
  try {
    const { stdout } = await execa('ps', ['-axo', 'pid=,ppid=,command=']);
    const out: Array<{ pid: number; ppid: number; command: string }> = [];
    for (const line of stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (m) out.push({ pid: parseInt(m[1], 10), ppid: parseInt(m[2], 10), command: m[3] });
    }
    return out;
  } catch {
    return [];
  }
}

/** Every agent-matching process, with cwd resolved — the raw material for root-level (non-task) visibility. */
async function scanAllAgentProcesses(patterns = AGENT_PATTERNS): Promise<RootAgentSession[]> {
  const procs = (await listProcessesWithPpid()).filter((p) => p.pid !== process.pid);
  const candidates = procs
    .map((p) => ({ ...p, agent: classify(p.command, patterns) }))
    .filter((p): p is { pid: number; ppid: number; command: string; agent: string } => p.agent !== null);
  const resolved = await Promise.all(
    candidates.map(async (c): Promise<RootAgentSession | null> => {
      const cwd = await pidCwd(c.pid);
      return cwd ? { pid: c.pid, ppid: c.ppid, agent: c.agent, cwd } : null;
    }),
  );
  return resolved.filter((r): r is RootAgentSession => r !== null);
}

// Same ps+lsof sweep as detectAgents, same 5s reasoning (see DETECT_TTL_MS).
const ROOT_SCAN_TTL_MS = 5000;
let rootScanCache: { key: string; at: number; result: RootAgentSession[] } | null = null;

/** Test-only: drop the root-agent scan cache between test cases. */
export function resetDetectRootAgentsCache(): void {
  rootScanCache = null;
}

/**
 * Agent CLI sessions running at a hub/repo root or a kb sub-project — the
 * root-terminal case `detectAgents` (task-worktree-scoped, one agent per
 * path) cannot see. Unlike detectAgents, this returns EVERY matching
 * process — several sessions of the same agent commonly share one cwd.
 */
export async function detectRootAgents(
  includePaths: string[],
  excludePaths: string[] = [],
  opts: { now?: () => number; scan?: () => Promise<RootAgentSession[]>; root?: string | string[] } = {},
): Promise<RootAgentSession[]> {
  if (includePaths.length === 0) return [];
  const now = opts.now ?? Date.now;
  const scan = opts.scan ?? (() => scanAllAgentProcesses(patternsFor(opts.root)));
  const key = `${rootKey(opts.root)}|${[...includePaths].sort().join('\n')}|${[...excludePaths].sort().join('\n')}`;
  const t = now();
  if (rootScanCache && rootScanCache.key === key && t - rootScanCache.at < ROOT_SCAN_TTL_MS) {
    return rootScanCache.result;
  }
  const all = await scan();
  // Collapse launcher/worker pairs: a matched process whose parent is ALSO a
  // matched agent process is the same session (e.g. a GUI host's stub + its
  // Claude Code worker), so it must not be counted twice.
  const matchedPids = new Set(all.map((p) => p.pid));
  const result = all.filter(
    (p) =>
      !matchedPids.has(p.ppid) &&
      includePaths.some((root) => matchAgentToWorktree(p.cwd, root)) &&
      !excludePaths.some((wt) => matchAgentToWorktree(p.cwd, wt)),
  );
  rootScanCache = { key, at: t, result };
  return result;
}
