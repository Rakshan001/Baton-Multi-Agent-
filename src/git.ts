/**
 * Local git worktree helpers for Baton's tiny v0.
 *
 * Logic adapted from handler.dev's backend-agnostic worktree service
 * (.refs/handler.dev/packages/server/src/services/worktree.ts, MIT) — rewritten
 * to run git locally via execa instead of through a Docker/SSH CommandRunner,
 * and to derive state from git itself rather than an in-memory record.
 *
 * Worktree create/remove robustness (collision-aware naming, prune-on-orphan,
 * retry-on-busy) and in-progress repo-state detection are adapted from
 * daintree's WorkspaceService (.refs/daintree/electron/workspace-host/
 * WorkspaceService.ts, Apache-2.0). The porcelain-v2 conflict parser + labels
 * are adapted from daintree's porcelainConflicts
 * (.refs/daintree/electron/services/git/porcelainConflicts.ts, Apache-2.0).
 * See NOTICE.
 */
import { stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { git, gitTry } from './util/exec.js';

export type RepoState = 'clean' | 'merging' | 'rebasing' | 'cherry-picking' | 'reverting';

export interface ConflictEntry {
  path: string;
  xy: string; // porcelain v2 unmerged code, e.g. "UU"
  label: string; // human label, e.g. "both modified"
}

export interface WorktreeStatus {
  state: 'clean' | 'dirty' | 'conflict';
  repoState: RepoState;
  changedFiles: string[];
  conflictFiles: string[];
  conflictDetails: ConflictEntry[];
  insertions: number;
  deletions: number;
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  head: string | null;
}

/** Absolute path of the repo's top level (throws if not in a git repo). */
export async function gitRoot(cwd?: string): Promise<string> {
  try {
    return await git(['rev-parse', '--show-toplevel'], cwd);
  } catch {
    throw new Error('Not inside a git repository.');
  }
}

/**
 * The MAIN repository root, even when `cwd` is inside a task worktree
 * (`gitRoot()` would return the worktree). Resolved via `--git-common-dir`,
 * which points every worktree back at the shared `.git`. Throws if not in a
 * git repo.
 */
export async function mainRepoRoot(cwd?: string): Promise<string> {
  const common = await git(['rev-parse', '--git-common-dir'], cwd);
  const abs = isAbsolute(common) ? common : resolve(cwd ?? process.cwd(), common);
  return dirname(abs);
}

/**
 * Current branch name (e.g. "main"), or "HEAD" if detached. Tolerant of an
 * unborn HEAD (a fresh `git init` with no commits yet): `rev-parse` fails there,
 * so fall back to `symbolic-ref` which still reports the pending branch ("main").
 */
export async function currentBranch(cwd?: string): Promise<string> {
  const r = await gitTry(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (r.ok && r.stdout && r.stdout !== 'HEAD') return r.stdout;
  const s = await gitTry(['symbolic-ref', '--short', 'HEAD'], cwd);
  if (s.ok && s.stdout) return s.stdout;
  return r.ok && r.stdout ? r.stdout : 'HEAD';
}

/** True if `cwd` is inside a git work tree. Never throws. */
export async function isGitRepo(cwd?: string): Promise<boolean> {
  const r = await gitTry(['rev-parse', '--is-inside-work-tree'], cwd);
  return r.ok && r.stdout === 'true';
}

/** Short HEAD commit hash, or null if the repo has no commits yet. */
export async function headCommit(cwd?: string): Promise<string | null> {
  const r = await gitTry(['rev-parse', '--short', 'HEAD'], cwd);
  return r.ok ? r.stdout : null;
}

/** True if a local branch with this exact name already exists. */
export async function branchExists(branch: string, cwd?: string): Promise<boolean> {
  const r = await gitTry(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], cwd);
  return r.ok;
}

/** All local `baton/*` branch names (e.g. `baton/fix-login`). For orphan detection. */
export async function listBatonBranches(cwd?: string): Promise<string[]> {
  const r = await gitTry(['for-each-ref', '--format=%(refname:short)', 'refs/heads/baton/'], cwd);
  return r.ok && r.stdout ? r.stdout.split('\n').filter(Boolean) : [];
}

/** Delete a local branch (force). Best-effort, never throws. */
export async function deleteBranch(branch: string, cwd?: string): Promise<boolean> {
  return (await gitTry(['branch', '-D', branch], cwd)).ok;
}

/** All registered worktrees, parsed from `git worktree list --porcelain`. */
export async function listWorktrees(cwd?: string): Promise<WorktreeEntry[]> {
  const r = await gitTry(['worktree', 'list', '--porcelain'], cwd);
  if (!r.ok || !r.stdout) return [];
  const entries: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) entries.push(cur);
      cur = { path: line.slice('worktree '.length), branch: null, head: null };
    } else if (cur && line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length);
    } else if (cur && line.startsWith('branch ')) {
      // "branch refs/heads/foo" → "foo"
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  if (cur) entries.push(cur);
  return entries;
}

