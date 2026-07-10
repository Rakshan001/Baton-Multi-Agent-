/**
 * Graph-freshness golden rule (G1). The knowledge graph rebuilds on COMMIT
 * (graphify's post-commit hook), so between an edit and its commit the graph
 * describes old code — the exact window where a second agent, trusting a stale
 * symbol, re-creates a function that already exists. These helpers classify
 * how far the graph lags reality and render the honest warning that every
 * graph consumer (orient brief, graph query proxy) attaches. Cheap dirty-file
 * flags, never a rebuild-per-keystroke.
 */
import { gitTry } from '../util/exec.js';
import { readStats } from './graphify.js';

export interface GraphFreshness {
  builtAtCommit: string | null;
  /** Commits HEAD has moved past the graph's build commit. */
  behind: number;
  /** Indexable files with uncommitted edits — invisible to the graph. */
  dirtyPaths: string[];
  status: 'fresh' | 'behind' | 'dirty' | 'unknown';
}

/** Mirrors graphify's CODE_EXTENSIONS for the common cases — only these can drift the graph. */
const CODE_EXT = new Set([
  '.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.go', '.rs', '.java', '.groovy', '.gradle',
  '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp', '.rb', '.swift', '.kt', '.kts', '.cs', '.scala',
  '.php', '.lua', '.zig', '.ex', '.exs', '.m', '.mm', '.jl', '.vue', '.svelte', '.astro',
  '.dart', '.sql', '.sh', '.bash', '.json',
]);
const IGNORED_PREFIXES = ['node_modules/', 'dist/', 'build/', 'graphify-out/', '.baton/', '.git/', 'kb/'];

/** Would the graph index this repo-relative path? Pure → unit-tested. */
export function isIndexablePath(path: string): boolean {
  if (IGNORED_PREFIXES.some((p) => path === p.slice(0, -1) || path.startsWith(p) || path.includes('/' + p))) return false;
  const dot = path.lastIndexOf('.');
  return dot !== -1 && CODE_EXT.has(path.slice(dot));
}

/** Pure classification: dirty (sharpest) > behind > fresh; unknown when the graph has no commit anchor. */
export function classifyGraphFreshness(input: {
  builtAtCommit: string | null;
  head: string | null;
  behind: number;
  dirtyPaths: string[];
}): GraphFreshness {
  const { builtAtCommit, head, behind, dirtyPaths } = input;
  let status: GraphFreshness['status'];
  if (!builtAtCommit || !head) status = 'unknown';
  else if (dirtyPaths.length > 0) status = 'dirty';
  else if (behind > 0) status = 'behind';
  else status = 'fresh';
  return { builtAtCommit, behind, dirtyPaths, status };
}

const NOTE_MAX_FILES = 6;

/** The warning a graph consumer attaches. '' when there is nothing to warn about. */
export function renderGraphFreshnessNote(f: GraphFreshness): string {
  if (f.status === 'fresh' || f.status === 'unknown') return '';
  const sha = (f.builtAtCommit ?? '').slice(0, 7);
  if (f.status === 'dirty') {
    const shown = f.dirtyPaths.slice(0, NOTE_MAX_FILES);
    const extra = f.dirtyPaths.length - shown.length;
    return (
      `⚠ Graph freshness: built at commit ${sha}; ${f.dirtyPaths.length} file(s) have uncommitted edits the graph cannot see — ` +
      `re-read these files instead of trusting graph symbols for them: ${shown.join(', ')}${extra > 0 ? ` (+${extra} more)` : ''}`
    );
  }
  return `⚠ Graph freshness: ${f.behind} commit(s) behind HEAD (built at ${sha}) — recent symbols may be missing; it rebuilds on the next commit, or run \`baton kb rebuild\`.`;
}

/**
 * Append the note as an extra text block to a proxied JSON-RPC tools/call
 * result. Anything it doesn't fully understand (SSE, invalid JSON, error
 * responses, no content array) passes through byte-for-byte — a freshness
 * hint must never corrupt a graph answer.
 */
