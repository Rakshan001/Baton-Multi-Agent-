/**
 * Permanent storage purge — the "actually free my disk" operation behind the
 * dashboard's Danger Zone. Unlike `baton clean` (which only reclaims *orphans*),
 * this deletes whole data categories the user selects AND, crucially, reclaims
 * the git object store: it drops the hidden `refs/baton/archive/*` refs (created
 * by every merge) plus orphan `baton/*` branches and then runs `git gc
 * --prune=now`. Without that gc, deleting tasks leaves their commit objects
 * packed on disk forever — the usual "I deleted everything but storage didn't
 * shrink" surprise.
 *
 * Safety: this NEVER touches the user's source, main branch, non-`baton/*`
 * branches, or any branch with a live worktree. The HTTP layer additionally
 * gates it on --write, a loopback Origin (anti-CSRF), and a typed confirm phrase.
 */
import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { batonDir } from './store.js';
import { memoryDir, mainRepoRoot } from './memory.js';
import { loadKb } from './kb/state.js';
import { storageUsage, dirSize } from './storage.js';
import { closeHistoryDb } from './history.js';
import { closeReportsDb } from './reports.js';
import {
  listArchiveRefs, deleteRef, gitGc, objectStoreBytes,
  listBatonBranches, listWorktrees, deleteBranch,
} from './git.js';

export type PurgeCategory = 'archives' | 'history' | 'reports' | 'graphs' | 'tmp' | 'memory';

/** All valid categories, in the order the UI lists them (safest → most precious). */
export const PURGE_CATEGORIES: PurgeCategory[] = ['archives', 'history', 'reports', 'graphs', 'tmp', 'memory'];

export interface PurgeItem {
  category: PurgeCategory;
  label: string;
  /** Best-effort bytes this category occupies (archives → current git object store). */
  bytes: number;
  /** Items inside (facts / reports / graphs / refs+branches). */
  count: number;
  /** Irreversible knowledge loss vs. trivially rebuildable. */
  destructive: boolean;
  detail: string;
  /** Extra red warning shown in the UI (knowledge base). */
  warning?: string;
}

export interface PurgePreview {
  root: string;
  repo: string;
  /** Exactly what the user must type to confirm (shown in the UI). */
  confirmPhrase: string;
  /** Current loose+packed git object bytes (what an `archives` purge can reclaim). */
  gitObjectBytes: number;
  items: PurgeItem[];
}

export interface PurgeResult {
  deleted: { category: PurgeCategory; count: number }[];
  freedBytes: number;
  gcRan: boolean;
}

export function confirmPhraseFor(repo: string): string {
  return `purge ${repo}`;
}

function isValidCategory(c: unknown): c is PurgeCategory {
  return typeof c === 'string' && (PURGE_CATEGORIES as string[]).includes(c);
}

/** Keep only valid, de-duplicated categories from untrusted input. */
export function sanitizeCategories(input: unknown): PurgeCategory[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.filter(isValidCategory))];
}

/** Orphan `baton/*` branches = baton branches with no live worktree (safe to drop). */
async function orphanBatonBranches(mainRoot: string): Promise<string[]> {
  const [branches, worktrees] = await Promise.all([listBatonBranches(mainRoot), listWorktrees(mainRoot)]);
  const live = new Set(worktrees.map((w) => w.branch).filter(Boolean) as string[]);
  return branches.filter((b) => !live.has(b));
}

/** Total Baton-owned bytes on disk (data stores + git object store). */
async function footprintBytes(mainRoot: string): Promise<number> {
  const usage = await storageUsage(mainRoot);
  const tmp = await dirSize(join(batonDir(mainRoot), 'tmp'));
  const objects = await objectStoreBytes(mainRoot);
  return usage.total + tmp.bytes + objects;
}

