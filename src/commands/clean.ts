/**
 * `baton clean` — worktree GC (W1). Agents create ad-hoc worktrees (their own
 * `git worktree add`) and merge via GitHub PRs, so nothing ever removes the
 * working trees: a real hub accumulated 60+ of them (~13GB, ~90% for branches
 * already merged) — dead disk that also poisons every broad search with dozens
 * of duplicate copies of each file.
 *
 * Survey → classify → (optionally) remove. Safety rules, in order:
 *   - the main checkout is never touched
 *   - dirty trees are never touched (uncommitted work is sacred)
 *   - unmerged branches are never touched (unshipped commits)
 *   - locked trees are never touched (someone said keep)
 *   - branches are NEVER deleted — only working trees; history stays intact
 *   - removal uses `git worktree remove` WITHOUT --force, so git itself is the
 *     final safety net even if our dirty check raced an edit
 *
 * Dry-run by default; `--apply` performs the removal.
 */
import { resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { execa } from 'execa';
import { gitTry } from '../util/exec.js';
import { loadKb } from '../kb/state.js';
import { loadTasks, removeTask, resolveBatonRoot } from '../store.js';
import { bus } from '../events.js';

export interface WorktreeEntry {
  path: string;
  head: string | null;
  /** Branch short name, or null when detached. */
  branch: string | null;
  locked: boolean;
  /** git says the tree is already gone from disk — registration cleanup only. */
  prunable: boolean;
}

/** Parse `git worktree list --porcelain` output. Pure → unit-tested. */
export function parseWorktreePorcelain(out: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) entries.push(cur);
      cur = { path: line.slice('worktree '.length), head: null, branch: null, locked: false, prunable: false };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '').trim();
    } else if (line === 'locked' || line.startsWith('locked ')) {
      cur.locked = true;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      cur.prunable = true;
    }
  }
  if (cur) entries.push(cur);
  return entries;
}

export type CleanDecision =
  | 'keep-main'
  | 'removable'
  | 'skip-dirty'
  | 'skip-unmerged'
  | 'skip-locked'
  | 'prunable';

/** The safety matrix. Pure → unit-tested. Order encodes precedence. */
export function decideWorktree(input: {
  isMain: boolean;
  merged: boolean;
  dirty: boolean;
  locked: boolean;
  prunable: boolean;
}): CleanDecision {
  if (input.isMain) return 'keep-main';
  if (input.prunable) return 'prunable';
  if (input.locked) return 'skip-locked';
  if (input.dirty) return 'skip-dirty';
  if (!input.merged) return 'skip-unmerged';
  return 'removable';
}

export interface SurveyEntry extends WorktreeEntry {
  decision: CleanDecision;
  /** Bytes on disk — computed only for removable trees (du is not free). */
  sizeBytes?: number;
}

/**
 * The ref merged work must be an ancestor of. Prefers origin/<default> —
 * agents merge via PRs, so origin/main moves while the local main checkout
 * may sit on an old feature branch. Falls back to local main/master; null
 * (→ everything counts as unmerged, fail safe) when nothing resolves.
 */
async function mergeTarget(repoPath: string): Promise<string | null> {
  const sym = await gitTry(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoPath);
  if (sym.ok && sym.stdout.trim()) return sym.stdout.trim();
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    const r = await gitTry(['rev-parse', '--verify', '--quiet', ref], repoPath);
    if (r.ok && r.stdout.trim()) return ref;
  }
  return null;
}

async function isDirty(worktreePath: string): Promise<boolean> {
  // status --porcelain covers modified AND untracked — `git worktree remove`
  // refuses on either, so classify the same way.
  const r = await gitTry(['status', '--porcelain'], worktreePath);
  return r.ok ? r.stdout.trim().length > 0 : true; // unreadable → treat as dirty (fail safe)
}

async function duBytes(path: string): Promise<number | undefined> {
  try {
    const { stdout } = await execa('du', ['-sk', path]);
    const kb = parseInt(stdout.trim().split(/\s+/)[0] ?? '', 10);
    return Number.isFinite(kb) ? kb * 1024 : undefined;
  } catch {
    return undefined;
  }
}

/** Survey every worktree registered on one repo. Empty for non-repos (fail safe). */
export async function surveyRepoWorktrees(repoPath: string): Promise<SurveyEntry[]> {
  const list = await gitTry(['worktree', 'list', '--porcelain'], repoPath);
  if (!list.ok) return [];
  const entries = parseWorktreePorcelain(list.stdout);
  if (entries.length === 0) return [];
  const target = await mergeTarget(repoPath);

  const out: SurveyEntry[] = [];
  for (const [i, e] of entries.entries()) {
    // git guarantees the main worktree is listed first; belt-and-braces with a path check.
    const isMain = i === 0 || resolve(e.path) === resolve(repoPath);
    let merged = false;
    if (!isMain && !e.prunable && target && e.head) {
      merged = (await gitTry(['merge-base', '--is-ancestor', e.head, target], repoPath)).ok;
    }
    const dirty = isMain || e.prunable ? false : await isDirty(e.path);
    const decision = decideWorktree({ isMain, merged, dirty, locked: e.locked, prunable: e.prunable });
    const sizeBytes = decision === 'removable' ? await duBytes(e.path) : undefined;
    out.push({ ...e, decision, sizeBytes });
  }
  return out;
}

