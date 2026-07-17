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
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { batonDir, loadTasks, type Task } from './store.js';
import { detectAgents } from './agents.js';
import { changedFiles } from './conflicts.js';
import { gitTry } from './util/exec.js';
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
  settledAt TEXT,
  PRIMARY KEY (slug, path)
);
CREATE INDEX IF NOT EXISTS idx_edit_signals_path ON edit_signals(path);
CREATE TABLE IF NOT EXISTS signal_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS task_progress (
  slug TEXT PRIMARY KEY,
  note TEXT,
  at TEXT
);
CREATE TABLE IF NOT EXISTS hook_sessions (
  slug TEXT PRIMARY KEY,
  agent TEXT,
  root TEXT,
  at TEXT
);
CREATE TABLE IF NOT EXISTS watched_roots (
  slug TEXT PRIMARY KEY,
  path TEXT,
  at TEXT
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
    migrate(db);
    conns.set(path, db);
  }
  return db;
}

/**
 * `CREATE TABLE IF NOT EXISTS` is a no-op on an existing history.db, so a column
 * added after the fact has to be applied by hand. Additive and idempotent: an
 * older daemon reading the same file simply ignores the column.
 */
function migrate(db: DatabaseSync): void {
  const cols = db.prepare(`PRAGMA table_info(edit_signals)`).all() as unknown as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'settledAt')) db.exec(`ALTER TABLE edit_signals ADD COLUMN settledAt TEXT`);
}

/**
 * Canonicalize a checkout path for identity comparison — resolves symlinks and
 * macOS's /var→/private/var so a session root and a watched-checkout path that
 * point at the same directory compare equal. Best-effort: a missing/stale path
 * falls back to the raw string rather than throwing.
 */
function canonicalRoot(p: string | null | undefined): string | null {
  if (!p) return null;
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * A signal is "active" if the file was edited within this window AND is still
 * dirty. Bounds how long an uncommitted edit keeps holding a path.
 */
export const SIGNAL_WINDOW_MIN = 30;

/**
 * How long a *settled* signal (its path went clean — committed, merged or
 * reverted) stays visible as "X finished editing Y 2m ago" before being dropped
 * for good. Deliberately short: it is a recency hint for the board, not history
 * (history.db already has the commits). ISS-15.
 */
export const SETTLED_WINDOW_MIN = 5;

/** Hard ceiling on retained settled rows, so a busy repo can't grow them without bound. */
const SETTLED_CAP = 200;

export interface SignalHolder {
  slug: string;
  agent: string | null;
  lastEditAt: string;
  /**
   * `active` = holding the path right now (uncommitted, dirty) — the only state
   * that means "wait". `settled` = touched it recently, since committed/reverted:
   * shown dimmed on the board, never a reason to wait.
   */
  state: 'active' | 'settled';
  /** When the path went clean. Set only on settled holders. */
  settledAt?: string;
  /** Free-text intent the holder reported (report_progress), if fresh. */
  note?: string;
  noteAt?: string;
}

export interface Progress {
  slug: string;
  note: string;
  at: string;
}

/** Record what a task is working on right now (latest note wins). */
export function setProgress(root: string, slug: string, note: string): void {
  getDb(root)
    .prepare(
      `INSERT INTO task_progress (slug, note, at) VALUES (?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET note = excluded.note, at = excluded.at`,
    )
    .run(slug, note, new Date().toISOString());
}

/** Fresh progress notes (within the signal window), keyed by slug. */
export function getProgress(root: string, windowMin = SIGNAL_WINDOW_MIN): Map<string, Progress> {
  const cutoff = new Date(Date.now() - windowMin * 60_000).toISOString();
  const rows = getDb(root)
    .prepare(`SELECT slug, note, at FROM task_progress WHERE at >= ?`)
    .all(cutoff) as unknown as Progress[];
  return new Map(rows.map((r) => [r.slug, r]));
}

export function clearProgress(root: string, slug: string): void {
  getDb(root).prepare(`DELETE FROM task_progress WHERE slug = ?`).run(slug);
}

/** Attach each holder's fresh progress note in place (one query, reused). */
function enrichWithNotes(root: string, holderLists: SignalHolder[][]): void {
  const progress = getProgress(root);
  if (progress.size === 0) return;
  for (const holders of holderLists) {
    for (const h of holders) {
      const p = progress.get(h.slug);
      if (p) { h.note = p.note; h.noteAt = p.at; }
    }
  }
}

export interface EditSignal {
  path: string;
  level: 'info' | 'warning'; // warning = 2+ sessions on the same path
  holders: SignalHolder[];
}

interface SignalRow { slug: string; path: string; at: string; settledAt: string | null }

/* ------------------- hook-written signals (root sessions, G2) ------------------- */

/**
 * A session running at the repo root (no worktree, no task) is identified by
 * the agent's own session id — stable for the session, meaningless after it.
 */
export function sessionSlug(sessionId: string): string {
  const clean = sessionId.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 8) || 'unknown';
  return `sess-${clean}`;
}

