/**
 * On-disk footprint of a Baton workspace, for the dashboard's storage view.
 * Breaks `.baton/` + the graphify graphs into the buckets that actually grow:
 *
 *   - memory   — one markdown file per fact (hard-capped ~600KB)
 *   - history  — .baton/history.db (append-only sqlite — the one unbounded store)
 *   - reports  — .baton/reports/*.md (one per merged task)
 *   - graphs   — graphify-out/ per kb sub-project + the merged graph
 *
 * Read-only and best-effort: a missing/locked path contributes 0, never throws.
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { memoryDir, mainRepoRoot } from './memory.js';
import { loadKb } from './kb/state.js';

export interface StorageBucket { id: string; label: string; bytes: number; count?: number }
export interface StorageBreakdown {
  root: string;
  memory: { bytes: number; facts: number };
  history: { bytes: number };
  reports: { bytes: number; count: number };
  graphs: StorageBucket[];
  graphsTotal: number;
  total: number;
}

/** Recursive directory size (bytes) + file count. Symlinks are not followed. */
async function dirSize(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0, files = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { bytes: 0, files: 0 };
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    try {
      if (e.isDirectory()) {
        const sub = await dirSize(p);
        bytes += sub.bytes; files += sub.files;
      } else if (e.isFile()) {
        bytes += (await stat(p)).size; files += 1;
      }
    } catch { /* raced delete / permission — skip */ }
  }
  return { bytes, files };
}

async function fileSize(path: string): Promise<number> {
  // stat-and-catch (matches dirSize) — one syscall, and a raced delete → 0.
  try { return (await stat(path)).size; } catch { return 0; }
}

export async function storageUsage(root: string): Promise<StorageBreakdown> {
  const mainRoot = await mainRepoRoot(root);
  const baton = join(mainRoot, '.baton');

  const mem = await dirSize(memoryDir(mainRoot));
  const history = await fileSize(join(baton, 'history.db'));
  const reports = await dirSize(join(baton, 'reports'));

  const graphs: StorageBucket[] = [];
  const kb = await loadKb(mainRoot).catch(() => null);
  if (kb) {
    for (const p of kb.projects) {
      const g = await dirSize(join(p.path, 'graphify-out'));
      if (g.bytes > 0) graphs.push({ id: p.id, label: p.name, bytes: g.bytes, count: g.files });
    }
    if (kb.mergedGraphPath) {
      const bytes = await fileSize(kb.mergedGraphPath);
      if (bytes > 0) graphs.push({ id: 'merged', label: 'Merged graph', bytes });
    }
  }
  const graphsTotal = graphs.reduce((n, g) => n + g.bytes, 0);

  return {
    root: mainRoot,
    memory: { bytes: mem.bytes, facts: mem.files },
    history: { bytes: history },
    reports: { bytes: reports.bytes, count: reports.files },
    graphs,
    graphsTotal,
    total: mem.bytes + history + reports.bytes + graphsTotal,
  };
}
