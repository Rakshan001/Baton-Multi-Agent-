/**
 * Local, queryable history index (`.baton/history.db`, gitignored) using Node's
 * built-in `node:sqlite` — no external dependency.
 *
 * Purpose: cheap bug-tracing/attribution. Instead of an agent scanning a large
 * `git log`, it asks "who/what touched this file?" and gets a few rows back —
 * low token cost. The git history itself (incl. archived refs) stays the source
 * of truth; this is just a fast index over it.
 */
import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { batonDir } from './store.js';
import { recentCommits, type CommitInfo } from './git.js';

// node:sqlite is a recent builtin some bundlers (Vite) can't statically resolve.
// Load it natively + lazily at runtime; the type comes from the erased type-only import.
const nodeRequire = createRequire(import.meta.url);
let _sqlite: typeof import('node:sqlite') | null = null;
function sqlite(): typeof import('node:sqlite') {
  return (_sqlite ??= nodeRequire('node:sqlite') as typeof import('node:sqlite'));
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  slug TEXT PRIMARY KEY,
  task TEXT,
  agent TEXT,
  branch TEXT,
  base_branch TEXT,
  created_at TEXT,
  merged_at TEXT,
  archived_ref TEXT
);
CREATE TABLE IF NOT EXISTS commits (
  sha TEXT PRIMARY KEY,
  slug TEXT,
  message TEXT,
  at TEXT
);
CREATE TABLE IF NOT EXISTS commit_files (
  sha TEXT,
  slug TEXT,
  path TEXT
);
CREATE INDEX IF NOT EXISTS idx_commit_files_path ON commit_files(path);
CREATE INDEX IF NOT EXISTS idx_commits_slug ON commits(slug);
`;

const conns = new Map<string, DatabaseSync>();

function getDb(root: string): DatabaseSync {
  const dir = batonDir(root);
  const path = join(dir, 'history.db');
  let db = conns.get(path);
  if (!db) {
    mkdirSync(dir, { recursive: true });
    db = new (sqlite().DatabaseSync)(path);
    db.exec(SCHEMA);
    // WAL (persisted in the file header) + NORMAL sync keep merge-time writes from
    // fsync-stalling the daemon's single event loop. synchronous is per-connection,
    // so reports.ts (a separate handle to this same file) sets it too.
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    // Concurrent writers (signals.ts, reports.ts, agent MCP/guard processes) share
    // this file; without a busy timeout a locked write throws immediately.
    db.exec('PRAGMA busy_timeout = 5000;');
    conns.set(path, db);
  }
  return db;
}

/** Close + forget the history.db handle so the file can be deleted (purge). The
 *  next getDb() reopens it. reports.ts holds a separate handle to the same file. */
export function closeHistoryDb(root: string): void {
  const path = join(batonDir(root), 'history.db');
  const db = conns.get(path);
  if (db) {
    try { db.close(); } catch { /* already closed */ }
    conns.delete(path);
  }
}

export interface TaskRecord {
  slug: string;
  task: string;
  agent?: string | null;
  branch: string;
  baseBranch: string;
  createdAt: string;
}

/** Record (or upsert) a task when it's created. */
export function recordTask(root: string, t: TaskRecord): void {
  getDb(root)
    .prepare(
      `INSERT INTO tasks (slug, task, agent, branch, base_branch, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         task=excluded.task, branch=excluded.branch,
         base_branch=excluded.base_branch, created_at=excluded.created_at`,
    )
    .run(t.slug, t.task, t.agent ?? null, t.branch, t.baseBranch, t.createdAt);
}

/** Record a task's commits + files at merge time, and stamp merge metadata. */
export function recordMerge(
  root: string,
  args: {
    slug: string;
    agent?: string | null;
    mergedAt: string;
    archivedRef: string | null;
    commits: CommitInfo[];
  },
): void {
  const db = getDb(root);
  db.prepare(
    `UPDATE tasks SET merged_at = ?, archived_ref = ?, agent = COALESCE(?, agent) WHERE slug = ?`,
  ).run(args.mergedAt, args.archivedRef, args.agent ?? null, args.slug);

  const insCommit = db.prepare(
    `INSERT INTO commits (sha, slug, message, at) VALUES (?, ?, ?, ?)
     ON CONFLICT(sha) DO NOTHING`,
  );
  const insFile = db.prepare(`INSERT INTO commit_files (sha, slug, path) VALUES (?, ?, ?)`);
  // One transaction for the whole commit/file batch: a single fsync instead of one
  // per INSERT, so a large merge can't block other in-flight requests for long.
  db.exec('BEGIN');
  try {
    for (const c of args.commits) {
      insCommit.run(c.sha, args.slug, c.message, c.at);
      for (const f of c.files) insFile.run(c.sha, args.slug, f);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * B2 — ingest a repo's real git history into a synthetic per-project bucket so
 * commits that landed OUTSIDE `baton merge` (agents merging via GitHub PRs on
 * the sub-repos) still show in the History page and who_touched/blame. Returns
 * how many NEW commits were added. Idempotent (ON CONFLICT sha DO NOTHING) and
 * files are inserted only for genuinely-new shas, so a commit a real task
 * already owns is left untouched — the real task keeps the attribution.
 */
export async function ingestGitLog(
  root: string,
  opts: { slug: string; task: string; cwd: string; limit?: number },
): Promise<number> {
  const commits = await recentCommits(opts.cwd, opts.limit ?? 100);
  if (commits.length === 0) return 0;
  const db = getDb(root);
  // Upsert the bucket task row so the tasks-JOIN in queryFile/listHistory resolves.
  const latestAt = commits.reduce((m, c) => (c.at > m ? c.at : m), commits[0].at);
  db.prepare(
    `INSERT INTO tasks (slug, task, agent, branch, base_branch, created_at, merged_at)
     VALUES (?, ?, NULL, NULL, NULL, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET task = excluded.task, merged_at = excluded.merged_at`,
  ).run(opts.slug, opts.task, latestAt, latestAt);

  const insCommit = db.prepare(
    `INSERT INTO commits (sha, slug, message, at) VALUES (?, ?, ?, ?) ON CONFLICT(sha) DO NOTHING`,
  );
  const insFile = db.prepare(`INSERT INTO commit_files (sha, slug, path) VALUES (?, ?, ?)`);
  let added = 0;
  db.exec('BEGIN');
  try {
    for (const c of commits) {
      const res = insCommit.run(c.sha, opts.slug, c.message, c.at);
      if (res.changes > 0) {
        // New to the index — record its files. If a real task already owned this
        // sha, DO NOTHING kept its row and we skip here, so no duplicate files.
        added++;
        for (const f of c.files) insFile.run(c.sha, opts.slug, f);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return added;
}

/* ---- unified commit search (FTS5, token-optimal) ---------------------- */

export interface HistorySearchHit {
  sha: string;
  message: string;
  at: string;
  slug: string;
  task: string | null;
  agent: string | null;
  files: string[];
  moreFiles: number;
}

const SEARCH_FILE_CAP = 5;

/** FTS5 may be absent in exotic SQLite builds — remember per-db so we only probe once. */
const ftsReady = new Map<string, boolean>();

function ensureFts(root: string): boolean {
  const key = join(batonDir(root), 'history.db');
  const cached = ftsReady.get(key);
  if (cached !== undefined) return cached;
  const db = getDb(root);
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS commits_fts USING fts5(sha UNINDEXED, message, files)`);
    ftsReady.set(key, true);
    return true;
  } catch {
    ftsReady.set(key, false);
    return false;
  }
}

