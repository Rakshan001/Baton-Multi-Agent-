/**
 * Live edit-signals: which files are being edited right now, by which
 * task/agent — and where two sessions are touching the same path. This is the
 * "these files are being edited by another agent, wait" layer that works
 * BEFORE anything is committed (the conflicts module covers committed work).
 *
 * Sourced from `file.edited` bus events (the worktree watcher), kept
 * in-memory for speed and mirrored to history.db so `baton signals` works
 * from a fresh process too.
 */
import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { batonDir, loadTasks } from './store.js';
import { detectAgents } from './agents.js';
import { changedFiles } from './conflicts.js';
import { bus } from './events.js';

const nodeRequire = createRequire(import.meta.url);
let _sqlite: typeof import('node:sqlite') | null = null;
function sqlite(): typeof import('node:sqlite') {
  return (_sqlite ??= nodeRequire('node:sqlite') as typeof import('node:sqlite'));
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS edit_signals (
  slug TEXT,
  path TEXT,
  at TEXT,
  PRIMARY KEY (slug, path)
);
CREATE INDEX IF NOT EXISTS idx_edit_signals_path ON edit_signals(path);
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

/** A signal is "live" if the file was edited within this window. */
export const SIGNAL_WINDOW_MIN = 30;

export interface SignalHolder {
  slug: string;
  agent: string | null;
  lastEditAt: string;
}

export interface EditSignal {
  path: string;
  level: 'info' | 'warning'; // warning = 2+ sessions on the same path
  holders: SignalHolder[];
}

interface SignalRow { slug: string; path: string; at: string }

export class SignalTracker {
  private root: string;
  private unsubs: Array<() => void> = [];
  /** paths already announced as overlapping, so we emit signal.overlap once per overlap. */
  private announced = new Set<string>();

  constructor(root: string) {
    this.root = root;
  }

  start(): void {
    this.unsubs.push(
      bus.onType('file.edited', (e) => {
        if (e.event.type !== 'file.edited') return;
        this.record(e.event.slug, e.event.path, e.event.at);
      }),
      // a commit "settles" a session's edits — its signals stop being live noise
      bus.onType('commit.created', (e) => {
        if (e.event.type === 'commit.created') this.clear(e.event.slug);
      }),
      bus.onType('task.merged', (e) => {
        if (e.event.type === 'task.merged') this.clear(e.event.slug);
      }),
      bus.onType('task.removed', (e) => {
        if (e.event.type === 'task.removed') this.clear(e.event.slug);
      }),
    );
  }

  stop(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  private record(slug: string, path: string, at: string): void {
    getDb(this.root)
      .prepare(
        `INSERT INTO edit_signals (slug, path, at) VALUES (?, ?, ?)
         ON CONFLICT(slug, path) DO UPDATE SET at = excluded.at`,
      )
      .run(slug, path, at);
    void this.checkOverlap(path);
  }

  private async checkOverlap(path: string): Promise<void> {
    const holders = liveRows(this.root).filter((r) => r.path === path);
    const slugs = [...new Set(holders.map((h) => h.slug))];
    if (slugs.length >= 2 && !this.announced.has(path)) {
      this.announced.add(path);
      bus.publish({ type: 'signal.overlap', path, slugs });
    }
    if (slugs.length < 2) this.announced.delete(path);
  }

  clear(slug: string): void {
    getDb(this.root).prepare(`DELETE FROM edit_signals WHERE slug = ?`).run(slug);
    // Re-derive overlap announcements from what's still live: keep a path announced
    // only while 2+ distinct sessions hold it. A blanket clear() would let an
    // UNRELATED slug clearing re-fire signal.overlap for overlaps that never ended.
    const bySlug = new Map<string, Set<string>>();
    for (const r of liveRows(this.root)) {
      let s = bySlug.get(r.path);
      if (!s) bySlug.set(r.path, (s = new Set()));
      s.add(r.slug);
    }
    for (const p of [...this.announced]) {
      if ((bySlug.get(p)?.size ?? 0) < 2) this.announced.delete(p);
    }
  }
}

function liveRows(root: string, windowMin = SIGNAL_WINDOW_MIN): SignalRow[] {
  const cutoff = new Date(Date.now() - windowMin * 60_000).toISOString();
  return getDb(root)
    .prepare(`SELECT slug, path, at FROM edit_signals WHERE at >= ? ORDER BY at DESC`)
    .all(cutoff) as unknown as SignalRow[];
}

/** Current edit signals, grouped by path; overlapping paths are warnings. */
export async function getSignals(root: string, windowMin = SIGNAL_WINDOW_MIN): Promise<EditSignal[]> {
  const rows = liveRows(root, windowMin);
  const tasks = await loadTasks(root);
  const agents = await detectAgents(tasks.map((t) => t.worktreePath));
  const agentFor = (slug: string) => {
    const t = tasks.find((x) => x.slug === slug);
    return t ? (agents.get(t.worktreePath) ?? null) : null;
  };

  const byPath = new Map<string, SignalHolder[]>();
  for (const r of rows) {
    if (!byPath.has(r.path)) byPath.set(r.path, []);
    byPath.get(r.path)!.push({ slug: r.slug, agent: agentFor(r.slug), lastEditAt: r.at });
  }
  return [...byPath.entries()]
    .map(([path, holders]) => ({
      path,
      level: new Set(holders.map((h) => h.slug)).size >= 2 ? ('warning' as const) : ('info' as const),
      holders,
    }))
    .sort((a, b) => (a.level === b.level ? a.path.localeCompare(b.path) : a.level === 'warning' ? -1 : 1));
}

export interface FileCheck {
  busy: boolean;
  by: SignalHolder[];
}

/**
 * The "ask before editing" API: is anyone working on these files right now?
 * Combines live edit signals (uncommitted, real-time) with each task's
 * committed-but-unmerged divergence from its base branch.
 */
export async function checkFiles(root: string, paths: string[]): Promise<Record<string, FileCheck>> {
  const signals = await getSignals(root);
  const tasks = await loadTasks(root);
  const agents = await detectAgents(tasks.map((t) => t.worktreePath));
  const changed = new Map<string, Set<string>>(); // slug → files
  await Promise.all(tasks.map(async (t) => changed.set(t.slug, await changedFiles(t, root))));
  const byPath = new Map(signals.map((s) => [s.path, s.holders]));

  const result: Record<string, FileCheck> = {};
  for (const p of paths) {
    const holders: SignalHolder[] = [...(byPath.get(p) ?? [])];
    for (const t of tasks) {
      if (changed.get(t.slug)?.has(p) && !holders.some((h) => h.slug === t.slug)) {
        holders.push({ slug: t.slug, agent: agents.get(t.worktreePath) ?? null, lastEditAt: '' });
      }
    }
    result[p] = { busy: holders.length > 0, by: holders };
  }
  return result;
}