interface HookSession { agent: string | null; root: string | null; at: string }

/**
 * Record an edit signal from the edit-guard hook — the daemon-less write path.
 * Task-slugged edits are the same rows the daemon watcher writes (upsert-safe);
 * a root session additionally registers itself (agent + its checkout root) so
 * reads can attribute and reconcile it without a task record.
 */
export function recordHookEdit(
  root: string,
  opts: { slug: string; path: string; at?: string; session?: { agent: string; sessionRoot: string } },
): void {
  const at = opts.at ?? new Date().toISOString();
  getDb(root)
    .prepare(
      `INSERT INTO edit_signals (slug, path, at) VALUES (?, ?, ?)
       ON CONFLICT(slug, path) DO UPDATE SET at = excluded.at, settledAt = NULL`,
    )
    .run(opts.slug, opts.path, at);
  if (opts.session) registerHookSession(root, opts.slug, opts.session.agent, opts.session.sessionRoot, at);
}

/**
 * Register a session (agent + the checkout it works in) without recording an
 * edit — the MCP server calls this at startup (M1) so cursor/codex/gemini
 * sessions are attributable before they touch anything.
 */
export function registerHookSession(
  root: string,
  slug: string,
  agent: string | null,
  sessionRoot: string,
  at: string = new Date().toISOString(),
): void {
  getDb(root)
    .prepare(
      `INSERT INTO hook_sessions (slug, agent, root, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET agent = excluded.agent, root = excluded.root, at = excluded.at`,
    )
    .run(slug, agent, sessionRoot, at);
}

/**
 * Bump a registered session's last-seen time on ANY activity — not only edits —
 * so a connected agent that just reads (orient/check_files/recall) still counts
 * as present (finding #5). UPDATE-only: a no-op when the session has no row (task
 * sessions never register), so it can never fabricate presence for a task slug.
 */
export function touchHookSession(root: string, slug: string, at: string = new Date().toISOString()): void {
  getDb(root).prepare(`UPDATE hook_sessions SET at = ? WHERE slug = ?`).run(at, slug);
}

/**
 * How long a registered session row outlives its last sighting. Sessions are
 * never explicitly closed — an agent just stops — and each new session takes a
 * fresh slug, so without a sweep hook_sessions grows one row per session
 * forever (38 rows on a real hub, freshest 10h stale, all long invisible to
 * liveSessions yet still scanned by every reconcile).
 *
 * Deliberately far longer than both the presence window (30 min — a session
 * idles out of the board but stays a real, resolvable session) and the signal
 * window (30 min). reconcile resolves a session's checkout THROUGH this row, so
 * dropping it while its signals are live would make them look orphaned and erase
 * paths that are genuinely held. At 24h, an expired session's signals were
 * themselves reclaimed 23.5h earlier — there is nothing left to misread.
 */
export const SESSION_RETENTION_MIN = 24 * 60;

/** Reclaim session rows past SESSION_RETENTION_MIN. Safe to call on any schedule. */
export function expireSessions(root: string): void {
  const cutoff = new Date(Date.now() - SESSION_RETENTION_MIN * 60_000).toISOString();
  getDb(root).prepare(`DELETE FROM hook_sessions WHERE at < ?`).run(cutoff);
}

