// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
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
  path TEXT,
  -- Which sub-project the path is relative TO. Every path Baton records is
  -- worktree-relative, so in a hub src/index.ts in proj-a and proj-b are two
  -- unrelated files that merely spell the same string. Without this, who_touched
  -- blended their histories and blamed an agent for a file it never opened.
  -- NULL means "not known" (a single repo, or a row written before this column):
  -- those still match every asker, because forgetting history is worse than
  -- showing a little extra.
  project TEXT
);
CREATE INDEX IF NOT EXISTS idx_commit_files_path ON commit_files(path);
CREATE INDEX IF NOT EXISTS idx_commits_slug ON commits(slug);
`;

/**
 * Add `commit_files.project` to a database created before it existed. SQLite has
 * no `ADD COLUMN IF NOT EXISTS`, so the column list is checked first.
 *
 * The backfill is free and worth doing: B2 git-log buckets are keyed
 * `git:<projectId>` (server.ts), and those are precisely the hub sub-project
 * rows the missing column corrupted. Task-owned rows stay NULL — their project
 * is not recoverable from the row alone, and NULL is the honest answer.
 */
function migrateCommitFiles(db: DatabaseSync): void {
  const cols = db.prepare(`PRAGMA table_info(commit_files)`).all() as unknown as Array<{ name: string }>;
  if (cols.some((c) => c.name === 'project')) return;
  db.exec(`ALTER TABLE commit_files ADD COLUMN project TEXT`);
  db.exec(`UPDATE commit_files SET project = substr(slug, 5) WHERE project IS NULL AND slug LIKE 'git:%'`);
}

const conns = new Map<string, DatabaseSync>();

function getDb(root: string): DatabaseSync {
  const dir = batonDir(root);
  const path = join(dir, 'history.db');
  let db = conns.get(path);
  if (!db) {
    mkdirSync(dir, { recursive: true });
    db = new (sqlite().DatabaseSync)(path);
    // FIRST, before any statement that needs a lock. Concurrent writers
    // (signals.ts, reports.ts, agent MCP/guard processes) share this file, and
    // the default timeout is 0 — so setting it last left the two statements
    // MOST likely to contend unprotected: the SCHEMA DDL on a fresh file, and
    // the journal_mode switch below, which needs an exclusive lock and throws
    // outright if signals.ts opened the file first (it never sets WAL).
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec(SCHEMA);
    migrateCommitFiles(db);
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
  // Forget the FTS probe too. This is called so the FILE can be deleted (purge),
  // and the daemon outlives that: a remembered `true` sent the next search
  // straight at a virtual table the new db has never had, which throws into a
  // silent LIKE fallback for the rest of the process's life.
  ftsReady.delete(path);
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
    /** The sub-project these paths are relative to; null in a single repo. */
    projectId?: string | null;
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
  const insFile = db.prepare(`INSERT INTO commit_files (sha, slug, path, project) VALUES (?, ?, ?, ?)`);
  // One transaction for the whole commit/file batch: a single fsync instead of one
  // per INSERT, so a large merge can't block other in-flight requests for long.
  db.exec('BEGIN');
  try {
    for (const c of args.commits) {
      // Files only for genuinely-new shas. At merge time every commit is new, so
      // this was invisible — until `history reindex` began re-recording the same
      // commits, and each run added another copy of every file row. The same
      // guard `ingestGitLog` already uses, for the same reason.
      const res = insCommit.run(c.sha, args.slug, c.message, c.at);
      if (res.changes === 0) continue;
      for (const f of c.files) insFile.run(c.sha, args.slug, f, args.projectId ?? null);
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
  opts: { slug: string; task: string; cwd: string; limit?: number; projectId?: string | null },
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
  const insFile = db.prepare(`INSERT INTO commit_files (sha, slug, path, project) VALUES (?, ?, ?, ?)`);
  let added = 0;
  db.exec('BEGIN');
  try {
    for (const c of commits) {
      const res = insCommit.run(c.sha, opts.slug, c.message, c.at);
      if (res.changes > 0) {
        // New to the index — record its files. If a real task already owned this
        // sha, DO NOTHING kept its row and we skip here, so no duplicate files.
        added++;
        for (const f of c.files) insFile.run(c.sha, opts.slug, f, opts.projectId ?? null);
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
  /**
   * Has this task's work actually landed?
   *
   * `history reindex` walks task branches, so the index now carries commits
   * that are real but still IN FLIGHT on someone's branch. Presenting those the
   * same as merged work would be the stale-peer-state failure in its quietest
   * form: an agent reads "src/db.ts was changed by auth-schema", assumes the
   * change is on main, and builds against code that is not there.
   */
  merged: boolean;
}

/**
 * Attribution: which task/agent/commits touched a given file path.
 *
 * `projectId` scopes the answer to one sub-project of a hub. Paths are
 * worktree-relative, so without it `src/index.ts` returned proj-a's and
 * proj-b's history as one list and blamed agents for files they never opened.
 *
 * Two deliberate escapes from the filter, both erring toward showing more:
 * an asker with no project (single repo, or a session at the hub root) sees
 * everything, and rows whose own project is NULL — written before the column
 * existed, or by a task with no sub-project — match every asker. Forgetting
 * real history is a worse failure here than showing a little extra.
 */
export function queryFile(root: string, path: string, projectId?: string | null): FileHit[] {
  const scope = projectId ?? null;
  return getDb(root)
    .prepare(
      `SELECT cf.path AS path, c.slug AS slug, t.task AS task, t.agent AS agent,
              c.sha AS sha, c.message AS message, c.at AS at,
              (t.archived_ref IS NOT NULL) AS merged
       FROM commit_files cf
       JOIN commits c ON c.sha = cf.sha
       JOIN tasks t ON t.slug = c.slug
       WHERE cf.path = ?
         AND (? IS NULL OR cf.project IS NULL OR cf.project = ?)
       ORDER BY c.at DESC`,
    )
    .all(path, scope, scope)
    // SQLite has no boolean: the expression comes back as 0/1, and a raw 0 is
    // truthy in JSON once it reaches an agent as `"merged": 0`.
    .map((r) => ({ ...(r as unknown as FileHit), merged: Boolean((r as { merged?: number }).merged) }));
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
