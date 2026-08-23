// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Browsing the knowledge graph without downloading it.
 *
 * `/api/kb/graph` streams `graphify-out/graph.json` whole. For the Orcabaton
 * repo that file is 144,502,085 bytes -- 98,266 nodes and 286,680 links, mostly
 * pretty-printing -- against an 8 MB client read cap, so the Orca panel refuses
 * it and prints the size instead. That refusal is honest but it is not
 * browsing; these two queries are.
 *
 * The cost is paid once. Parsing 144 MB per request would make an interactive
 * panel unusable, so the derived index is cached and keyed on the graph file's
 * mtime and size: a `baton kb rebuild` invalidates it without anyone having to
 * remember to.
 */
import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative } from 'node:path';

export interface NeighbourNode {
  id: string;
  label: string;
  fileType: string | null;
  sourceFile: string | null;
  sourceLocation: string | null;
}

export interface NeighbourEdge extends NeighbourNode {
  relation: string;
  /** `out`: this symbol points at it. `in`: it points at this symbol. */
  direction: 'in' | 'out';
}

export type NeighboursQuery = { node?: string; file?: string; limit?: number };

export type NeighboursRefusal =
  | 'not-built'
  | 'unknown-node'
  | 'file-not-indexed'
  | 'needs-selector';

export type NeighboursResult =
  | { ok: true; kind: 'node'; node: NeighbourNode; neighbours: NeighbourEdge[]; total: number; withheld: number }
  | { ok: true; kind: 'file'; file: string; nodes: NeighbourNode[]; total: number; withheld: number }
  | { ok: false; code: NeighboursRefusal; message: string };

export const NEIGHBOURS_DEFAULT_LIMIT = 50;
/** A neighbourhood no client should have to page through in one response.
 *  `translate` in the Orcabaton graph has 3,161 edges. */
export const NEIGHBOURS_MAX_LIMIT = 500;

interface RawNode {
  id?: unknown; label?: unknown; file_type?: unknown;
  source_file?: unknown; source_location?: unknown;
}
interface RawLink { source?: unknown; target?: unknown; relation?: unknown }

interface GraphIndex {
  key: string;
  nodes: Map<string, NeighbourNode>;
  /** Adjacency stores ids only; metadata is looked up from `nodes`, so a
   *  symbol with 3,161 edges is not 3,161 copies of its neighbours. */
  adj: Map<string, { id: string; relation: string; direction: 'in' | 'out' }[]>;
  byFile: Map<string, string[]>;
  degree: Map<string, number>;
}

let cached: GraphIndex | null = null;
let lastUsed = 0;
let evictTimer: ReturnType<typeof setTimeout> | null = null;
let builds = 0;

/** Measured on the Orcabaton graph: 328 MB peak while parsing, 94 MB retained.
 *  Worth holding while someone is browsing; not worth holding overnight. */
export const NEIGHBOURS_IDLE_EVICT_MS = 5 * 60_000;

/** Exported so the timer is not the only way to reach this -- a test should
 *  not have to wait five minutes to prove the daemon lets go. */
export function evictIdleNeighbourIndex(now = Date.now()): void {
  if (cached && now - lastUsed >= NEIGHBOURS_IDLE_EVICT_MS) {
    cached = null;
  }
}

function touch(): void {
  lastUsed = Date.now();
  if (evictTimer) clearTimeout(evictTimer);
  // unref: an idle index must never be the reason the process stays alive.
  evictTimer = setTimeout(() => evictIdleNeighbourIndex(), NEIGHBOURS_IDLE_EVICT_MS + 1_000);
  evictTimer.unref?.();
}

/** Test seam, and the honest way to prove the 144 MB parse happens once. */
export function neighbourIndexBuilds(): number {
  return builds;
}

