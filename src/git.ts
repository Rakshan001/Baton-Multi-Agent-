// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
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
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { git, gitTry } from './util/exec.js';

/**
 * Add a repo-root-anchored pattern to the checkout's local `.git/info/exclude`
 * (idempotent, best-effort).
 *
 * Baton writes its own artifacts into the worktree it hands to an agent —
 * HANDOFF.md, skill files, the Cursor continuation rule. Untracked, every one
 * of them lands in `worktreeStatus().changedFiles`, which `baton done` passes
 * to the evidence gate as `dirtyFiles`, where a single entry is a hard refusal.
 * Left alone, Baton would make the task it just briefed impossible to finish.
 *
 * `--git-common-dir` resolves to the MAIN repo for a linked worktree, so one
 * write covers every worktree — which is what we want: the pattern is about
 * Baton's artifacts, not about one checkout.
 */
const excludeWritten = new Set<string>();

/** Git exclude patterns are posix-separated on every platform, but callers
 *  build `rel` with `path.join`, which yields backslashes on Windows. A
 *  backslashed pattern silently matches nothing. */
function excludePattern(rel: string): string {
  return `/${rel.replace(/\\/g, '/').replace(/^\/+/, '')}`;
}

async function excludeFileFor(worktreePath: string): Promise<string | null> {
  const common = await gitTry(['-C', worktreePath, 'rev-parse', '--git-common-dir']);
  if (!common.ok) return null;
  return join(resolve(worktreePath, common.stdout.trim()), 'info', 'exclude');
}

/** Returns whether the pattern is in place — false outside a git repo, which
 *  is the folder-workspace case and not a failure. */