/** Create a branch + worktree at `path` based on `base` (default HEAD). */
export async function createWorktree(
  path: string,
  branch: string,
  base = 'HEAD',
  cwd?: string,
): Promise<void> {
  if ((await headCommit(cwd)) === null) {
    throw new Error('Repository has no commits yet — make at least one commit first.');
  }
  await git(['worktree', 'add', '-b', branch, path, base], cwd);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Remove a worktree and delete its branch. Robust to the common failure modes:
 * if the worktree dir was deleted out from under us, prune stale metadata
 * instead of issuing a doomed `remove`; retry transient EBUSY/EPERM; always
 * prune afterward to sweep leftovers. Best-effort, never throws.
 */
export async function removeWorktree(path: string, branch: string, cwd?: string): Promise<void> {
  if (!(await pathExists(path))) {
    await gitTry(['worktree', 'prune'], cwd);
  } else {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await gitTry(['worktree', 'remove', path, '--force'], cwd);
      if (r.ok) break;
      if (!/EBUSY|EPERM|resource busy|in use/i.test(r.stderr) || attempt === 3) break;
      await sleep(150 * attempt);
    }
    await gitTry(['worktree', 'prune'], cwd);
  }
  await gitTry(['branch', '-D', branch], cwd);
}

export const CONFLICT_LABELS: Record<string, string> = {
  UU: 'both modified',
  AA: 'both added',
  DD: 'both deleted',
  AU: 'added by us',
  UA: 'added by them',
  DU: 'deleted by us',
  UD: 'deleted by them',
};

/**
 * Parse unmerged ("u ") entries from `git status --porcelain=v2` into labeled
 * conflicts. Pure — exported for tests.
 * Format: `u <xy> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
 */
export function parseConflicts(raw: string): ConflictEntry[] {
  const out: ConflictEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith('u ')) continue;
    const parts = line.split(' ');
    if (parts.length < 11) continue;
    const xy = parts[1] ?? '';
    const path = parts.slice(10).join(' ');
    if (!path) continue;
    out.push({ path, xy, label: CONFLICT_LABELS[xy] ?? xy });
  }
  return out;
}

/** Detect an in-progress git operation in a worktree via its marker files. */
export async function repoState(path: string): Promise<RepoState> {
  const markers: [string, RepoState][] = [
    ['MERGE_HEAD', 'merging'],
    ['rebase-merge', 'rebasing'],
    ['rebase-apply', 'rebasing'],
    ['CHERRY_PICK_HEAD', 'cherry-picking'],
    ['REVERT_HEAD', 'reverting'],
  ];
  for (const [marker, state] of markers) {
    const r = await gitTry(['-C', path, 'rev-parse', '--git-path', marker]);
    if (r.ok && r.stdout && (await pathExists(r.stdout))) return state;
  }
  return 'clean';
}

