/**
 * Thin wrapper around the external `graphify` CLI (PyPI package `graphifyy`,
 * MIT — vendored as reference under .refs/graphify, never bundled). Baton
 * shells out to it to build/update code graphs; if it isn't installed we
 * detect that and print install guidance instead of failing mid-pipeline.
 */
import { execa } from 'execa';
import { readFile, stat } from 'node:fs/promises';
import { probeBinary } from '../util/exec.js';

/** Graphify runs can chew through a big repo; give them room but never hang forever. */
const EXTRACT_TIMEOUT_MS = 15 * 60_000;
const QUICK_TIMEOUT_MS = 30_000;

export interface GraphifyDetection {
  ok: boolean;
  version?: string;
  /** Available installers, for tailored guidance when graphify is missing. */
  uv: boolean;
  pipx: boolean;
}

export async function detectGraphify(): Promise<GraphifyDetection> {
  // version string needed for the ok path; probeBinary covers the boolean installers
  try {
    const { stdout } = await execa('graphify', ['--version'], { timeout: QUICK_TIMEOUT_MS });
    return { ok: true, version: stdout.trim().replace(/^graphify\s+/, ''), uv: true, pipx: true };
  } catch {
    const [uv, pipx] = await Promise.all([probeBinary('uv'), probeBinary('pipx')]);
    return { ok: false, uv, pipx };
  }
}

export function installHint(d: GraphifyDetection): string {
  if (d.uv) return 'uv tool install graphifyy';
  if (d.pipx) return 'pipx install graphifyy';
  return 'pip install graphifyy   (or install uv first: https://docs.astral.sh/uv/)';
}

/** True when an LLM backend key is configured — semantic extraction would work. */
export function hasLlmBackend(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || env.GEMINI_API_KEY ||
    env.MOONSHOT_API_KEY || env.DEEPSEEK_API_KEY || env.OLLAMA_BASE_URL,
  );
}

export interface ExtractOptions {
  /** Skip clustering/LLM passes — pure AST extraction (no API key needed). */
  noCluster?: boolean;
  onOutput?: (line: string) => void;
}

function pipeLines(stream: NodeJS.ReadableStream | null, onLine?: (l: string) => void): void {
  if (!stream || !onLine) return;
  let buf = '';
  stream.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trimEnd();
      buf = buf.slice(idx + 1);
      if (line) onLine(line);
    }
  });
}

/** Full extraction: `graphify extract <path>`. Writes <path>/graphify-out/. */
export async function extract(path: string, opts: ExtractOptions = {}): Promise<void> {
  const args = ['extract', path];
  if (opts.noCluster) args.push('--no-cluster');
  const child = execa('graphify', args, { timeout: EXTRACT_TIMEOUT_MS });
  pipeLines(child.stdout, opts.onOutput);
  pipeLines(child.stderr, opts.onOutput);
  await child;
}

/**
 * Build (or rebuild) a project graph with whatever the environment supports.
 * `graphify extract` hard-exits when the corpus has docs/images but no LLM key
 * is configured, so without a key we use `graphify update` — pure local AST
 * over code files, and it bootstraps a fresh graph just fine.
 */
export async function buildGraph(path: string, opts: ExtractOptions = {}): Promise<void> {
  if (hasLlmBackend()) return extract(path, opts);
  return update(path, opts);
}

/** Incremental AST-only re-extract: `graphify update <path>` (no LLM needed). */
export async function update(path: string, opts: ExtractOptions = {}): Promise<void> {
  const child = execa('graphify', ['update', path], { timeout: EXTRACT_TIMEOUT_MS });
  pipeLines(child.stdout, opts.onOutput);
  pipeLines(child.stderr, opts.onOutput);
  await child;
}

/** Merge per-project graphs into one cross-project graph at `out`. */
export async function mergeGraphs(graphPaths: string[], out: string): Promise<void> {
  if (graphPaths.length < 2) throw new Error('mergeGraphs needs at least two graphs');
  await execa('graphify', ['merge-graphs', ...graphPaths, '--out', out], {
    timeout: EXTRACT_TIMEOUT_MS,
  });
}

/** Install graphify's post-commit/post-checkout hooks (worktrees share .git/hooks). */
export async function installGitHook(repoRoot: string): Promise<boolean> {
  try {
    await execa('graphify', ['hook', 'install'], { cwd: repoRoot, timeout: QUICK_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/** BFS query against a built graph — used for handoff brief graph excerpts. */
export async function queryGraph(
  question: string,
  graphPath: string,
  budget = 1500,
): Promise<string | null> {
  try {
    const { stdout } = await execa(
      'graphify',
      ['query', question, '--graph', graphPath, '--budget', String(budget)],
      { timeout: 60_000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export interface GraphStats {
  nodes: number;
  edges: number;
  communities: number;
  builtAt: string | null; // file mtime ISO
  /** Git commit the graph was built at (graphify's built_at_commit), if recorded. */
  builtAtCommit: string | null;
}

/**
 * Memoize parsed stats by (path, mtimeMs, size). The dashboard polls /api/kb,
 * and kbStatus() calls readStats() for every project on each poll — without this
 * cache a multi-MB graph.json is re-read and JSON.parse'd on every poll even
 * when nothing changed. A rebuild bumps mtime, so the cache self-invalidates.
 */
const statsCache = new Map<string, { mtimeMs: number; size: number; stats: GraphStats }>();
const STATS_CACHE_CAP = 256;

/** Cheap stats from a graph.json without holding the whole parse around.
 *  The ONE place that knows graph.json's envelope shape — extend here, not ad hoc. */
export async function readStats(graphJsonPath: string): Promise<GraphStats | null> {
  let st;
  try {
    st = await stat(graphJsonPath);
  } catch {
    statsCache.delete(graphJsonPath);
    return null;
  }
  const hit = statsCache.get(graphJsonPath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.stats;
  try {
    const raw = await readFile(graphJsonPath, 'utf-8');
    const g = JSON.parse(raw) as {
      nodes?: Array<{ community?: number }>;
      links?: unknown[];
      built_at_commit?: string;
    };
    const nodes = g.nodes ?? [];
    const communities = new Set(nodes.map((n) => n.community).filter((c) => c !== undefined));
    const stats: GraphStats = {
      nodes: nodes.length,
      edges: g.links?.length ?? 0,
      communities: communities.size,
      builtAt: st.mtime.toISOString(),
      builtAtCommit: g.built_at_commit ?? null,
    };
    // FIFO single-entry eviction (Map keeps insertion order) — bounded across
    // many sub-projects without a re-scan stampede on the next poll.
    if (statsCache.size >= STATS_CACHE_CAP) statsCache.delete(statsCache.keys().next().value!);
    statsCache.set(graphJsonPath, { mtimeMs: st.mtimeMs, size: st.size, stats });
    return stats;
  } catch {
    statsCache.delete(graphJsonPath);
    return null;
  }
}
