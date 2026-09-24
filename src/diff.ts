// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Real git diffs for a task worktree — powers GET /api/tasks/:slug/diff.
 *
 * The diff is taken against the merge-base of the task's base branch, so it
 * shows everything the session changed: commits on the task branch PLUS
 * uncommitted tracked edits, with untracked files appended as additions.
 * Output mirrors the dashboard's DiffFile shape (web/src/types.ts).
 */
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { gitTry } from './util/exec.js';

/**
 * Anything `collectDiff` can diff: a task worktree, or any other worktree row
 * (main/orphan/external) that has no task concept of "base". `Task` already
 * carries all three fields, so `collectDiff(task)` keeps typechecking with no
 * call-site change — this is a structural widening, not a new parameter shape.
 */
export interface DiffTarget {
  worktreePath: string;
  /** null when there is no base branch to compare against (a worktree with no
   *  task) — the diff is then uncommitted-vs-HEAD only. */
  baseBranch: string | null;
  baseCommit?: string | null;
}

export type DiffLineType = 'add' | 'del' | 'ctx';
export interface DiffLine {
  t: DiffLineType;
  o: number | null;
  n: number | null;
  s: string;
}
export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}
export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';
export interface DiffFile {
  path: string;
  status: FileStatus;
  /** The path before a rename; set only when `status` is 'renamed'. */
  oldPath?: string;
  /**
   * Listed without its content because it was too big to show: over the
   * per-file cap, past the shared budget, or past the first untracked files
   * that get expanded. About this file only — `DiffResult.truncated` is the
   * whole-diff flag.
   */
  tooLarge?: true;
  hunks: DiffHunk[];
  add: number;
  del: number;
  lang: string;
}

/** Untracked files beyond this count are listed but not expanded into hunks. */
const MAX_UNTRACKED_EXPANDED = 50;

/**
 * Most diff text read for one request, tracked and untracked together. In
 * UTF-16 units (what execa counts), so "about 5 MB" rather than exactly.
 */
export const DIFF_MAX_CHARS = 5_000_000;
/** Most files listed for one request, tracked and untracked together. */
export const DIFF_MAX_FILES = 1000;
/** Most diff text read for one untracked file before it is listed as tooLarge. */
const UNTRACKED_FILE_MAX_CHARS = 256_000;