/** Working-tree status of a worktree: clean / dirty / conflict, with churn. */
export async function worktreeStatus(path: string): Promise<WorktreeStatus> {
  const repo = await repoState(path);
  const r = await gitTry(['-C', path, 'status', '--porcelain=v2']);
  if (!r.ok || r.stdout === '') {
    return {
      state: 'clean',
      repoState: repo,
      changedFiles: [],
      conflictFiles: [],
      conflictDetails: [],
      insertions: 0,
      deletions: 0,
    };
  }

  const conflictDetails = parseConflicts(r.stdout);
  const { insertions, deletions } = await churn(path);

  if (conflictDetails.length > 0) {
    return {
      state: 'conflict',
      repoState: repo,
      changedFiles: [],
      conflictFiles: conflictDetails.map((c) => c.path),
      conflictDetails,
      insertions,
      deletions,
    };
  }

  // Changed paths: ordinary ("1"/"2") and untracked ("?") porcelain v2 entries.
  const changedFiles: string[] = [];
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      changedFiles.push(line.split(' ').slice(8).join(' '));
    } else if (line.startsWith('? ')) {
      changedFiles.push(line.slice(2));
    }
  }
  return {
    state: 'dirty',
    repoState: repo,
    changedFiles,
    conflictFiles: [],
    conflictDetails: [],
    insertions,
    deletions,
  };
}

/** Total inserted/deleted lines vs HEAD (tracked changes), via --numstat. */
async function churn(path: string): Promise<{ insertions: number; deletions: number }> {
  const r = await gitTry(['-C', path, 'diff', '--numstat', 'HEAD']);
  if (!r.ok || !r.stdout) return { insertions: 0, deletions: 0 };
  let insertions = 0;
  let deletions = 0;
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const [ins, del] = line.split('\t');
    insertions += parseInt(ins, 10) || 0; // "-" (binary) → 0
    deletions += parseInt(del, 10) || 0;
  }
  return { insertions, deletions };
}

/** Commits `branch` is ahead / behind `base`. Returns {0,0} on any error. */
export async function aheadBehind(
  branch: string,
  base: string,
  cwd?: string,
): Promise<{ ahead: number; behind: number }> {
  const r = await gitTry(['rev-list', '--left-right', '--count', `${base}...${branch}`], cwd);
  if (!r.ok) return { ahead: 0, behind: 0 };
  const [behind, ahead] = r.stdout.split(/\s+/).map((n) => parseInt(n, 10) || 0);
  return { ahead: ahead ?? 0, behind: behind ?? 0 };
}

export interface CommitInfo {
  sha: string;
  message: string;
  at: string; // ISO
  files: string[];
}

/** Commits on `branch` that aren't on `base`, newest-first, with their files. */
export async function branchCommits(
  branch: string,
  base: string,
  cwd?: string,
): Promise<CommitInfo[]> {
  // %x1f = unit separator between fields, %x1e = record separator between commits.
  const r = await gitTry(
    ['log', `${base}..${branch}`, '--no-merges', '--pretty=format:%H%x1f%s%x1f%cI%x1e'],
    cwd,
  );
  if (!r.ok || !r.stdout) return [];

  const commits: CommitInfo[] = [];
  for (const rec of r.stdout.split('\x1e').map((s) => s.trim()).filter(Boolean)) {
    const [sha, message, at] = rec.split('\x1f');
    if (!sha) continue;
    const nameR = await gitTry(
      ['show', '--name-only', '--pretty=format:', sha],
      cwd,
    );
    const files = nameR.ok ? nameR.stdout.split('\n').filter(Boolean) : [];
    commits.push({ sha, message: message ?? '', at: at ?? '', files });
  }
  return commits;
}

/**
 * The last `limit` non-merge commits reachable from HEAD, with the files each
 * touched — for ingesting a repo's real history (commits that landed outside
 * `baton merge`, e.g. via GitHub PRs). Returns [] when the path isn't a git
 * repo or git errors (fail-safe).
 */
export async function recentCommits(cwd: string, limit = 100): Promise<CommitInfo[]> {
  // %x1e starts each record, %x1f separates fields; --name-only appends the file
  // list after the format line, so a record is: <sha>\x1f<msg>\x1f<date>\n<files…>
  const r = await gitTry(
    ['log', `-n${limit}`, '--no-merges', '--pretty=format:%x1e%H%x1f%s%x1f%cI', '--name-only'],
    cwd,
  );
  if (!r.ok || !r.stdout) return [];
  const commits: CommitInfo[] = [];
  for (const rec of r.stdout.split('\x1e').map((s) => s.replace(/^\n+/, '')).filter(Boolean)) {
    const lines = rec.split('\n');
    const [sha, message, at] = (lines[0] ?? '').split('\x1f');
    if (!sha) continue;
    const files = lines.slice(1).map((l) => l.trim()).filter(Boolean);
    commits.push({ sha, message: message ?? '', at: at ?? '', files });
  }
  return commits;
}