/** Every registered session slug, retention included — for tests/diagnostics. */
export function allHookSessionSlugs(root: string): string[] {
  return (getDb(root).prepare(`SELECT slug FROM hook_sessions`).all() as unknown as Array<{ slug: string }>).map(
    (r) => r.slug,
  );
}

function hookSessions(root: string): Map<string, HookSession> {
  const rows = getDb(root).prepare(`SELECT slug, agent, root, at FROM hook_sessions`).all() as unknown as Array<
    HookSession & { slug: string }
  >;
  return new Map(rows.map((r) => [r.slug, r]));
}

/* ------------------- watched checkouts (agent-agnostic capture, ADD-07/A) ------------------- */

/**
 * A non-task git checkout the daemon watcher is deriving live signals from (the
 * hub root in a single-repo setup, or each sub-project in a multi-repo hub).
 * Persisted so read-time reconcile can verify a checkout's signals against its
 * git dirty state (and prune settled ones), and so reads can layer an agent name
 * from a session registered at the same checkout. Slugs are `co-<id>`.
 */
export function registerWatchedRoot(root: string, slug: string, path: string, at: string = new Date().toISOString()): void {
  getDb(root)
    .prepare(
      `INSERT INTO watched_roots (slug, path, at) VALUES (?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET path = excluded.path, at = excluded.at`,
    )
    .run(slug, path, at);
}

export function unregisterWatchedRoot(root: string, slug: string): void {
  getDb(root).prepare(`DELETE FROM watched_roots WHERE slug = ?`).run(slug);
}

/** slug → checkout path for every checkout the daemon is currently watching. */
export function watchedRoots(root: string): Map<string, string> {
  const rows = getDb(root).prepare(`SELECT slug, path FROM watched_roots`).all() as unknown as Array<{ slug: string; path: string }>;
  return new Map(rows.map((r) => [r.slug, r.path]));
}

/**
 * How recently a registered session must have been seen (connect or edit) to be
 * counted as "connected" on the presence board. Longer than the edit-signal
 * window because a connected agent may sit idle between edits — a session that
 * hasn't touched a file in 20 min is still present.
 */
export const PRESENCE_WINDOW_MIN = 30;

export interface LiveSession {
  slug: string;
  agent: string | null;
  /** The checkout the session registered from (usually a repo/hub root). */
  root: string | null;
  /** Last time the session was seen — connect time or last edit. */
  at: string;
}

/**
 * Registered agent sessions (MCP connect via registerHookSession, or an edit
 * hook) last seen within the window. This is the "who is connected right now"
 * source the dashboard needs — every agent, hooked or not, worktree or plain
 * checkout, without a per-agent panel (ISS-12/ISS-14).
 */
export function liveSessions(root: string, windowMin = PRESENCE_WINDOW_MIN): LiveSession[] {
  const cutoff = new Date(Date.now() - windowMin * 60_000).toISOString();
  return getDb(root)
    .prepare(`SELECT slug, agent, root, at FROM hook_sessions WHERE at >= ? ORDER BY at DESC`)
    .all(cutoff) as unknown as LiveSession[];
}

/** Watcher liveness: heartbeat fresher than this ⇒ "not busy" answers are trustworthy. */
export const WATCHER_HEARTBEAT_STALE_MS = 2 * 60_000;
const HEARTBEAT_REFRESH_MS = 60_000;
const HEARTBEAT_KEY = 'watcher_heartbeat';