export interface DiffResult {
  files: DiffFile[];
  /**
   * The shared text budget or the file cap was hit, so the file list and
   * counts are partial. One big file alone does not set this; see `tooLarge`.
   */
  truncated: boolean;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Best-effort path from a `diff --git a/X b/X` header body ("a/X b/X"). Lets
 * files with no `---`/`+++` lines (binary files, pure mode changes) still
 * resolve a path. Handles the symmetric non-rename form even when the path
 * contains spaces; otherwise splits on the first " b/".
 */
function gitHeaderPath(body: string): string {
  if (!body.startsWith('a/')) return '';
  const rest = body.slice(2); // "X b/X"
  const marker = ' b/';
  if ((rest.length - marker.length) % 2 === 0) {
    const plen = (rest.length - marker.length) / 2;
    if (
      rest.slice(plen, plen + marker.length) === marker &&
      rest.slice(0, plen) === rest.slice(plen + marker.length)
    ) {
      return rest.slice(0, plen);
    }
  }
  const idx = rest.indexOf(marker);
  return idx >= 0 ? rest.slice(0, idx) : rest;
}

/** Parse `git diff` unified output into the dashboard's DiffFile shape. Pure; exported for tests. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  if (!text.trim()) return files;

  let cur: DiffFile | null = null;
  let oldPath = '';
  let newPath = '';
  let renamed = false;
  let hunk: DiffHunk | null = null;
  let o = 0;
  let n = 0;
  let remainOld = 0;
  let remainNew = 0;

  const strip = (p: string) => p.replace(/^[ab]\//, '');
  const flush = () => {
    if (!cur) return;
    cur.path = (cur.status === 'deleted' ? oldPath : newPath) || oldPath || newPath;
    if (renamed && cur.status === 'modified' && oldPath && oldPath !== cur.path) {
      cur.status = 'renamed';
      cur.oldPath = oldPath;
    }
    cur.lang = cur.path.includes('.') ? cur.path.split('.').pop()! : '';
    files.push(cur);
    cur = null;
    hunk = null;
  };

  for (const line of text.split('\n')) {
    // Inside a hunk, consume exactly the counted lines so a stray "diff --git"
    // in file content can't be mistaken for a new file section.
    if (hunk && (remainOld > 0 || remainNew > 0)) {
      if (line.startsWith('\\')) continue; // "\ No newline at end of file"
      if (line.startsWith('+')) {
        hunk.lines.push({ t: 'add', o: null, n: n++, s: line.slice(1) });
        cur!.add++;
        remainNew--;
      } else if (line.startsWith('-')) {
        hunk.lines.push({ t: 'del', o: o++, n: null, s: line.slice(1) });
        cur!.del++;
        remainOld--;
      } else {
        hunk.lines.push({ t: 'ctx', o: o++, n: n++, s: line.slice(1) });
        remainOld--;
        remainNew--;
      }
      continue;
    }

    if (line.startsWith('diff --git ')) {
      flush();
      cur = { path: '', status: 'modified', hunks: [], add: 0, del: 0, lang: '' };
      // Seed from the header so binary / mode-only files (no ---/+++) still get
      // a path; any later ---/+++/rename line overrides this.
      const seed = gitHeaderPath(line.slice('diff --git '.length));
      oldPath = seed;
      newPath = seed;
      renamed = false;
      continue;
    }
    if (!cur) continue;

    if (line.startsWith('new file mode')) {
      cur.status = 'added';
    } else if (line.startsWith('deleted file mode')) {
      cur.status = 'deleted';
    } else if (line.startsWith('rename from ')) {
      oldPath = line.slice('rename from '.length);
      renamed = true;
    } else if (line.startsWith('rename to ')) {
      newPath = line.slice('rename to '.length);
    } else if (line.startsWith('--- ')) {
      const p = line.slice(4);
      if (p !== '/dev/null') oldPath = strip(p);
    } else if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      if (p !== '/dev/null') newPath = strip(p);
    } else {
      const m = HUNK_RE.exec(line);
      if (m) {
        o = parseInt(m[1], 10);
        remainOld = m[2] === undefined ? 1 : parseInt(m[2], 10);
        n = parseInt(m[3], 10);
        remainNew = m[4] === undefined ? 1 : parseInt(m[4], 10);
        hunk = { header: line, lines: [] };
        cur.hunks.push(hunk);
      }
      // Binary files / index lines / mode changes carry no hunk content.
    }
  }
  flush();
  return files;
}

/** An untracked file listed by name only; `big` when that is because it is too big to show. */
function hunkless(p: string, big = true): DiffFile {
  const f: DiffFile = { path: p, status: 'added', hunks: [], add: 0, del: 0, lang: p.includes('.') ? p.split('.').pop()! : '' };
  return big ? { ...f, tooLarge: true } : f;
}

/** Size on disk, or null when it cannot be read (then git is asked as before). */
async function sizeOf(path: string): Promise<number | null> {
  try { return (await lstat(path)).size; } catch { return null; }
}

/**
 * Everything the session changed vs its base: `git diff <merge-base>` in the
 * worktree (commits + uncommitted tracked edits) plus untracked files rendered
 * as additions. Returns no files when the worktree is gone or git fails — the
 * diff endpoint must never 500 a healthy dashboard.
 *
 * Bounded: at most `maxChars` of diff text (one budget shared by the tracked
 * diff and the untracked files) and `maxFiles` files in all. Past either cap
 * the result is `truncated`, and what was read so far is still returned — a
 * diff too large to read used to come back as no files at all.
 */
export async function collectDiff(
  target: DiffTarget,
  opts: { maxChars?: number; maxFiles?: number } = {},
): Promise<DiffResult> {
  const wt = target.worktreePath;
  const maxFiles = opts.maxFiles ?? DIFF_MAX_FILES;
  let budget = opts.maxChars ?? DIFF_MAX_CHARS;
  let truncated = false;

  let base = target.baseCommit || target.baseBranch || 'HEAD';
  if (target.baseBranch) {
    const mb = await gitTry(['-C', wt, 'merge-base', target.baseBranch, 'HEAD']);
    if (mb.ok && mb.stdout) base = mb.stdout;
  }

  const tracked = await gitTry(
    ['-C', wt, 'diff', '--no-color', '--no-ext-diff', '--find-renames', base],
    undefined, undefined, { maxBuffer: budget },
  );
  // A cut-off diff still parses: the parser stops cleanly mid-hunk, and only
  // the last file's counts are partial.
  let files = tracked.ok || tracked.truncated ? parseUnifiedDiff(tracked.stdout) : [];
  if (tracked.truncated) {
    truncated = true;
    budget = 0;
  } else {
    budget -= tracked.stdout.length;
  }
  if (files.length > maxFiles) {
    files = files.slice(0, maxFiles);
    truncated = true;
  }

  const untracked = await gitTry(['-C', wt, 'ls-files', '--others', '--exclude-standard']);
  if (untracked.ok && untracked.stdout) {
    let paths = untracked.stdout.split('\n').filter(Boolean);
    const room = maxFiles - files.length;
    if (paths.length > room) {
      paths = paths.slice(0, Math.max(0, room));
      truncated = true;
    }
    for (const p of paths.slice(0, MAX_UNTRACKED_EXPANDED)) {
      // Over the per-file cap on disk: no point spawning git to read it.
      // (Bytes vs characters: close enough for a display cap.)
      const size = await sizeOf(join(wt, p));
      if (size !== null && size > UNTRACKED_FILE_MAX_CHARS) {
        files.push(hunkless(p));
        continue;
      }
      if (budget <= 0) {
        files.push(hunkless(p));
        truncated = true;
        continue;
      }
      const cap = Math.min(budget, UNTRACKED_FILE_MAX_CHARS);
      // Exits 1 when the file has content — gitTry still captures stdout.
      const r = await gitTry(
        ['-C', wt, 'diff', '--no-color', '--no-index', '--', '/dev/null', p],
        undefined, undefined, { maxBuffer: cap },
      );
      if (r.truncated) {
        files.push(hunkless(p));
        // Only a cut made by the SHARED budget makes the whole diff partial.
        if (cap < UNTRACKED_FILE_MAX_CHARS) truncated = true;
        continue;
      }
      budget -= r.stdout.length;
      const parsed = parseUnifiedDiff(r.stdout);
      if (parsed.length) {
        files.push(...parsed.map((f) => ({ ...f, status: 'added' as const })));
      } else {
        files.push(hunkless(p, false));   // e.g. empty or binary: nothing to show
      }
    }
    // Past the first MAX_UNTRACKED_EXPANDED, content is not read at all.
    for (const p of paths.slice(MAX_UNTRACKED_EXPANDED)) files.push(hunkless(p));
  }
  return { files, truncated };
}
