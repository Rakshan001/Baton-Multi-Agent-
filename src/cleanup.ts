/**
 * Junk detection + reclaim: orphaned worktrees, branches, tmux sessions, and
 * leaked temp files. One read-only audit (`auditJunk`), one fix (`cleanJunk`).
 *
 * Safety model (enforced here, mirrored at the CLI/API):
 *  - `auditJunk` NEVER mutates. `cleanJunk` only deletes when `apply: true`.
 *  - A worktree with uncommitted changes is reported `blocked: 'dirty'` and
 *    skipped unless `force: true`.
 *  - A `.tmp` file is reclaimed only when its writer pid is dead AND it's old —
 *    a live atomic write is never touched.
 *  - The main worktree is never a candidate.
 *
 * Detectors are pure over their inputs (testable without I/O); `auditJunk` does
 * the I/O and feeds them. Reclaim reuses the existing teardown paths
 * (removeTaskWorktree / removeWorktree / killSessionFor) rather than re-rolling.
 */
import { existsSync } from 'node:fs';
import { readdir, rm, rmdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  deleteBranch, listBatonBranches, listWorktrees, removeWorktree, worktreeStatus,
  type WorktreeEntry,
} from './git.js';
import { batonDir, loadTasks, type Task } from './store.js';
import { detectTmux, killSessionFor, listSessions, repoPrefix, slugFromSession } from './util/tmux.js';
import {
  DirtyWorktreeError, MainWorktreeError, removeTaskWorktree,
} from './commands/rm.js';
import { TaskNotFoundError } from './store.js';

export type JunkKind =
  | 'orphan-worktree-task' // tasks.json entry whose worktree dir is gone
  | 'orphan-worktree-disk' // baton/* worktree on disk with no tasks.json entry
  | 'orphan-branch'        // baton/* branch with no task and no live worktree
  | 'orphan-tmux'          // baton-<hash>-<slug> session whose task is gone
  | 'tmp-file'             // leaked *.tmp from a crashed atomic write
  | 'tmp-upload';          // stale file under .baton/tmp/

export interface JunkItem {
  kind: JunkKind;
  /** slug / branch / session name / filename — the thing to act on. */
  id: string;
  path: string | null;
  reason: string;
  action: string;
  /** Set when a fix would refuse this item (and why). */
  blocked?: 'dirty' | 'main-worktree' | null;
  bytes?: number | null;
  /** Branch to delete for worktree/branch kinds. */
  branch?: string;
}

export interface AuditReport {
  items: JunkItem[];
  scannedAt: string;
  counts: Record<JunkKind, number>;
}

export interface CleanResult {
  applied: boolean;
  removed: JunkItem[];
  skipped: { item: JunkItem; why: string }[];
}

/* ------------------------------------------------------------------ */
/* Pure detectors (unit-tested without I/O)                            */
/* ------------------------------------------------------------------ */

const isBatonWorktree = (root: string, e: WorktreeEntry): boolean => {
  const wtRoot = resolve(batonDir(root), 'wt');
  return resolve(e.path).startsWith(wtRoot + '/') || (e.branch?.startsWith('baton/') ?? false);
};

/**
 * Both-direction worktree reconciliation. `existsOnDisk(absPath)` lets tests
 * inject filesystem state. The main worktree is excluded by resolve-compare.
 */
export function auditWorktrees(
  root: string,
  tasks: Task[],
  worktrees: WorktreeEntry[],
  existsOnDisk: (absPath: string) => boolean,
): JunkItem[] {
  const items: JunkItem[] = [];
  const mainPath = resolve(root);
  const taskByPath = new Map(tasks.map((t) => [resolve(t.worktreePath), t]));

  // tasks.json entry whose worktree dir vanished.
  for (const t of tasks) {
    if (!existsOnDisk(t.worktreePath)) {
      items.push({
        kind: 'orphan-worktree-task', id: t.slug, path: t.worktreePath, branch: t.branch,
        reason: 'recorded task, but its worktree directory no longer exists',
        action: 'remove the stale task entry + its branch',
      });
    }
  }
  // A baton/* worktree on disk that no task references.
  for (const e of worktrees) {
    if (resolve(e.path) === mainPath) continue;
    if (!isBatonWorktree(root, e)) continue;
    if (taskByPath.has(resolve(e.path))) continue;
    items.push({
      kind: 'orphan-worktree-disk', id: basename(e.path), path: e.path, branch: e.branch ?? '',
      reason: 'baton worktree on disk with no matching task (interrupted create/remove)',
      action: 'remove the worktree + its branch',
    });
  }
  return items;
}

