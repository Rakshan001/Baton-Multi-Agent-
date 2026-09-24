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
import { AGENTS, agentsFor, type AgentDef } from './agents/registry.js';
import type { AncestryHit } from './identity.js';

export type { AncestryHit } from './identity.js';

/** A detect pattern. `project` = from a repo's `.baton/agents.json` — the lower
 *  classification tier (see classify). */
interface Pattern { id: string; re: RegExp; project?: true }

const toPatterns = (defs: AgentDef[], host = false): Pattern[] =>
  defs.flatMap((a) => [
    { id: a.id, re: a.detect, ...(a.fromProject ? { project: true as const } : {}) },
    ...(host && a.hostDetect ? [{ id: a.id, re: a.hostDetect }] : []),
  ]);

/** Agent CLIs we recognise (from the registry), matched against process command lines. */
const AGENT_PATTERNS: Pattern[] = toPatterns(Object.values(AGENTS));

/** The per-root pattern list — global patterns plus any agents the project's
 *  own `.baton/agents.json` teaches. Accepts several roots because a hub scans
 *  its sub-projects' checkouts too, and each sub-project may teach its own
 *  agents; the union is deduped by id, first root wins. Cheap: the underlying
 *  load is stat-cached. `host` adds IDE host patterns — ancestry only. */