export function injectFreshnessNote(body: string, contentType: string | null, note: string): string {
  if (!note) return body;
  if (!contentType || !contentType.includes('application/json')) return body;
  try {
    const parsed = JSON.parse(body) as { result?: { content?: unknown } };
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.result?.content)) return body;
    parsed.result.content.push({ type: 'text', text: note });
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

/**
 * W2 — branch divergence. The graph is built from the MAIN checkout's commit,
 * so a session in a worktree on another branch is reading answers about code
 * it doesn't have. Render the honest warning naming the differing files.
 */
export function renderBranchDivergenceNote(files: string[], builtAtCommit: string): string {
  if (files.length === 0) return '';
  const sha = builtAtCommit.slice(0, 7);
  const shown = files.slice(0, NOTE_MAX_FILES);
  const extra = files.length - shown.length;
  return (
    `⚠ Graph freshness: the graph was built at ${sha}, but this session's branch differs from it in ` +
    `${files.length} file(s) — the graph describes code this branch does not have. ` +
    `Re-read these files instead of trusting graph symbols for them: ${shown.join(', ')}${extra > 0 ? ` (+${extra} more)` : ''}`
  );
}

/**
 * Indexable files that differ between the graph's build commit and a
 * worktree's HEAD. Direct two-commit diff (no ancestry assumption — works for
 * branches that fork before or after the build point). Fail-safe: any git
 * error (unknown commit, not a repo) returns [] — a warning must never break
 * orientation.
 */
export async function worktreeGraphDivergence(worktreeCwd: string, builtAtCommit: string): Promise<string[]> {
  const r = await gitTry(['diff', '--name-only', builtAtCommit, 'HEAD'], worktreeCwd);
  if (!r.ok) return [];
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter(isIndexablePath)
    .sort();
}

/* ------------------------------- IO wrapper ------------------------------ */

// Graph queries can arrive in bursts (an agent chains several); the git calls
// are cheap but not free. A short cache keeps this off the hot path.
const FRESHNESS_TTL_MS = 5_000;
const cache = new Map<string, { at: number; value: GraphFreshness }>();

/** Test-only: drop the cache between test cases. */
export function resetGraphFreshnessCache(): void {
  cache.clear();
}

/** Uncommitted-edit paths (tracked diff + untracked), filtered to indexable code. */
async function dirtyIndexablePaths(projectPath: string): Promise<string[]> {
  const [diff, untracked] = await Promise.all([
    gitTry(['diff', '--name-only', 'HEAD'], projectPath),
    gitTry(['ls-files', '--others', '--exclude-standard'], projectPath),
  ]);
  if (!diff.ok) return [];
  const all = new Set<string>();
  for (const line of diff.stdout.split('\n')) if (line.trim()) all.add(line.trim());
  if (untracked.ok) for (const line of untracked.stdout.split('\n')) if (line.trim()) all.add(line.trim());
  return [...all].filter(isIndexablePath).sort();
}

/** How fresh is this project's graph relative to its working tree right now? */
export async function graphFreshness(projectPath: string, graphPath: string): Promise<GraphFreshness> {
  const key = `${projectPath}\n${graphPath}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < FRESHNESS_TTL_MS) return hit.value;

  const stats = await readStats(graphPath);
  const builtAtCommit = stats?.builtAtCommit ?? null;
  const headR = await gitTry(['rev-parse', 'HEAD'], projectPath);
  const head = headR.ok ? headR.stdout.trim() : null;
  let behind = 0;
  if (builtAtCommit && head && head !== builtAtCommit) {
    const count = await gitTry(['rev-list', '--count', `${builtAtCommit}..HEAD`], projectPath);
    behind = count.ok ? Number(count.stdout.trim()) || 0 : 1; // unknown ancestry → still "moved"
  }
  const dirtyPaths = builtAtCommit && head ? await dirtyIndexablePaths(projectPath) : [];
  const value = classifyGraphFreshness({ builtAtCommit, head, behind, dirtyPaths });
  cache.set(key, { at: Date.now(), value });
  return value;
}