/** A `baton/*` branch is junk only when no task AND no live worktree backs it. */
export function auditBranches(branches: string[], tasks: Task[], worktrees: WorktreeEntry[]): JunkItem[] {
  const taskBranches = new Set(tasks.map((t) => t.branch));
  const liveBranches = new Set(worktrees.map((w) => w.branch).filter(Boolean) as string[]);
  return branches
    .filter((b) => !taskBranches.has(b) && !liveBranches.has(b))
    .map((b) => ({
      kind: 'orphan-branch' as const, id: b, path: null, branch: b,
      reason: 'baton branch with no task and no live worktree',
      action: 'delete the branch',
    }));
}

/** A repo tmux session whose slug has no task is a ghost (reattachOrphans adopts it forever). */
export function auditTmux(root: string, sessions: string[], tasks: Task[]): JunkItem[] {
  const slugs = new Set(tasks.map((t) => t.slug));
  const items: JunkItem[] = [];
  for (const name of sessions) {
    const slug = slugFromSession(root, name);
    if (slug && !slugs.has(slug)) {
      items.push({
        kind: 'orphan-tmux', id: slug, path: null,
        reason: `tmux session '${name}' with no matching task`,
        action: 'kill the tmux session',
      });
    }
  }
  return items;
}

const TMP_DEAD_AGE_MS = 10 * 60_000;  // dead writer pid: reclaim after 10 min
const TMP_NOPID_AGE_MS = 60 * 60_000; // can't tell the writer: be cautious, 60 min

/** Default liveness probe: signal 0 throws ESRCH for a dead pid, EPERM for a live foreign one. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists but not ours
  }
}

/**
 * Is a leftover `*.tmp` safe to delete? Only when its writer is gone and it's
 * old enough that no in-flight rename is mid-way. Pure — inject `now`/probe.
 * Filename schemes: `tasks.json.<pid>.tmp`, `.<id>.<pid>.tmp`.
 */
export function isReclaimableTmp(
  name: string,
  mtimeMs: number,
  now: number,
  isPidAlive: (pid: number) => boolean = pidAlive,
): boolean {
  if (!name.endsWith('.tmp')) return false;
  const ageMs = now - mtimeMs;
  const pidStr = name.slice(0, -'.tmp'.length).split('.').pop() ?? '';
  if (/^\d+$/.test(pidStr)) {
    const pid = Number(pidStr);
    return !isPidAlive(pid) && ageMs > TMP_DEAD_AGE_MS;
  }
  return ageMs > TMP_NOPID_AGE_MS; // unparseable pid → age-only, longer threshold
}

/* ------------------------------------------------------------------ */
/* I/O-backed audit                                                    */
/* ------------------------------------------------------------------ */

async function scanTmpDir(dir: string, kind: 'tmp-file' | 'tmp-upload', now: number, all: boolean): Promise<JunkItem[]> {
  if (!existsSync(dir)) return [];
  const items: JunkItem[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const file = join(dir, name);
    let st;
    try { st = await stat(file); } catch { continue; }
    if (!st.isFile()) continue;
    // tmp-file kind: only true `.tmp`; tmp-upload: every file in .baton/tmp/ past the age gate.
    const reclaimable = kind === 'tmp-file'
      ? isReclaimableTmp(name, st.mtimeMs, now)
      : (all || now - st.mtimeMs > TMP_DEAD_AGE_MS);
    if (!reclaimable) continue;
    items.push({
      kind, id: name, path: file, bytes: st.size,
      reason: kind === 'tmp-file' ? 'leaked temp file from an interrupted write' : 'stale upload artifact',
      action: 'delete the file',
    });
  }
  return items;
}

async function auditTmpFiles(root: string, now: number): Promise<JunkItem[]> {
  const dir = batonDir(root);
  const [top, facts] = await Promise.all([
    scanTmpDir(dir, 'tmp-file', now, false),
    scanTmpDir(join(dir, 'memory', 'facts'), 'tmp-file', now, false),
  ]);
  return [...top, ...facts];
}

const auditTmpUploads = (root: string, now: number): Promise<JunkItem[]> =>
  scanTmpDir(join(batonDir(root), 'tmp'), 'tmp-upload', now, false);

