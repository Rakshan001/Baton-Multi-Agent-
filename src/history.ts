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
import type { CommitInfo } from './git.js';

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
    conns.set(path, db);
  }
  return db;
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
  for (const c of args.commits) {
    insCommit.run(c.sha, args.slug, c.message, c.at);
    for (const f of c.files) insFile.run(c.sha, args.slug, f);
  }
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
  const commitStmt = db.prepare(
    `SELECT sha, message, at FROM commits WHERE slug = ? ORDER BY at DESC`,
  );
  return tasks.map((t) => ({
    ...t,
    commits: commitStmt.all(t.slug) as unknown as { sha: string; message: string; at: string }[],
  }));
}