export async function gitExcludeLocal(worktreePath: string, rel: string): Promise<boolean> {
  const pattern = excludePattern(rel);
  // Writing a brief is a hot path — `baton pass`, every snapshot, and (soon)
  // every dispatched task. The exclude only ever needs writing once per
  // checkout, so remember it rather than paying a `git rev-parse` per call.
  const memo = `${resolve(worktreePath)}\0${pattern}`;
  if (excludeWritten.has(memo)) return true;
  const excludeFile = await excludeFileFor(worktreePath);
  if (!excludeFile) return false;
  let current = '';
  try { current = await readFile(excludeFile, 'utf-8'); } catch { /* not created yet */ }
  const bare = pattern.slice(1);
  if (current.split('\n').some((l) => l.trim() === pattern || l.trim() === bare)) {
    excludeWritten.add(memo);
    return true;
  }
  await mkdir(dirname(excludeFile), { recursive: true });
  await writeFile(excludeFile, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${pattern}\n`, 'utf-8');
  excludeWritten.add(memo);
  return true;
}

/**
 * Take one pattern back out, leaving every other line untouched.
 *
 * The pair matters: a pattern that outlives what it was for makes a
 * hand-written file at the same path invisible to git, and invisible is the
 * one failure mode nobody debugs — `git status` simply does not mention it.
 */
export async function gitUnexcludeLocal(worktreePath: string, rel: string): Promise<void> {
  const pattern = excludePattern(rel);
  const bare = pattern.slice(1);
  excludeWritten.delete(`${resolve(worktreePath)}\0${pattern}`);
  const excludeFile = await excludeFileFor(worktreePath);
  if (!excludeFile) return;
  let current = '';
  try { current = await readFile(excludeFile, 'utf-8'); } catch { return; }
  const kept = current.split('\n').filter((l) => l.trim() !== pattern && l.trim() !== bare);
  const next = kept.join('\n');
  if (next !== current) await writeFile(excludeFile, next, 'utf-8');
}

export type RepoState = 'clean' | 'merging' | 'rebasing' | 'cherry-picking' | 'reverting';

export interface ConflictEntry {
  path: string;
  xy: string; // porcelain v2 unmerged code, e.g. "UU"
  label: string; // human label, e.g. "both modified"
}

export interface WorktreeStatus {
  /**
   * `missing` is the one that has to exist separately from `clean`: git failing
   * to answer and git answering "nothing changed" are opposite facts, and
   * collapsing them made a deleted worktree read as a pristine checkout on
   * every surface that shows one.
   */
  state: 'clean' | 'dirty' | 'conflict' | 'missing';
  repoState: RepoState;
  changedFiles: string[];
  conflictFiles: string[];
  conflictDetails: ConflictEntry[];
  insertions: number;
  deletions: number;
}

/**
 * Is there work here that deleting the worktree would destroy?
 *
 * The question every removal guard actually asks. They asked `state !== 'clean'`
 * instead, which was the same thing until `missing` existed — and would now
 * refuse to clean up a worktree precisely because it is already gone.
 */
export function hasUnsavedWork(st: WorktreeStatus): boolean {
  return st.state === 'dirty' || st.state === 'conflict';
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

const STATE_MARKERS: [string, RepoState][] = [
  ['MERGE_HEAD', 'merging'],
  ['rebase-merge', 'rebasing'],
  ['rebase-apply', 'rebasing'],
  ['CHERRY_PICK_HEAD', 'cherry-picking'],
  ['REVERT_HEAD', 'reverting'],
];

/**
 * Worktree → resolved marker paths. A worktree's gitdir never moves while it
 * exists, so resolve once and stat thereafter: repoState is on the status
 * poller's 2s tick for every task, and five `rev-parse --git-path` spawns per
 * task per tick was the daemon's single largest CPU cost. A recreated worktree
 * at the same path gets the same gitdir (keyed by worktree name), so the cache
 * never goes wrong — a stale entry just stats paths that no longer exist.
 */
const markerPathCache = new Map<string, string[]>();

/** Detect an in-progress git operation in a worktree via its marker files. */
export async function repoState(path: string): Promise<RepoState> {
  let resolved = markerPathCache.get(path);
  if (!resolved) {
    // One spawn resolves all five markers: --git-path repeats, one line each.
    const r = await gitTry([
      '-C', path, 'rev-parse',
      ...STATE_MARKERS.flatMap(([marker]) => ['--git-path', marker]),
    ]);
    if (!r.ok || !r.stdout) return 'clean';
    const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length !== STATE_MARKERS.length) return 'clean';
    // --git-path output is relative to the -C dir for a plain checkout and
    // absolute for a linked worktree — anchor the relative form explicitly.
    resolved = lines.map((l) => (isAbsolute(l) ? l : resolve(path, l)));
    markerPathCache.set(path, resolved);
  }
  const exists = await Promise.all(resolved.map((p) => pathExists(p)));
  for (let i = 0; i < STATE_MARKERS.length; i++) {
    if (exists[i]) return STATE_MARKERS[i]![1];
  }
  return 'clean';
}

/** Working-tree status of a worktree: missing / clean / dirty / conflict, with churn. */
export async function worktreeStatus(path: string): Promise<WorktreeStatus> {
  const repo = await repoState(path);
  const r = await gitTry(['-C', path, 'status', '--porcelain=v2']);
  if (!r.ok || r.stdout === '') {
    // `!r.ok` means git could not answer at all — the directory was deleted, or
    // it is no longer a worktree. Reporting that as `clean` (which is what this
    // did) drew a checkout that is not there as a tidy one, and let the done
    // gate print "working tree clean" about a path it never read.
    //
    // Empty stdout is the opposite fact — git looked and found nothing changed.
    const state = r.ok ? 'clean' : 'missing';
    return {
      state,
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
  /** Subject line only — what every existing caller means by "message". */
  message: string;
  at: string; // ISO
  files: string[];
  /** The FULL message, including the trailer block. Only `branchCommits` fills
   *  this in; lineage is the only reader that needs more than the subject. */
  body?: string;
}

/** Commits on `branch` that aren't on `base`, newest-first, with their files. */
export async function branchCommits(
  branch: string,
  base: string,
  cwd?: string,
): Promise<CommitInfo[]> {
  // %x1f = unit separator between fields, %x1e = record separator between commits.
  // %B (the full message) comes LAST because it is the only field that may
  // contain newlines — everything before it keeps a fixed position, and the
  // record still ends at %x1e. Trailers live in the body, so a reader that only
  // has %s cannot see them at all.
  const r = await gitTry(
    ['log', `${base}..${branch}`, '--no-merges', '--pretty=format:%H%x1f%s%x1f%cI%x1f%B%x1e'],
    cwd,
  );
  if (!r.ok || !r.stdout) return [];

  const commits: CommitInfo[] = [];
  for (const rec of r.stdout.split('\x1e').map((s) => s.trim()).filter(Boolean)) {
    const [sha, message, at, body] = rec.split('\x1f');
    if (!sha) continue;
    const nameR = await gitTry(
      ['show', '--name-only', '--pretty=format:', sha],
      cwd,
    );
    const files = nameR.ok ? nameR.stdout.split('\n').filter(Boolean) : [];
    commits.push({ sha, message: message ?? '', at: at ?? '', files, body: body ?? message ?? '' });
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

/**
 * Conflicted paths from `git merge-tree --write-tree` output.
 *
 * On conflict the command prints the tree OID, then one `<mode> <oid> <stage>\t<path>`
 * line per conflicting stage, then human-readable messages. The stage lines are
 * what we read: they are machine format and cover every conflict kind, whereas
 * the "CONFLICT (content): …" prose varies by type (add/add, modify/delete,
 * rename/rename) and would need a parser per phrasing.
 */
export function parseMergeTreeConflicts(raw: string): string[] {
  const paths = new Set<string>();
  for (const line of raw.split('\n')) {
    const m = /^\d{6} [0-9a-f]{40,} [123]\t(.+)$/.exec(line);
    if (m) paths.add(m[1]!);
  }
  return [...paths];
}

/** The remote to treat as shared — `origin` when present, else the first one, else null. */
export async function defaultRemote(cwd?: string): Promise<string | null> {
  const r = await gitTry(['remote'], cwd);
  if (!r.ok || !r.stdout.trim()) return null;
  const names = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  return names.includes('origin') ? 'origin' : (names[0] ?? null);
}

/** The commit a ref points at, or null. Asked of the repo, so it works with no worktree. */
export async function refSha(ref: string, cwd?: string): Promise<string | null> {
  const r = await gitTry(['rev-parse', '--verify', `${ref}^{commit}`], cwd);
  return r.ok ? r.stdout.trim() : null;
}

/** Push a branch to a remote. Returns git's own words on failure — they are better than ours. */
export async function pushBranch(
  remote: string,
  branch: string,
  cwd?: string,
): Promise<{ ok: boolean; error: string }> {
  // No --force, ever. A force-push from an automated path can destroy a
  // teammate's commits, and nothing in the pipeline needs one.
  const r = await gitTry(['push', '--set-upstream', remote, `${branch}:${branch}`], cwd);
  return { ok: r.ok, error: r.ok ? '' : (r.stderr || r.stdout) };
}

/** Update remote-tracking refs. Best-effort: offline is a normal state, not an error. */
export async function fetchRemote(remote: string, cwd?: string): Promise<boolean> {
  const r = await gitTry(['fetch', '--quiet', '--prune', remote], cwd);
  return r.ok;
}

/**
 * Is this commit on the remote — reachable from some remote-tracking ref?
 *
 * Deliberately not "does the object exist locally". After a fetch our own
 * unpushed commits are present too, and answering yes for one of those is
 * exactly the mistake that would let a teammate start against work that exists
 * on nobody else's machine.
 */
export async function remoteContains(sha: string, cwd?: string): Promise<boolean> {
  const r = await gitTry(['branch', '-r', '--contains', sha], cwd);
  return r.ok && r.stdout.trim().length > 0;
}

/** Is every commit of `maybeAncestor` already reachable from `tip`? */
export async function isAncestor(maybeAncestor: string, tip: string, cwd?: string): Promise<boolean> {
  const r = await gitTry(['merge-base', '--is-ancestor', maybeAncestor, tip], cwd);
  return r.ok;
}

export interface IntegrationTrial {
  /** Branches that combined cleanly, in the order they were tried. */
  ok: string[];
  /** The first branch that would not combine, and the paths that clashed. */
  conflict: { branch: string; files: string[] } | null;
}

/**
 * Would these branches all land on `base` together? Answers without touching
 * the working tree, the index, or any branch.
 *
 * Each branch is merged onto the RESULT of the previous one, not onto `base`
 * independently — because that is the question the barrier is asking, and the
 * two are not the same. Two branches can each merge into base cleanly and still
 * conflict with each other; the spec's own example is exactly that (auth-schema
 * and config both fine alone, `src/db.ts` clashing once combined). Checking
 * them separately reports all-clear and opens the next phase on a base that
 * cannot actually be built.
 *
 * `commit-tree` writes throwaway commits so the next step has something to
 * merge onto. They are never referenced by any ref, so they are unreachable the
 * moment this returns and `git gc` reclaims them; nothing here is visible in
 * log, status, or branch.
 */
export async function trialIntegrate(
  base: string,
  branches: readonly string[],
  cwd?: string,
): Promise<IntegrationTrial> {
  let head = base;
  const ok: string[] = [];
  for (const branch of branches) {
    const r = await gitTry(['merge-tree', '--write-tree', head, branch], cwd);
    if (!r.ok) {
      const files = parseMergeTreeConflicts(`${r.stdout}\n${r.stderr}`);
      // A merge-tree that failed for a reason other than a conflict (a bad ref,
      // an unrelated history) has no stage lines. Reporting that as a conflict
      // with zero files would read as "something clashed but we can't say what"
      // — name the branch and let the caller surface git's own words.
      if (files.length === 0) throw new Error(r.stderr || `git merge-tree ${head} ${branch} failed`);
      return { ok, conflict: { branch, files } };
    }
    const tree = r.stdout.split('\n')[0]!.trim();
    // BOTH parents, and this is load-bearing. With only `head` the trial commit
    // has no ancestry link to the branch just merged, so the NEXT step computes
    // its merge base against the original base instead — and a branch that was
    // rebased or merged onto an earlier one in the same phase (the ordinary way
    // people resolve exactly this conflict) reads as conflicting forever, with
    // no way to clear it. A real merge commit has two parents; so must this one.
    const c = await gitTry(['commit-tree', tree, '-p', head, '-p', branch, '-m', 'baton: integration trial'], cwd);
    if (!c.ok) throw new Error(c.stderr || 'git commit-tree failed');
    head = c.stdout.trim();
    ok.push(branch);
  }
  return { ok, conflict: null };
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