export async function auditJunk(root: string, now = Date.now()): Promise<AuditReport> {
  const tasks = await loadTasks(root);
  const worktrees = await listWorktrees(root);
  const [branches, sessions, tmpFiles, tmpUploads] = await Promise.all([
    listBatonBranches(root),
    detectTmux().then((ok) => (ok ? listSessions() : [])),
    auditTmpFiles(root, now),
    auditTmpUploads(root, now),
  ]);

  const worktreeItems = auditWorktrees(root, tasks, worktrees, existsSync);
  // Enrich worktree items with a dirty check so the report (and dry-run) can
  // show what a fix would refuse — keeps the pure detector I/O-free.
  for (const item of worktreeItems) {
    if (item.path && existsSync(item.path)) {
      const st = await worktreeStatus(item.path);
      if (st.state !== 'clean') item.blocked = 'dirty';
    }
  }

  const items = [
    ...worktreeItems,
    ...auditBranches(branches, tasks, worktrees),
    ...auditTmux(root, sessions, tasks),
    ...tmpFiles,
    ...tmpUploads,
  ];

  const counts = {
    'orphan-worktree-task': 0, 'orphan-worktree-disk': 0, 'orphan-branch': 0,
    'orphan-tmux': 0, 'tmp-file': 0, 'tmp-upload': 0,
  } as Record<JunkKind, number>;
  for (const it of items) counts[it.kind]++;

  return { items, scannedAt: new Date(now).toISOString(), counts };
}

/* ------------------------------------------------------------------ */
/* Reclaim                                                             */
/* ------------------------------------------------------------------ */

async function reclaim(root: string, item: JunkItem, force: boolean): Promise<void> {
  switch (item.kind) {
    case 'orphan-worktree-task':
      // removeTaskWorktree handles tmux + worktree + branch + store + its own
      // dirty guard (throws DirtyWorktreeError, which we surface as skipped).
      await removeTaskWorktree(item.id, { force }, root);
      return;
    case 'orphan-worktree-disk':
      if (item.path && existsSync(item.path)) {
        if (!force && (await worktreeStatus(item.path)).state !== 'clean') {
          throw new DirtyWorktreeError(item.id, 'dirty');
        }
      }
      await removeWorktree(item.path ?? '', item.branch ?? '', root);
      return;
    case 'orphan-branch':
      await deleteBranch(item.branch ?? item.id, root);
      return;
    case 'orphan-tmux':
      await killSessionFor(root, item.id);
      return;
    case 'tmp-file':
    case 'tmp-upload':
      if (item.path) await rm(item.path, { force: true });
      return;
  }
}

export async function cleanJunk(
  root: string,
  report: AuditReport,
  opts: { apply: boolean; force?: boolean },
): Promise<CleanResult> {
  const removed: JunkItem[] = [];
  const skipped: { item: JunkItem; why: string }[] = [];

  for (const item of report.items) {
    if (item.blocked === 'main-worktree') {
      skipped.push({ item, why: 'main worktree — never removed' });
      continue;
    }
    if (item.blocked === 'dirty' && !opts.force) {
      skipped.push({ item, why: 'uncommitted changes — re-run with --force' });
      continue;
    }
    if (!opts.apply) {
      removed.push(item); // dry-run: this is what WOULD be removed
      continue;
    }
    try {
      await reclaim(root, item, !!opts.force);
      removed.push(item);
    } catch (e) {
      if (e instanceof DirtyWorktreeError) skipped.push({ item, why: 'uncommitted changes — re-run with --force' });
      else if (e instanceof MainWorktreeError) skipped.push({ item, why: 'main worktree — never removed' });
      else if (e instanceof TaskNotFoundError) skipped.push({ item, why: 'already gone' });
      else skipped.push({ item, why: (e as Error).message });
    }
  }
  return { applied: !!opts.apply, removed, skipped };
}

/**
 * Conservative startup sweep: delete ONLY provably-dead temp files + stale
 * uploads. Never touches worktrees/branches/tmux. Best-effort; returns count.
 */
export async function sweepTmpFiles(root: string, now = Date.now()): Promise<number> {
  const items = [...await auditTmpFiles(root, now), ...await auditTmpUploads(root, now)];
  let n = 0;
  for (const item of items) {
    if (!item.path) continue;
    try { await rm(item.path, { force: true }); n++; } catch { /* ignore */ }
  }
  // Drop the now-empty upload dir (non-recursive: harmless if an upload is live).
  await rmdir(join(batonDir(root), 'tmp')).catch(() => undefined);
  return n;
}
