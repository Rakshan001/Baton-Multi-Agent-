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