export interface CleanResult {
  removed: string[];
  failed: Array<{ path: string; error: string }>;
}

/**
 * Remove every `removable` tree from the survey, then prune stale
 * registrations. No --force: if anything changed since the survey (a race
 * with a live agent), git refuses and the tree lands in `failed` untouched.
 */
export async function applyClean(repoPath: string, survey: SurveyEntry[]): Promise<CleanResult> {
  const removed: string[] = [];
  const failed: CleanResult['failed'] = [];
  for (const e of survey) {
    if (e.decision !== 'removable') continue;
    const r = await gitTry(['worktree', 'remove', e.path], repoPath);
    if (r.ok) removed.push(e.path);
    else failed.push({ path: e.path, error: r.stderr.trim() || 'git worktree remove failed' });
  }
  if (survey.some((e) => e.decision === 'prunable')) {
    await gitTry(['worktree', 'prune'], repoPath);
  }
  return { removed, failed };
}

const fmtSize = (bytes?: number): string =>
  bytes === undefined ? '?' : bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(1)}G` : `${Math.round(bytes / (1 << 20))}M`;

const DECISION_LABEL: Record<CleanDecision, string> = {
  'keep-main': 'main checkout',
  removable: 'REMOVABLE (branch merged, tree clean)',
  'skip-dirty': 'kept — uncommitted changes',
  'skip-unmerged': 'kept — branch not merged',
  'skip-locked': 'kept — locked',
  prunable: 'stale registration (folder already gone)',
};

/** The worktree-GC half of `baton clean` — dry-run survey across every kb project + the root repo. */
export async function worktreeGcCmd(opts: { apply?: boolean; json?: boolean } = {}): Promise<void> {
  const root = await resolveBatonRoot();
  const kb = await loadKb(root);
  // Hub: each project repo owns its worktrees. Single repo: the root itself.
  const repoPaths = kb && kb.projects.length > 0 ? kb.projects.map((p) => p.path) : [root];

  const surveys: Array<{ repo: string; entries: SurveyEntry[] }> = [];
  for (const repo of repoPaths) {
    surveys.push({ repo, entries: await surveyRepoWorktrees(repo) });
  }

  const removable = surveys.flatMap((s) => s.entries.filter((e) => e.decision === 'removable'));
  const reclaimable = removable.reduce((n, e) => n + (e.sizeBytes ?? 0), 0);

  if (opts.json) {
    console.log(JSON.stringify({ surveys, reclaimableBytes: reclaimable, applied: !!opts.apply }, null, 2));
    if (!opts.apply) return;
  } else {
    for (const s of surveys) {
      const interesting = s.entries.filter((e) => e.decision !== 'keep-main');
      if (interesting.length === 0) continue;
      console.log(`\n${s.repo}`);
      for (const e of interesting) {
        const size = e.decision === 'removable' ? `  ${fmtSize(e.sizeBytes)}` : '';
        console.log(`  ${e.decision === 'removable' ? '✂' : '·'} ${e.path}${size}  [${e.branch ?? 'detached'}] — ${DECISION_LABEL[e.decision]}`);
      }
    }
    console.log(`\n${removable.length} worktree(s) removable, ~${fmtSize(reclaimable)} reclaimable.`);
    if (!opts.apply) {
      if (removable.length > 0) console.log('Dry run — nothing removed. Re-run `baton clean --fix` to remove them (branches are kept).');
      return;
    }
  }

  // --apply: remove trees, then drop any baton task whose worktree went away.
  // Canonicalize task paths BEFORE removal (git reports canonical paths, e.g.
  // macOS /var → /private/var; realpath only works while the tree exists).
  const tasks = await loadTasks(root);
  const taskByPath = new Map<string, string>();
  for (const t of tasks) {
    taskByPath.set(resolve(t.worktreePath), t.slug);
    try { taskByPath.set(await realpath(t.worktreePath), t.slug); } catch { /* already gone */ }
  }
  let removedCount = 0;
  for (const s of surveys) {
    const result = await applyClean(s.repo, s.entries);
    removedCount += result.removed.length;
    for (const p of result.removed) {
      const slug = taskByPath.get(resolve(p));
      if (slug) {
        await removeTask(root, slug);
        bus.publish({ type: 'task.removed', slug });
      }
      if (!opts.json) console.log(`✓ removed ${p}`);
    }
    for (const f of result.failed) {
      if (!opts.json) console.log(`✗ skipped ${f.path} — ${f.error}`);
    }
  }
  if (!opts.json) console.log(`\nDone: ${removedCount} worktree(s) removed, ~${fmtSize(reclaimable)} reclaimed. Branches untouched.`);
}
