// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Auto-snapshot uncommitted work into a dangling commit, so a worktree that
 * goes quiet cannot take hours of work with it.
 *
 * Everything else on the worktree screen makes lost work VISIBLE. This makes it
 * RECOVERABLE. When a worktree enters `stalled`/`abandoned` still holding
 * uncommitted changes (`src/poller.ts:tick`), its working tree is written to
 *
 *     refs/baton/wip/<slug>
 *
 * — the same hidden namespace `archiveBranch` already uses (`src/git.ts:657`).
 * A ref under `refs/baton/` is invisible to `git branch`/`git log`, lives in
 * the COMMON ref store (not the per-worktree one), is never pushed, and is
 * unaffected by `git worktree remove`. `src/worktrees.ts:281` reads this
 * namespace back and reports it as `wipRef`; keep the name stable, it is the
 * contract between the two files.
 *
 * Recovery, long after the directory is gone:
 *     git show refs/baton/wip/<slug>            # the diff against its HEAD
 *     git show refs/baton/wip/<slug>:path/file  # one file, verbatim
 *     git checkout -b rescue refs/baton/wip/<slug>
 *
 * The precedent is Jujutsu's auto-snapshot: recoverable state must not depend
 * on the agent remembering to save. Its cautionary half is why the caps and the
 * ignore rules below are not optional — the first thing a naive auto-snapshot
 * captures is somebody's `.env`, which turns a safety feature into a
 * secret-exfiltration feature. So:
 *
 *   - untracked files are enumerated with `--exclude-standard`, and the `git
 *     add` that stages them refuses ignored paths a second time (it needs `-f`
 *     to take one, and we never pass `-f`). Two independent gates, both git's.
 *   - anything over WIP_MAX_FILE_BYTES, and anything past WIP_MAX_TOTAL_BYTES
 *     in total, is left out and named in `skipped` rather than silently pulled
 *     into the object store.
 *
 * All git goes through `src/util/exec.ts` (shell-free, hardened) — this file is
 * nothing but plumbing commands, so a shell here would be the worst possible
 * place for one.
 */
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { git, gitTry } from './util/exec.js';

/** The namespace `src/worktrees.ts` reads back as `wipRef`. Do not rename. */
export const WIP_REF_PREFIX = 'refs/baton/wip/';

/** Per-file ceiling. A source file is kilobytes; anything past this is a build
 *  artifact, a model, or a database, and none of those are the work at risk. */
export const WIP_MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB

/** Whole-snapshot ceiling. Bounds what one stalled worktree can add to the
 *  object store — the poller may hit this for every task in a fleet. */
export const WIP_MAX_TOTAL_BYTES = 32 * 1024 * 1024; // 32 MiB

export function wipRefFor(slug: string): string {
  return `${WIP_REF_PREFIX}${slug}`;
}

export interface WipSnapshotOpts {
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export interface WipSnapshot {
  /** Full ref name, e.g. `refs/baton/wip/fix-auth`. */
  ref: string;
  /** The snapshot commit. */
  sha: string;
  /** Its tree — the identity used for the idempotency check. */
  tree: string;
  /** Files whose working-tree content went in. */
  files: number;
  /** Bytes of working-tree content captured. */
  bytes: number;
  /** Paths left out by the caps, so a caller can say so instead of guessing. */
  skipped: string[];
  /** False when the ref already pointed at this exact tree and was left alone. */
  updated: boolean;
}

/**
 * A ref component we are willing to build by concatenation. Slugs reach us from
 * task records, and `refs/baton/wip/` + an unvalidated string is a ref-injection
 * primitive (`../../heads/main` writes somebody's branch). Git's own
 * `check-ref-format` would be a second subprocess to answer a question a regex
 * answers exactly; this is deliberately stricter than git is.
 */
function safeSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 100 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug) && !slug.includes('..');
}

/** Split a NUL-delimited `-z` git listing. Empty in ⇒ empty out. */
function splitZ(out: string): string[] {
  return out.split('\0').filter(Boolean);
}

/**
 * The common `.git` directory — the MAIN repo's, when `path` is a linked
 * worktree. It is the object store the snapshot must end up in: writing to the
 * per-worktree gitdir would put the rescue commit inside the directory whose
 * disappearance is the whole failure we are defending against.
 */