export function clearNeighbourIndex(): void {
  cached = null;
  builds = 0;
  lastUsed = 0;
  if (evictTimer) clearTimeout(evictTimer);
  evictTimer = null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;

/** graph.json indexes repo-relative posix paths; an editor may hand us either
 *  separator, and on Windows an absolute path. */
export function normaliseGraphPath(file: string, projectPath: string): string {
  const slashed = file.replace(/\\/g, '/');
  const rooted = isAbsolute(file) || isAbsolute(slashed)
    ? relative(projectPath, file).replace(/\\/g, '/')
    : slashed;
  return rooted.replace(/^\.\//, '');
}

function buildIndex(key: string, raw: unknown): GraphIndex {
  const graph = (raw ?? {}) as { nodes?: RawNode[]; links?: RawLink[] };
  const index: GraphIndex = {
    key, nodes: new Map(), adj: new Map(), byFile: new Map(), degree: new Map(),
  };

  for (const n of graph.nodes ?? []) {
    const id = str(n.id);
    if (!id || index.nodes.has(id)) continue;
    const sourceFile = strOrNull(n.source_file);
    index.nodes.set(id, {
      id,
      label: str(n.label) || id,
      fileType: strOrNull(n.file_type),
      sourceFile,
      sourceLocation: strOrNull(n.source_location),
    });
    if (sourceFile) {
      const bucket = index.byFile.get(sourceFile);
      if (bucket) bucket.push(id);
      else index.byFile.set(sourceFile, [id]);
    }
  }

  const push = (from: string, to: string, relation: string, direction: 'in' | 'out'): void => {
    const bucket = index.adj.get(from);
    const edge = { id: to, relation, direction };
    if (bucket) bucket.push(edge);
    else index.adj.set(from, [edge]);
  };

  for (const l of graph.links ?? []) {
    const source = str(l.source);
    const target = str(l.target);
    // An edge to a symbol the graph does not describe cannot be rendered, and
    // a row with an id and no label is worse than no row.
    if (!source || !target || !index.nodes.has(source) || !index.nodes.has(target)) continue;
    const relation = str(l.relation) || 'related';
    push(source, target, relation, 'out');
    push(target, source, relation, 'in');
    index.degree.set(source, (index.degree.get(source) ?? 0) + 1);
    index.degree.set(target, (index.degree.get(target) ?? 0) + 1);
  }

  return index;
}

async function loadIndex(graphPath: string): Promise<GraphIndex | null> {
  let key: string;
  try {
    const st = await stat(graphPath);
    key = `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
  if (cached && cached.key === key) {
    touch();
    return cached;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(graphPath, 'utf-8'));
  } catch {
    return null;
  }
  builds += 1;
  cached = buildIndex(key, raw);
  touch();
  return cached;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return NEIGHBOURS_DEFAULT_LIMIT;
  return Math.max(1, Math.min(NEIGHBOURS_MAX_LIMIT, Math.floor(limit)));
}

/** Degree-ranked, the same notion of importance `extractGodNodes` uses, then
 *  codepoint order so the answer is identical on every machine. */
function rank(index: GraphIndex, a: string, b: string): number {
  const byDegree = (index.degree.get(b) ?? 0) - (index.degree.get(a) ?? 0);
  if (byDegree !== 0) return byDegree;
  const la = index.nodes.get(a)?.label ?? a;
  const lb = index.nodes.get(b)?.label ?? b;
  if (la !== lb) return la < lb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function queryNeighbours(
  graphPath: string,
  query: NeighboursQuery,
): Promise<NeighboursResult> {
  const index = await loadIndex(graphPath);
  if (!index) {
    return {
      ok: false, code: 'not-built',
      message: 'The knowledge graph for this project has not been built. Run: baton kb rebuild',
    };
  }

  const limit = clampLimit(query.limit);

  if (query.node) {
    const node = index.nodes.get(query.node);
    if (!node) {
      // An empty neighbour list would claim the symbol is isolated. A symbol
      // the graph does not contain supports no claim about its neighbours.
      return {
        ok: false, code: 'unknown-node',
        message: `The graph has no symbol '${query.node}'. It may have been renamed since the last rebuild.`,
      };
    }
    const edges = index.adj.get(node.id) ?? [];
    const ordered = [...edges].sort((a, b) => rank(index, a.id, b.id));
    const shown = ordered.slice(0, limit);
    return {
      ok: true, kind: 'node', node,
      neighbours: shown.map((e) => ({ ...index.nodes.get(e.id)!, relation: e.relation, direction: e.direction })),
      total: edges.length,
      withheld: Math.max(0, edges.length - shown.length),
    };
  }

  if (query.file) {
    // graphPath is <project>/graphify-out/graph.json.
    const projectPath = dirname(dirname(graphPath));
    const file = normaliseGraphPath(query.file, projectPath);
    const ids = index.byFile.get(file);
    if (!ids) {
      return {
        ok: false, code: 'file-not-indexed',
        message: `The graph has never seen '${file}'. It may be new, ignored, or of a type the extractor skips.`,
      };
    }
    // Graph order, which is source order -- a reader scanning a file expects
    // its symbols in the order they appear in it.
    return {
      ok: true, kind: 'file', file,
      nodes: ids.slice(0, limit).map((id) => index.nodes.get(id)!),
      total: ids.length,
      withheld: Math.max(0, ids.length - limit),
    };
  }

  return {
    ok: false, code: 'needs-selector',
    message: "Pass ?node=<id> for a symbol's neighbours, or ?file=<path> for the symbols in a file.",
  };
}