/** What a purge would delete, per category, with sizes — drives the Danger Zone UI. */
export async function purgePreview(root: string): Promise<PurgePreview> {
  const mainRoot = await mainRepoRoot(root);
  const repo = basename(mainRoot);
  const usage = await storageUsage(mainRoot);
  const tmp = await dirSize(join(batonDir(mainRoot), 'tmp'));
  const [archiveRefs, orphans, gitObjectBytes] = await Promise.all([
    listArchiveRefs(mainRoot),
    orphanBatonBranches(mainRoot),
    objectStoreBytes(mainRoot),
  ]);

  const items: PurgeItem[] = [
    {
      category: 'archives', label: 'Completed-task git history', bytes: gitObjectBytes,
      count: archiveRefs.length + orphans.length, destructive: true,
      detail: `${archiveRefs.length} archived merge ref(s) + ${orphans.length} orphan branch(es), then git gc to reclaim packed objects`,
    },
    {
      category: 'history', label: 'History index (history.db)', bytes: usage.history.bytes,
      count: usage.history.bytes > 0 ? 1 : 0, destructive: true,
      detail: 'queryable merge/commit index — rebuildable from git history',
    },
    {
      category: 'reports', label: 'Completion reports', bytes: usage.reports.bytes,
      count: usage.reports.count, destructive: true,
      detail: `${usage.reports.count} merged-task report file(s)`,
    },
    {
      category: 'graphs', label: 'Knowledge graphs', bytes: usage.graphsTotal,
      count: usage.graphs.length, destructive: false,
      detail: 'graphify graphs — rebuildable with `baton kb rebuild`',
    },
    {
      category: 'tmp', label: 'Temp / upload staging', bytes: tmp.bytes,
      count: tmp.files, destructive: false,
      detail: 'leftover upload + atomic-write temp files',
    },
    {
      category: 'memory', label: 'Shared memory (knowledge base)', bytes: usage.memory.bytes,
      count: usage.memory.facts, destructive: true,
      detail: `${usage.memory.facts} evidence-anchored fact(s)`,
      warning: 'This is your shared knowledge base — agents lose every saved fact. There is no undo.',
    },
  ];

  return { root: mainRoot, repo, confirmPhrase: confirmPhraseFor(repo), gitObjectBytes, items };
}

/** Permanently delete the selected categories and reclaim disk. Categories must
 *  already be sanitized by the caller (sanitizeCategories). */
export async function purgeStorage(root: string, categories: PurgeCategory[]): Promise<PurgeResult> {
  const mainRoot = await mainRepoRoot(root);
  const set = new Set(categories);
  const baton = batonDir(mainRoot);
  const before = await footprintBytes(mainRoot);
  const deleted: { category: PurgeCategory; count: number }[] = [];

  if (set.has('graphs')) {
    const kb = await loadKb(mainRoot).catch(() => null);
    let count = 0;
    if (kb) {
      for (const p of kb.projects) { await rm(join(p.path, 'graphify-out'), { recursive: true, force: true }); count++; }
      if (kb.mergedGraphPath) { await rm(kb.mergedGraphPath, { force: true }); count++; }
    }
    deleted.push({ category: 'graphs', count });
  }

  if (set.has('reports')) {
    await rm(join(baton, 'reports'), { recursive: true, force: true });
    deleted.push({ category: 'reports', count: 1 });
  }

  if (set.has('history')) {
    // Release both handles to the shared history.db before unlinking it.
    closeHistoryDb(mainRoot);
    closeReportsDb(mainRoot);
    for (const f of ['history.db', 'history.db-wal', 'history.db-shm']) {
      await rm(join(baton, f), { force: true });
    }
    deleted.push({ category: 'history', count: 1 });
  }

  if (set.has('memory')) {
    await rm(memoryDir(mainRoot), { recursive: true, force: true });
    deleted.push({ category: 'memory', count: 1 });
  }

  if (set.has('tmp')) {
    await rm(join(baton, 'tmp'), { recursive: true, force: true });
    deleted.push({ category: 'tmp', count: 1 });
  }

  let gcRan = false;
  if (set.has('archives')) {
    const refs = await listArchiveRefs(mainRoot);
    for (const ref of refs) await deleteRef(ref, mainRoot);
    const orphans = await orphanBatonBranches(mainRoot);
    for (const b of orphans) await deleteBranch(b, mainRoot);
    gcRan = await gitGc(mainRoot); // reclaims the now-unreachable objects
    deleted.push({ category: 'archives', count: refs.length + orphans.length });
  }

  const after = await footprintBytes(mainRoot);
  return { deleted, freedBytes: Math.max(0, before - after), gcRan };
}