async function commonGitDir(path: string): Promise<string | null> {
  const abs = await gitTry(['-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (abs.ok && abs.stdout) return abs.stdout;
  // `--path-format` is git >= 2.31; older git answers relative to the worktree.
  const rel = await gitTry(['-C', path, 'rev-parse', '--git-common-dir']);
  if (!rel.ok || !rel.stdout) return null;
  return isAbsolute(rel.stdout) ? rel.stdout : resolve(path, rel.stdout);
}

interface Candidate {
  path: string;
  bytes: number;
}

/**
 * Every path whose working-tree state differs from HEAD, plus every untracked
 * file git is willing to show us.
 *
 * Two listings rather than `status --porcelain=v2` (`src/git.ts:338`) on
 * purpose: `-z` makes paths with spaces, quotes or tabs unambiguous, and
 * `diff ... HEAD` catches STAGED changes too, which a worktree-vs-index listing
 * would drop — our temporary index starts from HEAD, so anything not listed
 * here silently reverts inside the snapshot.
 */
async function candidatePaths(worktreePath: string): Promise<string[] | null> {
  const [tracked, untracked] = await Promise.all([
    // --no-renames so a rename reports BOTH sides; with rename detection on,
    // the old path never appears and the snapshot keeps a file the agent moved.
    gitTry(['-C', worktreePath, 'diff', '--name-only', '-z', '--no-renames', 'HEAD', '--']),
    gitTry(['-C', worktreePath, 'ls-files', '-z', '--others', '--exclude-standard']),
  ]);
  if (!tracked.ok && !untracked.ok) return null; // not a worktree, or it is gone
  const paths = new Set([...splitZ(tracked.stdout), ...splitZ(untracked.stdout)]);
  return [...paths].sort(); // sorted so the total-cap cut is deterministic
}

/** Apply both caps. A path that no longer exists is a DELETION, not a big file,
 *  and has to stay in the list or the snapshot claims it is still there. */
async function withinCaps(
  worktreePath: string,
  paths: string[],
  maxFile: number,
  maxTotal: number,
): Promise<{ keep: Candidate[]; skipped: string[] }> {
  const keep: Candidate[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const p of paths) {
    let bytes = 0;
    try {
      // lstat: a symlink is recorded as a link, so its target's size is not ours.
      const st = await stat(join(worktreePath, p));
      bytes = st.isFile() ? st.size : 0;
    } catch {
      keep.push({ path: p, bytes: 0 }); // deleted from disk — record the removal
      continue;
    }
    if (bytes > maxFile || total + bytes > maxTotal) {
      skipped.push(p);
      continue;
    }
    total += bytes;
    keep.push({ path: p, bytes });
  }
  return { keep, skipped };
}

/**
 * Snapshot `worktreePath`'s uncommitted state to `refs/baton/wip/<slug>`.
 *
 * Returns null when there is nothing to save, when the slug is unsafe, or when
 * git could not answer — this runs from a poll tick and must never throw into
 * it. Best-effort by design: a failed snapshot is exactly as bad as the status
 * quo, while a thrown one would take the whole tick down.
 *
 * The plumbing, and why each step is the one it is:
 *
 *   1. `rev-parse HEAD`              the parent, so `git show <ref>` prints a
 *                                    DIFF of the agent's work, not the repo.
 *   2. `init --bare <tmp>`           a scratch gitdir purely for its INDEX. The
 *                                    agent's own index is untouchable: staging
 *                                    into it would change what the agent (or a
 *                                    human) sees, from a background poll.
 *   3. objects/info/alternates       the scratch repo READS the real object
 *                                    store, so unchanged blobs are never
 *                                    rehashed and HEAD is a valid parent.
 *   4. `read-tree <head>`            seed the scratch index with HEAD, so paths
 *                                    we skip keep their committed content.
 *   5. `add -A --pathspec-from-file` stage the working tree. git computes file
 *                                    modes, symlinks and deletions, and refuses
 *                                    ignored paths — a NUL-delimited pathspec
 *                                    file also sidesteps argv limits.
 *   6. `write-tree`                  the snapshot's identity (see idempotency).
 *   7. `commit-tree`                 a commit no branch points at.
 *   8. `update-ref` + `fetch`        publish inside the scratch repo, then pull
 *                                    the new objects into the real one. Fetch
 *                                    is the portable transfer: alternates only
 *                                    make objects readable, not writable, and a
 *                                    symlinked object dir would not work on
 *                                    Windows.
 */
export async function snapshotWip(
  slug: string,
  worktreePath: string,
  opts: WipSnapshotOpts = {},
): Promise<WipSnapshot | null> {
  if (!safeSlug(slug)) return null;
  const ref = wipRefFor(slug);

  const paths = await candidatePaths(worktreePath);
  if (paths === null) return null;
  if (paths.length === 0) return null; // clean worktree: nothing is at risk

  const { keep, skipped } = await withinCaps(
    worktreePath,
    paths,
    opts.maxFileBytes ?? WIP_MAX_FILE_BYTES,
    opts.maxTotalBytes ?? WIP_MAX_TOTAL_BYTES,
  );
  if (keep.length === 0) return null;

  const [head, common] = await Promise.all([
    gitTry(['-C', worktreePath, 'rev-parse', '--verify', '-q', 'HEAD']),
    commonGitDir(worktreePath),
  ]);
  // An unborn HEAD has no parent to hang a snapshot from. Rare (a worktree is
  // always created from a commit) and not worth a second code path.
  if (!head.ok || !head.stdout || !common) return null;

  const scratch = await mkdtemp(join(tmpdir(), 'baton-wip-'));
  try {
    const gitDir = join(scratch, 'git');
    const pathspec = join(scratch, 'pathspec');
    await git(['init', '--bare', '-q', gitDir]);
    await writeFile(join(gitDir, 'objects', 'info', 'alternates'), `${join(common, 'objects')}\n`, 'utf-8');
    await writeFile(pathspec, keep.map((c) => c.path).join('\0'), 'utf-8');

    await git(['--git-dir', gitDir, 'read-tree', head.stdout]);
    const add = await gitTry([
      '--git-dir', gitDir,
      '--work-tree', worktreePath,
      'add', '-A',
      '--pathspec-from-file', pathspec,
      '--pathspec-file-nul',
    ]);
    // Non-zero here means at least one path was refused (an ignored path that
    // slipped through, a vanished directory). Bailing beats publishing a ref
    // whose content we cannot describe — the next tick tries again.
    if (!add.ok) return null;

    const tree = await gitTry(['--git-dir', gitDir, 'write-tree']);
    if (!tree.ok || !tree.stdout) return null;

    // Idempotency is on CONTENT, not on time: a snapshot commit carries a fresh
    // timestamp, so comparing shas would write a new ref on every quiet tick
    // and grow the object store forever. Same tree ⇒ same work ⇒ leave the ref
    // exactly where it is, and report the sha already published.
    // (`rev-parse --verify` takes exactly one revision, hence the second call —
    // which only runs on the hit.)
    const prevTree = await gitTry(['-C', worktreePath, 'rev-parse', '--verify', '-q', `${ref}^{tree}`]);
    if (prevTree.ok && prevTree.stdout === tree.stdout) {
      const prev = await gitTry(['-C', worktreePath, 'rev-parse', '--verify', '-q', ref]);
      if (prev.ok && prev.stdout) {
        return { ref, sha: prev.stdout, tree: tree.stdout, files: keep.length, bytes: sum(keep), skipped, updated: false };
      }
    }

    const commit = await gitTry([
      '--git-dir', gitDir,
      // The scratch gitdir has no config of its own and cannot see the repo's,
      // so an identity has to be supplied or commit-tree refuses to run. A
      // machine snapshot is not authored by the human at the keyboard anyway.
      '-c', 'user.name=baton',
      '-c', 'user.email=baton@localhost',
      'commit-tree', tree.stdout,
      '-p', head.stdout,
      '-m', `baton wip snapshot: ${slug}`,
    ]);
    if (!commit.ok || !commit.stdout) return null;

    const publish = await gitTry(['--git-dir', gitDir, 'update-ref', ref, commit.stdout]);
    if (!publish.ok) return null;
    // Forced refspec: successive snapshots are siblings off the same HEAD, not
    // descendants, so a fast-forward-only fetch would reject every update.
    const transfer = await gitTry(['-C', worktreePath, 'fetch', '--no-tags', '--quiet', gitDir, `+${ref}:${ref}`]);
    if (!transfer.ok) return null;

    return { ref, sha: commit.stdout, tree: tree.stdout, files: keep.length, bytes: sum(keep), skipped, updated: true };
  } catch {
    return null; // best-effort: never break the caller's tick
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function sum(c: Candidate[]): number {
  return c.reduce((n, x) => n + x.bytes, 0);
}

/** The slice of a board row this decision needs — `StatusRow` satisfies it. */
export interface RiskRow {
  agent: string | null;
  status: 'clean' | 'dirty' | 'conflict' | 'missing';
}

function atRisk(r: RiskRow): boolean {
  // `missing` is excluded deliberately: the directory is already gone, so there
  // is nothing left to read. That is the loss this feature exists to PRE-EMPT,
  // not one it can still undo.
  return r.agent === null && (r.status === 'dirty' || r.status === 'conflict');
}

/**
 * Did this worktree just BECOME unattended-with-uncommitted-work?
 *
 * The poller ticks every 2s and a stalled worktree stays stalled for hours, so
 * the trigger has to be an edge, not a level — snapshotting on the level would
 * run ~8 git processes per task per tick forever. `snapshotWip` is idempotent
 * on content anyway, but the cheapest git command is the one not run.
 */
export function enteredRisk(before: RiskRow, after: RiskRow): boolean {
  return atRisk(after) && !atRisk(before);
}
