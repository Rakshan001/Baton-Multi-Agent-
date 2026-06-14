/**
 * Real git diffs for a task worktree — powers GET /api/tasks/:slug/diff.
 *
 * The diff is taken against the merge-base of the task's base branch, so it
 * shows everything the session changed: commits on the task branch PLUS
 * uncommitted tracked edits, with untracked files appended as additions.
 * Output mirrors the dashboard's DiffFile shape (web/src/types.ts).
 */
import { gitTry } from './util/exec.js';
import type { Task } from './store.js';

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
export type FileStatus = 'added' | 'modified' | 'deleted';
export interface DiffFile {
  path: string;
  status: FileStatus;
  hunks: DiffHunk[];
  add: number;
  del: number;
  lang: string;
}

/** Untracked files beyond this count are listed but not expanded into hunks. */
const MAX_UNTRACKED_EXPANDED = 50;

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse `git diff` unified output into the dashboard's DiffFile shape. Pure; exported for tests. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  if (!text.trim()) return files;

  let cur: DiffFile | null = null;
  let oldPath = '';
  let newPath = '';
  let hunk: DiffHunk | null = null;
  let o = 0;
  let n = 0;
  let remainOld = 0;
  let remainNew = 0;

  const strip = (p: string) => p.replace(/^[ab]\//, '');
  const flush = () => {
    if (!cur) return;
    cur.path = (cur.status === 'deleted' ? oldPath : newPath) || oldPath || newPath;
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
      oldPath = '';
      newPath = '';
      continue;
    }
    if (!cur) continue;

    if (line.startsWith('new file mode')) {
      cur.status = 'added';
    } else if (line.startsWith('deleted file mode')) {
      cur.status = 'deleted';
    } else if (line.startsWith('rename from ')) {
      oldPath = line.slice('rename from '.length);
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

/**
 * Everything the session changed vs its base: `git diff <merge-base>` in the
 * worktree (commits + uncommitted tracked edits) plus untracked files rendered
 * as additions. Returns [] when the worktree is gone or git fails — the diff
 * endpoint must never 500 a healthy dashboard.
 */
export async function collectDiff(task: Task): Promise<DiffFile[]> {
  const wt = task.worktreePath;

  let base = task.baseCommit || task.baseBranch;
  const mb = await gitTry(['-C', wt, 'merge-base', task.baseBranch, 'HEAD']);
  if (mb.ok && mb.stdout) base = mb.stdout;

  const tracked = await gitTry(['-C', wt, 'diff', '--no-color', '--no-ext-diff', '--find-renames', base]);
  const files = tracked.ok ? parseUnifiedDiff(tracked.stdout) : [];

  const untracked = await gitTry(['-C', wt, 'ls-files', '--others', '--exclude-standard']);
  if (untracked.ok && untracked.stdout) {
    const paths = untracked.stdout.split('\n').filter(Boolean);
    for (const p of paths.slice(0, MAX_UNTRACKED_EXPANDED)) {
      // Exits 1 when the file has content — gitTry still captures stdout.
      const r = await gitTry(['-C', wt, 'diff', '--no-color', '--no-index', '--', '/dev/null', p]);
      const parsed = parseUnifiedDiff(r.stdout);
      if (parsed.length) {
        files.push(...parsed.map((f) => ({ ...f, status: 'added' as const })));
      } else {
        files.push({ path: p, status: 'added', hunks: [], add: 0, del: 0, lang: p.includes('.') ? p.split('.').pop()! : '' });
      }
    }
    for (const p of paths.slice(MAX_UNTRACKED_EXPANDED)) {
      files.push({ path: p, status: 'added', hunks: [], add: 0, del: 0, lang: p.includes('.') ? p.split('.').pop()! : '' });
    }
  }
  return files;
}