/** Rebuild the FTS index iff it's out of sync with commits (lazy backfill). The
 *  write paths stay untouched — a full rebuild of even 10k commits is cheap and
 *  happens only when a search actually runs after new commits landed. */
function syncFts(root: string): void {
  const db = getDb(root);
  const commitCount = (db.prepare(`SELECT COUNT(*) AS n FROM commits`).get() as { n: number }).n;
  const ftsCount = (db.prepare(`SELECT COUNT(*) AS n FROM commits_fts`).get() as { n: number }).n;
  if (commitCount === ftsCount) return;
  db.exec('BEGIN');
  try {
    db.exec(`DELETE FROM commits_fts`);
    db.exec(
      `INSERT INTO commits_fts (sha, message, files)
       SELECT c.sha, c.message, COALESCE((SELECT GROUP_CONCAT(path, ' ') FROM commit_files f WHERE f.sha = c.sha), '')
       FROM commits c`,
    );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Quote each term so identifiers, paths, and hostile input are literal — never FTS syntax. */
function ftsQuery(query: string): string {
  return query
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim())
    .filter(Boolean)
    .map((t) => `"${t}"`)
    .join(' ');
}

function hydrateHits(root: string, rows: Array<{ sha: string; message: string; at: string; slug: string }>): HistorySearchHit[] {
  const db = getDb(root);
  const taskStmt = db.prepare(`SELECT task, agent FROM tasks WHERE slug = ?`);
  const filesStmt = db.prepare(`SELECT path FROM commit_files WHERE sha = ?`);
  return rows.map((r) => {
    const t = taskStmt.get(r.slug) as { task: string | null; agent: string | null } | undefined;
    const files = (filesStmt.all(r.sha) as Array<{ path: string }>).map((f) => f.path);
    return {
      sha: r.sha, message: r.message, at: r.at, slug: r.slug,
      task: t?.task ?? null, agent: t?.agent ?? null,
      files: files.slice(0, SEARCH_FILE_CAP), moreFiles: Math.max(0, files.length - SEARCH_FILE_CAP),
    };
  });
}

/** Search merged/ingested commits by message + touched paths. Ranked (FTS5 when
 *  available, LIKE fallback otherwise), capped, and cheap to serve to an agent. */
export function searchHistory(root: string, query: string, limit = 10): HistorySearchHit[] {
  const db = getDb(root);
  const cap = Math.max(1, Math.min(limit, 25));
  const q = ftsQuery(query);
  if (!q) return [];
  if (ensureFts(root)) {
    try {
      syncFts(root);
      const rows = db.prepare(
        `SELECT c.sha, c.message, c.at, c.slug
         FROM commits_fts fts JOIN commits c ON c.sha = fts.sha
         WHERE commits_fts MATCH ? ORDER BY rank LIMIT ?`,
      ).all(q, cap) as Array<{ sha: string; message: string; at: string; slug: string }>;
      return hydrateHits(root, rows);
    } catch { /* malformed MATCH despite quoting — fall through to LIKE */ }
  }
  const terms = query.split(/\s+/).filter(Boolean).slice(0, 6);
  if (!terms.length) return [];
  const where = terms.map(() => `(c.message LIKE ? OR EXISTS (SELECT 1 FROM commit_files f WHERE f.sha = c.sha AND f.path LIKE ?))`).join(' AND ');
  const params = terms.flatMap((t) => [`%${t}%`, `%${t}%`]);
  const rows = db.prepare(
    `SELECT c.sha, c.message, c.at, c.slug FROM commits c WHERE ${where} ORDER BY c.at DESC LIMIT ?`,
  ).all(...params, cap) as Array<{ sha: string; message: string; at: string; slug: string }>;
  return hydrateHits(root, rows);
}

export interface FileHit {
  path: string;
  slug: string;
  task: string;
  agent: string | null;
  sha: string;
  message: string;
  at: string;
}

/** Attribution: which task/agent/commits touched a given file path. */
export function queryFile(root: string, path: string): FileHit[] {
  return getDb(root)
    .prepare(
      `SELECT cf.path AS path, c.slug AS slug, t.task AS task, t.agent AS agent,
              c.sha AS sha, c.message AS message, c.at AS at
       FROM commit_files cf
       JOIN commits c ON c.sha = cf.sha
       JOIN tasks t ON t.slug = c.slug
       WHERE cf.path = ?
       ORDER BY c.at DESC`,
    )
    .all(path) as unknown as FileHit[];
}

export interface TaskHistory {
  slug: string;
  task: string;
  agent: string | null;
  mergedAt: string | null;
  commits: { sha: string; message: string; at: string }[];
}

/** Full history (tasks + their commits) — for the dashboard /api/history. */
export function listHistory(root: string): TaskHistory[] {
  const db = getDb(root);
  const tasks = db
    .prepare(`SELECT slug, task, agent, merged_at AS mergedAt FROM tasks ORDER BY created_at DESC`)
    .all() as unknown as Array<{ slug: string; task: string; agent: string | null; mergedAt: string | null }>;
  // One grouped read instead of a per-task query (was 1+N on a polled endpoint).
  const rows = db
    .prepare(`SELECT slug, sha, message, at FROM commits ORDER BY at DESC`)
    .all() as unknown as Array<{ slug: string; sha: string; message: string; at: string }>;
  const bySlug = new Map<string, { sha: string; message: string; at: string }[]>();
  for (const r of rows) {
    let list = bySlug.get(r.slug);
    if (!list) bySlug.set(r.slug, (list = []));
    list.push({ sha: r.sha, message: r.message, at: r.at });
  }
  return tasks.map((t) => ({ ...t, commits: bySlug.get(t.slug) ?? [] }));
}