function touchHeartbeat(root: string): void {
  getDb(root)
    .prepare(`INSERT INTO signal_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(HEARTBEAT_KEY, new Date().toISOString());
}

/**
 * True if a daemon's watcher+tracker heartbeat is fresh for this root. Lets
 * callers (the guard hook, check_files) distinguish "all clear" from "nobody
 * is recording signals" — a stale/no heartbeat means busy:false is unproven.
 */
export function isWatcherActive(root: string): boolean {
  try {
    const row = getDb(root).prepare(`SELECT value FROM signal_meta WHERE key = ?`).get(HEARTBEAT_KEY) as
      | { value: string }
      | undefined;
    if (!row) return false;
    return Date.now() - Date.parse(row.value) < WATCHER_HEARTBEAT_STALE_MS;
  } catch {
    return false;
  }
}

export class SignalTracker {
  private root: string;
  private unsubs: Array<() => void> = [];
  private heartbeat: NodeJS.Timeout | null = null;
  /** paths already announced as overlapping, so we emit signal.overlap once per overlap. */
  private announced = new Set<string>();

  constructor(root: string) {
    this.root = root;
  }

  start(): void {
    // The heartbeat is already a periodic write — fold row reclamation into it
    // rather than paying for housekeeping on the read path (getSignals is on the
    // dashboard's 5s poll and the guard's latency budget). Sweep on start too:
    // rows a crashed daemon left behind shouldn't wait a full interval, and the
    // daemon may not live long enough to reach one.
    this.housekeep();
    this.heartbeat = setInterval(() => this.housekeep(), HEARTBEAT_REFRESH_MS);
    this.heartbeat.unref?.();
    this.unsubs.push(
      bus.onType('file.edited', (e) => {
        if (e.event.type !== 'file.edited') return;
        this.record(e.event.slug, e.event.path, e.event.at);
      }),
      // A commit/merge "settles" a session's edits: they stop holding their paths,
      // but the board can still say "X finished editing Y 2m ago" (ISS-15) — so
      // settle, don't delete. Only a removed worktree is a true hard clear: there
      // is no longer any work, in progress or finished, to point at.
      bus.onType('commit.created', (e) => {
        if (e.event.type === 'commit.created') this.settle(e.event.slug);
      }),
      bus.onType('task.merged', (e) => {
        if (e.event.type === 'task.merged') this.settle(e.event.slug);
      }),
      bus.onType('task.removed', (e) => {
        if (e.event.type === 'task.removed') this.clear(e.event.slug);
      }),
    );
  }

  /** Liveness stamp + row reclamation, on one schedule. */
  private housekeep(): void {
    touchHeartbeat(this.root);
    expireSettled(this.root);
    expireSessions(this.root);
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  private record(slug: string, path: string, at: string): void {
    getDb(this.root)
      .prepare(
        `INSERT INTO edit_signals (slug, path, at) VALUES (?, ?, ?)
         ON CONFLICT(slug, path) DO UPDATE SET at = excluded.at, settledAt = NULL`,
      )
      .run(slug, path, at);
    void this.checkOverlap(path);
  }

  private async checkOverlap(path: string): Promise<void> {
    // Settled holders can't overlap with anyone — they've let the path go.
    const holders = activeRows(this.root).filter((r) => r.path === path);
    const slugs = [...new Set(holders.map((h) => h.slug))];
    if (slugs.length >= 2 && !this.announced.has(path)) {
      this.announced.add(path);
      bus.publish({ type: 'signal.overlap', path, slugs });
    }
    if (slugs.length < 2) this.announced.delete(path);
  }

  /** The session's work landed: its paths are released, but stay visible briefly. */
  settle(slug: string): void {
    settleRows(this.root, slug);
    clearProgress(this.root, slug); // the work landed — its intent note is spent
    this.reannounce();
  }

  /** The worktree is gone: erase the signals outright, there is nothing to show. */
  clear(slug: string): void {
    getDb(this.root).prepare(`DELETE FROM edit_signals WHERE slug = ?`).run(slug);
    clearProgress(this.root, slug);
    this.reannounce();
  }

  /**
   * Re-derive overlap announcements from what is still actively held: keep a path
   * announced only while 2+ distinct sessions hold it. Blanket-clearing `announced`
   * would let an UNRELATED slug settling re-fire signal.overlap for overlaps that
   * never ended.
   */
  private reannounce(): void {
    const bySlug = new Map<string, Set<string>>();
    for (const r of activeRows(this.root)) {
      let s = bySlug.get(r.path);
      if (!s) bySlug.set(r.path, (s = new Set()));
      s.add(r.slug);
    }
    for (const p of [...this.announced]) {
      if ((bySlug.get(p)?.size ?? 0) < 2) this.announced.delete(p);
    }
  }
}

/**
 * Every signal still worth showing: actively-held paths edited inside the signal
 * window, plus recently-settled ones inside the (shorter) settled window. Callers
 * that must only consider genuinely-held paths use `activeRows`.
 *
 * Settled rows past their window are deleted here rather than merely filtered:
 * the read path is the only thing guaranteed to run in a daemon-less setup, so
 * it owns expiry. `SETTLED_CAP` bounds the table if reads are rare and edits aren't.
 */
function liveRows(root: string, windowMin = SIGNAL_WINDOW_MIN): SignalRow[] {
  const db = getDb(root);
  const cutoff = new Date(Date.now() - windowMin * 60_000).toISOString();
  const settledCutoff = new Date(Date.now() - SETTLED_WINDOW_MIN * 60_000).toISOString();
  // Both windows are enforced by the query, so what is shown never depends on
  // whether the (write-path) expiry sweep has run yet.
  return db
    .prepare(
      `SELECT slug, path, at, settledAt FROM edit_signals
       WHERE (settledAt IS NULL AND at >= ?) OR (settledAt IS NOT NULL AND settledAt >= ?)
       ORDER BY at DESC`,
    )
    .all(cutoff, settledCutoff) as unknown as SignalRow[];
}

/**
 * Reclaim settled rows the queries already hide, and enforce SETTLED_CAP. Runs on
 * the settle path — rare, and already a write — rather than on reads: getSignals
 * is on the dashboard's 5s poll and the guard's latency budget, and neither should
 * pay for a write (or contend with the watcher for the db lock) on every read.
 */
function expireSettled(root: string): void {
  const db = getDb(root);
  const settledCutoff = new Date(Date.now() - SETTLED_WINDOW_MIN * 60_000).toISOString();
  db.prepare(`DELETE FROM edit_signals WHERE settledAt IS NOT NULL AND settledAt < ?`).run(settledCutoff);
  db.prepare(
    `DELETE FROM edit_signals WHERE settledAt IS NOT NULL AND rowid NOT IN
       (SELECT rowid FROM edit_signals WHERE settledAt IS NOT NULL ORDER BY settledAt DESC LIMIT ?)`,
  ).run(SETTLED_CAP);
  // Active rows past the signal window are dead weight: liveRows hides them, so
  // reconcile can never see them to settle or revive them, and a live edit would
  // re-record the path anyway. Without this they are never reclaimed — a real hub
  // held 456 rows from tasks deleted nine days earlier.
  const activeCutoff = new Date(Date.now() - SIGNAL_WINDOW_MIN * 60_000).toISOString();
  db.prepare(`DELETE FROM edit_signals WHERE settledAt IS NULL AND at < ?`).run(activeCutoff);
}

/** Only paths being held right now — the "should I wait?" set. */
function activeRows(root: string, windowMin = SIGNAL_WINDOW_MIN): SignalRow[] {
  return liveRows(root, windowMin).filter((r) => !r.settledAt);
}

/**
 * Mark paths as released. Never re-stamps an already-settled row: refreshing the
 * stamp on every read would keep settled entries alive forever and they'd never expire.
 */
function settleRows(root: string, slug: string, paths?: string[], at = new Date().toISOString()): void {
  const db = getDb(root);
  if (!paths) {
    db.prepare(`UPDATE edit_signals SET settledAt = ? WHERE slug = ? AND settledAt IS NULL`).run(at, slug);
  } else {
    const stmt = db.prepare(`UPDATE edit_signals SET settledAt = ? WHERE slug = ? AND path = ? AND settledAt IS NULL`);
    for (const p of paths) stmt.run(at, slug, p);
  }
  expireSettled(root); // fold housekeeping into the write we are already doing
}

/** A settled path went dirty again — it is being worked on once more. */
function reactivateRows(root: string, rows: SignalRow[]): void {
  const stmt = getDb(root).prepare(`UPDATE edit_signals SET settledAt = NULL WHERE slug = ? AND path = ?`);
  for (const r of rows) stmt.run(r.slug, r.path);
}

/**
 * Erase rows whose holder no longer exists. A hard delete (not settle) on
 * purpose: settling means "the work landed, show it briefly"; these rows point
 * at a checkout that is gone, so there is no work — finished or otherwise — to
 * point at. Same doctrine as SignalTracker.clear().
 */
function clearRows(root: string, rows: SignalRow[]): void {
  const stmt = getDb(root).prepare(`DELETE FROM edit_signals WHERE slug = ? AND path = ?`);
  for (const r of rows) stmt.run(r.slug, r.path);
}

/**
 * Paths still "dirty" in a worktree: tracked modifications vs HEAD plus brand-new
 * untracked files (which `git diff HEAD` omits, so we must union them in or a
 * file being freshly created would look settled). Returns null when git can't
 * answer, so callers fail OPEN — a signal we can't verify is kept, not dropped.
 */
async function worktreeDirtyPaths(worktreePath: string): Promise<Set<string> | null> {
  const diff = await gitTry(['-C', worktreePath, 'diff', '--name-only', 'HEAD']);
  if (!diff.ok) return null;
  const paths = new Set(diff.stdout.split('\n').filter(Boolean));
  const untracked = await gitTry(['-C', worktreePath, 'ls-files', '--others', '--exclude-standard']);
  if (untracked.ok) for (const f of untracked.stdout.split('\n').filter(Boolean)) paths.add(f);
  return paths;
}

/**
 * P6 — lazy read-time reconciliation. A live edit signal means "uncommitted work
 * in progress on this path". With no daemon watching, the events that settle
 * signals (commit/merge) never fire, so a committed-or-reverted file's signal
 * would linger in the "editing now" view up to the TTL. At read time we settle any
 * signal whose path is no longer dirty in its task's worktree — zero background
 * work, and it also catches the edit-then-revert case that commit-detection can't.
 *
 * This is also the ONLY observer that can notice a settled path going dirty again
 * (a daemon-less session fires no events), so it reactivates those. Fails open:
 * signals for unknown slugs or unreadable worktrees are kept as-is.
 */
/**
 * The guard hook records BEFORE the tool writes the file, so a just-recorded
 * signal's path may not be dirty yet — verify only signals older than this.
 */
const RECONCILE_GRACE_MS = 15_000;

async function reconcileSignals(
  root: string,
  rows: SignalRow[],
  tasks: Task[],
  sessions: Map<string, HookSession>,
  watched: Map<string, string>,
): Promise<SignalRow[]> {
  if (rows.length === 0) return rows;
  const bySlug = new Map<string, SignalRow[]>();
  for (const r of rows) {
    const list = bySlug.get(r.slug);
    if (list) list.push(r);
    else bySlug.set(r.slug, [r]);
  }
  const kept: SignalRow[] = [];
  const settled: Array<{ slug: string; path: string }> = [];
  const revived: SignalRow[] = [];
  const orphaned: SignalRow[] = [];
  const now = Date.now();
  const settledAt = new Date().toISOString();
  await Promise.all(
    [...bySlug].map(async ([slug, slugRows]) => {
      // Root sessions have no task — their signals verify against the checkout
      // the session registered (usually the main repo root); fs-watch checkout
      // signals (`co-*`) verify against the watched checkout path.
      const checkRoot = tasks.find((t) => t.slug === slug)?.worktreePath ?? sessions.get(slug)?.root ?? watched.get(slug);
      // "Gone" and "can't read right now" are different, and conflating them is
      // what let a removed worktree hold every path forever (a `baton clean`
      // sweep pinned 791 paths; an older one sat "editing" for nine days). A
      // holder with no checkout to name, or whose checkout is off disk, can never
      // re-dirty anything — so erase it. Fail-open below stays for the case it
      // was meant for: a checkout that IS there but git can't answer for.
      if (!checkRoot || !existsSync(checkRoot)) {
        for (const r of slugRows) {
          // Grace still applies: the guard hook records before the write lands,
          // so a signal can legitimately precede its task appearing in tasks.json.
          if (now - Date.parse(r.at) < RECONCILE_GRACE_MS) kept.push(r);
          else orphaned.push(r);
        }
        return;
      }
      const dirty = await worktreeDirtyPaths(checkRoot);
      if (dirty === null) return void kept.push(...slugRows); // git failed → keep
      for (const r of slugRows) {
        if (dirty.has(r.path)) {
          if (r.settledAt) { r.settledAt = null; revived.push(r); } // back to work
          kept.push(r);
          continue;
        }
        // Not dirty. A just-recorded signal isn't settled — the guard hook records
        // BEFORE the tool writes the file, so the edit may not have landed yet.
        if (!r.settledAt && now - Date.parse(r.at) < RECONCILE_GRACE_MS) { kept.push(r); continue; }
        if (!r.settledAt) { r.settledAt = settledAt; settled.push({ slug: r.slug, path: r.path }); }
        kept.push(r);
      }
    }),
  );
  for (const s of settled) settleRows(root, s.slug, [s.path], settledAt);
  if (revived.length) reactivateRows(root, revived);
  if (orphaned.length) clearRows(root, orphaned);
  return kept;
}

export interface SignalOpts {
  /**
   * Include recently-settled signals ("finished editing 2m ago"). OFF by default:
   * every coordination caller (guard, check_files, the handoff brief) must only
   * ever see paths that are genuinely held, or it would tell agents to wait on
   * work that is already committed. Only the dashboard opts in. ISS-15.
   */
  includeSettled?: boolean;
}

/** Current edit signals, grouped by path; overlapping paths are warnings. */
export async function getSignals(
  root: string,
  windowMin = SIGNAL_WINDOW_MIN,
  opts: SignalOpts = {},
): Promise<EditSignal[]> {
  const tasks = await loadTasks(root);
  // Query the session/checkout registries once and thread them through reconcile
  // and attribution — both read them, and getSignals is on the 5s dashboard poll
  // (finding #6).
  const sessions = hookSessions(root);
  const watched = watchedRoots(root);
  // Reconcile sees settled rows regardless of `includeSettled` — it is the only
  // thing that can flip a re-dirtied path back to active. Filter at the output.
  const reconciled = await reconcileSignals(root, liveRows(root, windowMin), tasks, sessions, watched);
  const rows = opts.includeSettled ? reconciled : reconciled.filter((r) => !r.settledAt);
  const agents = await detectAgents(tasks.map((t) => t.worktreePath));
  // Reverse index: a checkout path → an agent name self-reported by a session
  // registered there, so fs-watch checkout signals (which see *what* changed,
  // not *who*) can borrow the agent name when one is known (ADD-07/A). Finding
  // #3: canonicalize the key (a session root and a watched-checkout path pointing
  // at the same dir must resolve — symlink, /var vs /private/var), and when two
  // sessions share a root, attribute to the most recently seen one instead of an
  // arbitrary last-writer-wins. Only sessions seen within the presence window
  // count: hookSessions() has no time filter, so a departed session would
  // otherwise keep mislabeling fresh signals at its old checkout indefinitely.
  // realpathSync is a blocking syscall and getSignals is on the 5s dashboard poll
  // and the guard's 1500ms budget path — memoize per call so the same handful of
  // roots is canonicalized once, not once per session/holder (finding #2).
  const canonCache = new Map<string, string>();
  const canonOf = (p: string | null | undefined): string | null => {
    if (!p) return null;
    let c = canonCache.get(p);
    if (c === undefined) canonCache.set(p, (c = canonicalRoot(p)!));
    return c;
  };
  const presenceCutoff = new Date(Date.now() - PRESENCE_WINDOW_MIN * 60_000).toISOString();
  const agentAtRoot = new Map<string, { agent: string | null; at: string }>();
  for (const s of sessions.values()) {
    if (s.at < presenceCutoff) continue; // departed session — don't attribute from it
    const canon = canonOf(s.root);
    if (!canon) continue;
    const prev = agentAtRoot.get(canon);
    if (!prev || prev.at < s.at) agentAtRoot.set(canon, { agent: s.agent, at: s.at });
  }
  const agentFor = (slug: string) => {
    const t = tasks.find((x) => x.slug === slug);
    if (t) return agents.get(t.worktreePath) ?? null;
    const sess = sessions.get(slug);
    if (sess) return sess.agent ?? null; // root session — self-reported by its hook
    const checkout = watched.get(slug);
    if (checkout) return agentAtRoot.get(canonOf(checkout)!)?.agent ?? null; // fs-watch signal — layer agent if a session is here
    return null;
  };

  const byPath = new Map<string, SignalHolder[]>();
  for (const r of rows) {
    if (!byPath.has(r.path)) byPath.set(r.path, []);
    byPath.get(r.path)!.push({
      slug: r.slug,
      agent: agentFor(r.slug),
      lastEditAt: r.at,
      state: r.settledAt ? 'settled' : 'active',
      ...(r.settledAt ? { settledAt: r.settledAt } : {}),
    });
  }
  // ADD-07/A finding #1 — collapse the fs-watch echo. In a plain checkout a
  // hooked/MCP session records an edit under its OWN slug AND the daemon's
  // recursive fs-watch records the same physical edit under the checkout slug
  // (`co-*`). Left as two holders that fabricates a conflict `warning` and makes
  // checkFiles flag the agent's own file busy. Drop a `co-*` holder on any path a
  // session registered at that same checkout already holds — the session holder
  // is strictly more informative (it knows *who* edited).
  for (const [path, holders] of byPath) {
    const sessionRoots = new Set<string>();
    for (const h of holders) {
      const canon = canonOf(sessions.get(h.slug)?.root);
      if (canon) sessionRoots.add(canon);
    }
    if (sessionRoots.size === 0) continue;
    const kept = holders.filter((h) => {
      const checkout = watched.get(h.slug);
      return !checkout || !sessionRoots.has(canonOf(checkout)!);
    });
    if (kept.length !== holders.length) byPath.set(path, kept);
  }
  enrichWithNotes(root, [...byPath.values()]);
  return [...byPath.entries()]
    .map(([path, holders]) => ({
      path,
      // Only sessions still HOLDING the path can collide — a settled holder has
      // let go, so pairing it with an active one is not a conflict (ISS-15).
      level:
        new Set(holders.filter((h) => h.state === 'active').map((h) => h.slug)).size >= 2
          ? ('warning' as const)
          : ('info' as const),
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
export async function checkFiles(
  root: string,
  paths: string[],
  excludeSlug?: string,
): Promise<Record<string, FileCheck>> {
  const signals = await getSignals(root);
  const tasks = await loadTasks(root);
  const agents = await detectAgents(tasks.map((t) => t.worktreePath));
  const changed = new Map<string, Set<string>>(); // slug → files
  await Promise.all(tasks.map(async (t) => changed.set(t.slug, await changedFiles(t, root))));
  const byPath = new Map(signals.map((s) => [s.path, s.holders]));

  const result: Record<string, FileCheck> = {};
  for (const p of paths) {
    // Drop the caller's own edits: an agent asking "is this busy?" means "busy
    // by someone ELSE" — its own signals are not a reason to wait.
    const holders: SignalHolder[] = (byPath.get(p) ?? []).filter((h) => h.slug !== excludeSlug);
    for (const t of tasks) {
      if (t.slug === excludeSlug) continue;
      if (changed.get(t.slug)?.has(p) && !holders.some((h) => h.slug === t.slug)) {
        holders.push({ slug: t.slug, agent: agents.get(t.worktreePath) ?? null, lastEditAt: '', state: 'active' });
      }
    }
    result[p] = { busy: holders.length > 0, by: holders };
  }
  enrichWithNotes(root, Object.values(result).map((r) => r.by)); // cover committed-but-unmerged holders too
  return result;
}
