/**
 * Completion reports: when a task merges, capture WHAT shipped (summary,
 * files, commits) and WHO overlapped with it, persist it, and push it on the
 * bus — so a waiting agent can read it and decide "is the bug I'm chasing
 * already fixed?" before duplicating work.
 */
import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { batonDir } from './store.js';
import type { CommitInfo } from './git.js';

const nodeRequire = createRequire(import.meta.url);
let _sqlite: typeof import('node:sqlite') | null = null;
function sqlite(): typeof import('node:sqlite') {
  return (_sqlite ??= nodeRequire('node:sqlite') as typeof import('node:sqlite'));
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reports (
  slug TEXT PRIMARY KEY,
  json TEXT,
  created_at TEXT
);
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
    // Match history.ts: WAL persists in the file header; synchronous is per-handle,
    // and this is a separate connection to the same .baton/history.db.
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    conns.set(path, db);
  }
  return db;
}

/** Close + forget this module's handle to history.db (purge). Pairs with
 *  closeHistoryDb — both must release before the file can be deleted. */
export function closeReportsDb(root: string): void {
  const path = join(batonDir(root), 'history.db');
  const db = conns.get(path);
  if (db) {
    try { db.close(); } catch { /* already closed */ }
    conns.delete(path);
  }
}

export interface CompletionReport {
  slug: string;
  task: string;
  agent: string | null;
  mergedAt: string;
  summary: string;
  files: string[];
  commits: { sha: string; message: string; at: string }[];
  /** Slugs of still-open tasks that were editing the same files. */
  overlappedWith: string[];
}

export function buildReport(args: {
  slug: string;
  task: string;
  agent: string | null;
  mergedAt: string;
  commits: CommitInfo[];
  overlappedWith: string[];
}): CompletionReport {
  const files = [...new Set(args.commits.flatMap((c) => c.files ?? []))].sort();
  const subjects = args.commits.map((c) => `- ${c.message}`).join('\n');
  return {
    slug: args.slug,
    task: args.task,
    agent: args.agent,
    mergedAt: args.mergedAt,
    summary: `${args.task}\n${subjects}`.trim(),
    files,
    commits: args.commits.map(({ sha, message, at }) => ({ sha, message, at })),
    overlappedWith: args.overlappedWith,
  };
}

export function saveReport(root: string, report: CompletionReport): void {
  getDb(root)
    .prepare(
      `INSERT INTO reports (slug, json, created_at) VALUES (?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET json = excluded.json, created_at = excluded.created_at`,
    )
    .run(report.slug, JSON.stringify(report), report.mergedAt);
}

/** Human/agent-readable mirror at .baton/reports/<slug>.md. Best-effort. */
export async function writeReportFile(root: string, report: CompletionReport): Promise<void> {
  try {
    const dir = join(batonDir(root), 'reports');
    await mkdir(dir, { recursive: true });
    const md = [
      `# Completed: ${report.task}`,
      '',
      `- slug: ${report.slug}`,
      `- agent: ${report.agent ?? 'unknown'}`,
      `- merged: ${report.mergedAt}`,
      report.overlappedWith.length ? `- overlapped with: ${report.overlappedWith.join(', ')}` : '',
      '',
      '## Files changed',
      ...report.files.map((f) => `- ${f}`),
      '',
      '## Commits',
      ...report.commits.map((c) => `- ${c.sha.slice(0, 7)} ${c.message}`),
      '',
      '_If you were waiting on these files: review whether your issue is already fixed before re-doing work._',
      '',
    ].filter((l) => l !== undefined).join('\n');
    await writeFile(join(dir, `${report.slug}.md`), md, 'utf-8');
  } catch {
    /* the DB copy is the source of truth */
  }
}

export function getReport(root: string, slug: string): CompletionReport | null {
  const row = getDb(root)
    .prepare(`SELECT json FROM reports WHERE slug = ?`)
    .get(slug) as { json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.json) as CompletionReport;
  } catch {
    return null;
  }
}

export function listReports(root: string, limit = 50): CompletionReport[] {
  const rows = getDb(root)
    .prepare(`SELECT json FROM reports ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as unknown as Array<{ json: string }>;
  const out: CompletionReport[] = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.json) as CompletionReport);
    } catch {
      /* skip corrupt rows */
    }
  }
  return out;
}
