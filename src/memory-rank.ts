/**
 * M1 — BM25 recall ranking for project memory.
 *
 * The old scorer (`scoreMemory`) gave +1 per matched topic word: a rare
 * discriminative term (`csrf`) weighed the same as a common one (`file`), and
 * "login" could never find a fact that only says "auth". This module ranks with
 * real BM25 via an FTS5 table built IN MEMORY per query (node:sqlite, zero
 * dependencies): at the 500-fact cap that build costs ~1ms and, unlike a
 * persisted index, can never go stale — the fact files stay the only truth.
 *
 * Query expansion is mechanical (no LLM): camelCase/snake_case splitting plus
 * a small domain synonym map. Ordering is BM25 score with recency breaking
 * exact-score ties — NOT rank fusion (RRF), which would let a newer weak match
 * outrank an older strong one (rank-based smoothing treats adjacent ranks as
 * near-equal; recency is a tiebreaker here, not a relevance signal).
 */
import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { scoreMemory, type MemoryFact } from './memory.js';

// node:sqlite is a recent builtin some bundlers (Vite) can't statically resolve.
const nodeRequire = createRequire(import.meta.url);
let _sqlite: typeof import('node:sqlite') | null | false = null;
function sqlite(): typeof import('node:sqlite') | false {
  if (_sqlite === null) {
    try {
      _sqlite = nodeRequire('node:sqlite') as typeof import('node:sqlite');
    } catch {
      _sqlite = false; // ancient Node — the word-scan fallback still works
    }
  }
  return _sqlite;
}

/** Domain synonyms, expanded query-side only (the index stays verbatim). Small
 *  on purpose — expansion trades precision for recall, so every group must be
 *  a near-certain equivalence in a coding repo. */
const SYNONYM_GROUPS: string[][] = [
  ['auth', 'login', 'session', 'oauth', 'credential'],
  ['db', 'database', 'sql', 'sqlite'],
  ['config', 'configuration', 'settings', 'env'],
  ['test', 'tests', 'spec'],
  ['ui', 'frontend', 'dashboard'],
  ['api', 'endpoint', 'route'],
  ['error', 'exception', 'failure'],
  ['performance', 'perf', 'latency'],
  ['deploy', 'release', 'ship'],
];
const SYNONYMS = new Map<string, string[]>();
for (const group of SYNONYM_GROUPS) {
  for (const w of group) SYNONYMS.set(w, group.filter((g) => g !== w));
}

/** gitRoot → [git, root]; resolve_path → [resolve, path]. Lowercased parts. */
function splitIdentifier(token: string): string[] {
  const parts = token
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_.\-/\s]+/)
    .filter((p) => p.length > 1);
  return parts.length > 1 ? parts.map((p) => p.toLowerCase()) : [];
}

/**
 * Topic → search terms: lowercased words, identifier splits, synonyms. All
 * FTS syntax characters are gone by construction (only [a-z0-9] survives).
 */
export function expandTerms(topic: string): string[] {
  const raw = topic.split(/[^a-zA-Z0-9_.\-/]+/).filter((t) => t.length > 2);
  const out = new Set<string>();
  for (const token of raw) {
    for (const part of splitIdentifier(token)) out.add(part);
    const flat = token.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (flat.length > 2) out.add(flat);
  }
  for (const t of [...out]) for (const syn of SYNONYMS.get(t) ?? []) out.add(syn);
  return [...out];
}

/** What a fact is searchable by — same haystack as the old scorer, plus
 *  identifier-split forms so `gitRoot` is findable as "git root". */
function factBody(f: MemoryFact): string {
  const paths = f.anchors.files.map((a) => a.path).join(' ');
  const base = `${f.fact} ${f.type} ${f.task ?? ''} ${paths}`;
  const splits = base
    .split(/[^a-zA-Z0-9_.\-/]+/)
    .flatMap(splitIdentifier)
    .join(' ');
  return `${base} ${splits}`;
}

/**
 * Rank facts against a topic: BM25 over an in-memory FTS5 index, recency
 * breaking exact ties. Only matching facts are returned (relevance-gated —
 * recency alone never smuggles a fact in). Falls back to the plain word
 * scorer when FTS5 is unavailable.
 */
export function rankFacts<T extends MemoryFact>(facts: T[], topic: string): T[] {
  const terms = expandTerms(topic);
  if (!terms.length || !facts.length) return [];
  const lib = sqlite();
  if (lib) {
    let db: DatabaseSync | null = null;
    try {
      db = new lib.DatabaseSync(':memory:');
      db.exec(`CREATE VIRTUAL TABLE facts USING fts5(id UNINDEXED, body, tokenize='porter unicode61')`);
      const insert = db.prepare(`INSERT INTO facts (id, body) VALUES (?, ?)`);
      for (const f of facts) insert.run(f.id, factBody(f));
      // Each term quoted (hostile input stays literal) with a prefix star, so
      // "auth" reaches "authentication" like the old \bword regex did.
      const match = terms.map((t) => `"${t}"*`).join(' OR ');
      // FTS5's `rank` is the bm25 score: negative, more negative = better.
      const rows = db.prepare(`SELECT id, rank AS s FROM facts WHERE facts MATCH ?`).all(match) as Array<{ id: string; s: number }>;
      const byId = new Map(facts.map((f) => [f.id, f]));
      return rows
        .flatMap((r) => { const f = byId.get(r.id); return f ? [{ f, s: r.s }] : []; })
        .sort((a, b) => a.s - b.s || b.f.createdAt.localeCompare(a.f.createdAt))
        .map((x) => x.f);
    } catch {
      /* exotic SQLite build without FTS5 — fall through to the word scan */
    } finally {
      try { db?.close(); } catch { /* already closed */ }
    }
  }
  return facts
    .map((f) => ({ f, s: scoreMemory(f, terms.join(' ')) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.f.createdAt.localeCompare(a.f.createdAt))
    .map((x) => x.f);
}