/**
 * Merge `branch` into the current branch. Default: SQUASH into one clean commit
 * (keeps the agent's WIP commits out of the real history). Reports conflicts
 * with human labels.
 */
export async function mergeBranch(
  branch: string,
  message: string,
  opts: { squash?: boolean } = {},
  cwd?: string,
): Promise<{ success: boolean; conflicts: ConflictEntry[] }> {
  const squash = opts.squash !== false;

  const r = squash
    ? await gitTry(['merge', '--squash', branch], cwd)
    : await gitTry(['merge', '--no-ff', branch, '-m', message], cwd);

  if (r.ok) {
    if (squash) {
      // --squash stages the changes but doesn't commit; make the one clean commit.
      const c = await gitTry(['commit', '-m', message], cwd);
      if (!c.ok) {
        // "nothing to commit" → branch had no net changes; treat as a no-op success.
        if (/nothing to commit/i.test(c.stdout + c.stderr)) return { success: true, conflicts: [] };
        throw new Error(c.stderr || 'git commit (squash) failed');
      }
    }
    return { success: true, conflicts: [] };
  }

  const conf = await gitTry(['status', '--porcelain=v2'], cwd);
  const conflicts = conf.ok ? parseConflicts(conf.stdout) : [];
  if (conflicts.length > 0) {
    await gitTry(['merge', '--abort'], cwd);
    // --squash leaves staged changes on failure; reset to clean up.
    if (squash) await gitTry(['reset', '--merge'], cwd);
    return { success: false, conflicts };
  }
  throw new Error(r.stderr || `git merge ${branch} failed`);
}

/** Archive a branch tip to a hidden ref (refs/baton/archive/<slug>) — invisible
 *  to log/branch, never pushed, but preserved & bisectable. Best-effort. */
export async function archiveBranch(
  slug: string,
  branch: string,
  cwd?: string,
): Promise<boolean> {
  const r = await gitTry(['update-ref', `refs/baton/archive/${slug}`, branch], cwd);
  return r.ok;
}

/** Hidden archive refs (refs/baton/archive/*) created by merges. These keep merged
 *  branch objects reachable forever, so a plain `git gc` won't reclaim them. */
export async function listArchiveRefs(cwd?: string): Promise<string[]> {
  const r = await gitTry(['for-each-ref', '--format=%(refname)', 'refs/baton/archive/'], cwd);
  if (!r.ok) return [];
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Delete a single ref by full name (e.g. refs/baton/archive/<slug>). Best-effort. */
export async function deleteRef(ref: string, cwd?: string): Promise<boolean> {
  const r = await gitTry(['update-ref', '-d', ref], cwd);
  return r.ok;
}

/** Prune detached worktree metadata, then garbage-collect unreachable objects.
 *  This is what actually reclaims disk after branches/archive-refs are removed —
 *  deleting a branch alone leaves its objects packed until a gc prunes them. */
export async function gitGc(cwd?: string): Promise<boolean> {
  await gitTry(['worktree', 'prune'], cwd);
  const r = await gitTry(['gc', '--prune=now', '--quiet'], cwd);
  return r.ok;
}

/** Bytes held by the git object store (loose + packed), via `git count-objects -v`.
 *  Used to report how much a gc reclaimed (before/after delta). 0 on any error. */
export async function objectStoreBytes(cwd?: string): Promise<number> {
  const r = await gitTry(['count-objects', '-v'], cwd);
  if (!r.ok) return 0;
  let kib = 0;
  for (const line of r.stdout.split('\n')) {
    const m = /^(size|size-pack):\s+(\d+)/.exec(line.trim());
    if (m) kib += Number(m[2]); // both fields are in KiB
  }
  return kib * 1024;
}