function patternsFor(root?: string | string[], host = false): Pattern[] {
  const roots = root === undefined ? [] : Array.isArray(root) ? root : [root];
  if (!roots.length) return host ? toPatterns(Object.values(AGENTS), true) : AGENT_PATTERNS;
  const seen = new Map<string, AgentDef>();
  for (const r of roots) {
    for (const a of Object.values(agentsFor(r))) if (!seen.has(a.id)) seen.set(a.id, a);
  }
  return toPatterns([...seen.values()], host);
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

/** Leftmost match of `patterns` in `cmd`, ties → table order. */
function leftmost(cmd: string, patterns: Pattern[]): string | null {
  let best: { id: string; at: number } | null = null;
  for (const { id, re } of patterns) {
    const at = re.exec(cmd)?.index;
    if (at !== undefined && (!best || at < best.at)) best = { id, at };
  }
  return best?.id ?? null;
}

/** [built-in, project] tiers per pattern list — split once, not per scanned line. */
const tierCache = new WeakMap<Pattern[], [Pattern[], Pattern[]]>();

/**
 * Which agent a command line is. Two tiers: the leftmost built-in (and
 * ~/.baton) match first; only if none matches, the leftmost project pattern —
 * so a repo's loose `acme` pattern can never rename `…/acme-dev/…/claude`.
 */
export function classify(command: string, patterns: Pattern[] = AGENT_PATTERNS): string | null {
  let t = tierCache.get(patterns);
  if (!t) tierCache.set(patterns, (t = [patterns.filter((p) => !p.project), patterns.filter((p) => p.project)]));
  return leftmost(command, t[0]) ?? leftmost(command, t[1]);
}

/**
 * An IDE extension-host's title ends in the WORKSPACE it has open
 * (`Code Helper (Plugin): extension-host (user) codex [1-1]`), so a workspace
 * named after an agent would strict-match that agent. Drop the tail for every
 * `* Helper (Plugin):` title — VS Code, Cursor, Windsurf and other forks.
 */
function stripHostTitle(command: string): string {
  return command.replace(/^(.+? Helper \(Plugin\): extension-host)\b.*$/s, '$1');
}

/**
 * The lenient fallback: an id that equals the executable's basename (extension
 * stripped) or the first `.app` bundle name — nothing else. Matching any path
 * segment read `bash ~/src/cursor/run.sh` as Cursor.
 */
export function lenientAgent(command: string, ids: string[]): string | null {
  const argv0 = command.trim().split(/\s+/)[0] ?? '';
  const names = [argv0.split(/[/\\]/).pop()!.replace(/\.[^.]+$/, ''), /([^/]+)\.app\//.exec(command)?.[1]]
    .filter((n): n is string => !!n)
    .map((n) => n.toLowerCase());
  return ids.find((id) => names.includes(id.toLowerCase())) ?? null;
}

export interface Ancestor { pid: number; command: string }

const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh']);

/**
 * A `zsh -c '…'` wrapper (how an agent's Bash tool runs a command). Its text is
 * the agent's OWN command, so `baton review approve x && echo codex` would
 * strict-match codex. Only the flags before the first operand count, so an
 * interactive shell (`-zsh`, `/bin/zsh script`) is not one.
 */
function isShellWrapper(command: string): boolean {
  const [argv0 = '', ...rest] = command.trim().split(/\s+/);
  if (!SHELLS.has(argv0.split('/').pop()!.replace(/^-/, ''))) return false;
  const end = rest.findIndex((a) => !a.startsWith('-'));
  return rest.slice(0, end < 0 ? rest.length : end).some((f) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(f));
}

/** Nearest agent in an ancestor chain (nearest first): per ancestor, a strict
 *  match (agent or IDE host pattern), else a lenient one, else move up. A
 *  `shell -c` wrapper is never classified. */
export function nearestAgent(chain: Ancestor[], root?: string): AncestryHit | null {
  const patterns = patternsFor(root, true);
  const ids = [...new Set(patterns.map((p) => p.id))];
  for (const { pid, command } of chain) {
    if (isShellWrapper(command)) continue;
    const cmd = stripHostTitle(command);
    const strict = classify(cmd, patterns);
    if (strict) return { agent: strict, strict: true, pid };
    const loose = lenientAgent(cmd, ids);
    if (loose) return { agent: loose, strict: false, pid };
  }
  return null;
}

/** The agent id for an ancestor command chain (nearest first). */
export function firstAgentIn(commands: string[], root?: string): string | null {
  return nearestAgent(commands.map((command, pid) => ({ pid, command })), root)?.agent ?? null;
}

/* ------------------- ps: one place, one flag (I12) ------------------- */

let psMissing = false;
/** True once `ps` proved absent on this OS (win32, or ENOENT). Never set by a timeout. */
export function agentDetectionUnavailable(): boolean {
  return psMissing;
}

async function runPs(args: string[], timeoutMs?: number, cancelSignal?: AbortSignal): Promise<string | null> {
  if (process.platform === 'win32') { psMissing = true; return null; }
  try {
    return (await execa('ps', args, { ...(timeoutMs ? { timeout: timeoutMs } : {}), ...(cancelSignal ? { cancelSignal } : {}) })).stdout;
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') psMissing = true;
    return null;
  }
}

/** Rows of `ps -axo pid=,ppid=,command=` output. */
function parsePsRows(stdout: string | null): Array<{ pid: number; ppid: number; command: string }> {
  const out: Array<{ pid: number; ppid: number; command: string }> = [];
  for (const line of stdout?.split('\n') ?? []) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return out;
}

/** stdout of `ps -axo pid=,ppid=,command=`, or null when it could not be read.
 *  An aborted `signal` kills the `ps` child. */
export type PsRunner = (signal?: AbortSignal) => Promise<string | null>;
const psTable: PsRunner = (signal) => runPs(['-axo', 'pid=,ppid=,command='], 1000, signal);
const MAX_WALK_ATTEMPTS = 3;

/**
 * This process's ancestors, nearest first, from ONE `ps` call walked in memory.
 * A successful walk is memoized (ancestry cannot change); a failure or timeout
 * is not — the next call retries, at most MAX_WALK_ATTEMPTS times per process.
 * Concurrent callers share the in-flight walk.
 */
export function ancestryWalker(run: PsRunner = psTable, ppid = process.ppid, maxDepth = 6): (signal?: AbortSignal) => Promise<Ancestor[]> {
  let memo: Promise<Ancestor[]> | undefined;
  let failures = 0;
  return (signal) => {
    if (memo) return memo;
    if (failures >= MAX_WALK_ATTEMPTS) return Promise.resolve([]);
    memo = run(signal).then((out) => {
      if (out == null) throw new Error('ps unavailable');
      const byPid = new Map(parsePsRows(out).map((r) => [r.pid, r]));
      const chain: Ancestor[] = [];
      const seen = new Set<number>();
      for (let pid = ppid; chain.length < maxDepth && pid > 1 && !seen.has(pid); ) {
        const row = byPid.get(pid);
        if (!row) break;
        seen.add(pid);
        chain.push({ pid, command: row.command });
        pid = row.ppid;
      }
      return chain;
    }).catch(() => {
      failures++;
      memo = undefined;
      return [];
    });
    return memo;
  };
}

let ownAncestry = ancestryWalker();

/** Test-only: forget the ps-missing flag and this process's memoized walk
 *  (optionally walking with an injected ps runner). */
export function resetAgentDetectionForTests(run?: PsRunner): void {
  psMissing = false;
  ownAncestry = ancestryWalker(run);
}

/**
 * The agent that spawned this process — `baton mcp` runs as a child of the
 * agent session it serves, so walking parent pids identifies the agent with
 * zero configuration. Null when the chain holds no known agent (fail open).
 * `root` lets the project's own `.baton/agents.json` agents claim the session.
 * `pid` is the matched ancestor — the session's host, shared by its MCP server
 * and its edit hook.
 *
 * `retry` awaits a failed walk's retries inline (up to the walker's cap) — for
 * a caller that resolves once, like a CLI command, where a single slow `ps`
 * would otherwise mean `unknown`. A memoized empty walk just repeats, free.
 * `signal` kills a pending `ps` (the guard's budget).
 */
export async function detectAncestry(
  root?: string,
  chain: (signal?: AbortSignal) => Promise<Ancestor[]> = ownAncestry,
  opts: { retry?: boolean; signal?: AbortSignal } = {},
): Promise<AncestryHit | null> {
  let ancestors = await chain(opts.signal);
  for (let i = 1; opts.retry && !ancestors.length && i < MAX_WALK_ATTEMPTS && !opts.signal?.aborted; i++) {
    ancestors = await chain(opts.signal);
  }
  return nearestAgent(ancestors, root);
}

async function listProcesses(): Promise<Array<{ pid: number; command: string }>> {
  // `ps -axo pid=,command=` works on macOS and Linux; '=' suppresses headers.
  const stdout = await runPs(['-axo', 'pid=,command=']);
  const out: Array<{ pid: number; command: string }> = [];
  for (const line of stdout?.split('\n') ?? []) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (m) out.push({ pid: parseInt(m[1], 10), command: m[2] });
  }
  return out;
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
  return parsePsRows(await runPs(['-axo', 'pid=,ppid=,command=']));
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
