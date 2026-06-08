/**
 * Local git worktree helpers for Baton's tiny v0.
 *
 * Logic adapted from handler.dev's backend-agnostic worktree service
 * (.refs/handler.dev/packages/server/src/services/worktree.ts, MIT) — rewritten
 * to run git locally via execa instead of through a Docker/SSH CommandRunner,
 * and to derive state from git itself rather than an in-memory record. See NOTICE.
 */
import { git, gitTry } from './util/exec.js';

export interface WorktreeStatus {
  state: 'clean' | 'dirty' | 'conflict';
  changedFiles: string[];
  conflictFiles: string[];
}

/** Absolute path of the repo's top level (throws if not in a git repo). */
export async function gitRoot(cwd?: string): Promise<string> {
  try {
    return await git(['rev-parse', '--show-toplevel'], cwd);
  } catch {
    throw new Error('Not inside a git repository.');
  }
}

/** Current branch name (e.g. "main"), or "HEAD" if detached. */
export async function currentBranch(cwd?: string): Promise<string> {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
}

/** Short HEAD commit hash, or null if the repo has no commits yet. */
export async function headCommit(cwd?: string): Promise<string | null> {
  const r = await gitTry(['rev-parse', '--short', 'HEAD'], cwd);
  return r.ok ? r.stdout : null;
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

/** Remove a worktree and delete its branch. Best-effort, never throws. */
export async function removeWorktree(
  path: string,
  branch: string,
  cwd?: string,
): Promise<void> {
  await gitTry(['worktree', 'remove', path, '--force'], cwd);
  await gitTry(['branch', '-D', branch], cwd);
}

/** Working-tree status of a worktree: clean / dirty / conflict. */
export async function worktreeStatus(path: string): Promise<WorktreeStatus> {
  const r = await gitTry(['-C', path, 'status', '--porcelain']);
  if (!r.ok || r.stdout === '') {
    return { state: 'clean', changedFiles: [], conflictFiles: [] };
  }
  const lines = r.stdout.split('\n').filter(Boolean);
  const conflictFiles = lines
    .filter((l) => /^(UU|AA|DD|AU|UA|DU|UD) /.test(l))
    .map((l) => l.slice(3));
  if (conflictFiles.length > 0) {
    return { state: 'conflict', changedFiles: [], conflictFiles };
  }
  const changedFiles = lines.map((l) => l.slice(3));
  return { state: 'dirty', changedFiles, conflictFiles: [] };
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
 * Merge `branch` into the current branch. Default: SQUASH into one clean commit
 * (keeps the agent's WIP commits out of the real history). Reports conflicts.
 */
export async function mergeBranch(
  branch: string,
  message: string,
  opts: { squash?: boolean } = {},
  cwd?: string,
): Promise<{ success: boolean; conflicts: string[] }> {
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

  const conf = await gitTry(['diff', '--name-only', '--diff-filter=U'], cwd);
  const conflicts = conf.ok ? conf.stdout.split('\n').filter(Boolean) : [];
  if (conflicts.length > 0) {
    await gitTry(squash ? ['merge', '--abort'] : ['merge', '--abort'], cwd);
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
