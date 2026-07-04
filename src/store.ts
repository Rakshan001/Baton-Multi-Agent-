/**
 * Tiny JSON store for Baton tasks, kept at <repo>/.baton/tasks.json (gitignored).
 * One file, no database — sufficient at this scale.
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gitRoot } from './git.js';

export interface Task {
  slug: string;
  task: string;
  branch: string;
  worktreePath: string;
  baseBranch: string;
  baseCommit: string | null;
  createdAt: string; // ISO
  /** In a multi-repo hub: which sub-project this task targets. Undefined for a plain single repo. */
  projectId?: string;
  /** The git repo the worktree/branch belongs to. Equals the sub-project dir in a hub,
   *  or the repo root in a single repo. Older records omit it — fall back to the served root. */
  repoRoot?: string;
}

/** Thrown when a slug doesn't resolve to a recorded task. */
export class TaskNotFoundError extends Error {
  slug: string;
  constructor(slug: string) {
    super(`No task '${slug}'`);
    this.name = 'TaskNotFoundError';
    this.slug = slug;
  }
}

export function batonDir(gitRoot: string): string {
  return join(gitRoot, '.baton');
}

// Warn once per untrusted .baton dir — resolveBatonRoot runs on hot paths.
const untrustedWarned = new Set<string>();

/**
 * True if `dir/.baton` exists, is a directory, and is safe to adopt: owned by
 * the current user and not world-writable. Group-writable is deliberately
 * allowed (Debian/Ubuntu user-private-group setups run umask 002); the uid
 * match is the real gate against a .baton planted by another user. On
 * platforms without getuid (Windows) the ownership check is skipped.
 */
async function trustedBatonDir(dir: string): Promise<boolean> {
  const st = await stat(join(dir, '.baton'));
  if (!st.isDirectory()) return false;
  if (typeof process.getuid !== 'function') return true;
  if (st.uid !== process.getuid() || (st.mode & 0o002) !== 0) {
    if (!untrustedWarned.has(dir)) {
      untrustedWarned.add(dir);
      console.warn(
        `[baton] ignoring untrusted .baton at ${dir} (uid ${st.uid}, mode ${(st.mode & 0o777).toString(8)}) — continuing upward`,
      );
    }
    return false;
  }
  return true;
}

/**
 * The Baton root — the directory that owns `.baton/` (tasks, kb, memory). For a
 * single repo this is the git root; for a multi-repo hub it's the (non-git)
 * container folder. Walk up from `cwd` for the nearest `.baton/`; if there is
 * none yet, fall back to the enclosing git repo (a fresh repo not set up yet).
 * Throws only when we're neither inside a Baton project nor a git repo.
 */
export async function resolveBatonRoot(cwd: string = process.cwd()): Promise<string> {
  let dir = cwd;
  for (;;) {
    try {
      if (await trustedBatonDir(dir)) return dir;
    } catch { /* no .baton here — keep walking up */ }
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  return gitRoot(cwd); // not set up yet → the git repo is the Baton root
}

export function tasksFile(gitRoot: string): string {
  return join(batonDir(gitRoot), 'tasks.json');
}

export async function loadTasks(gitRoot: string): Promise<Task[]> {
  try {
    const raw = await readFile(tasksFile(gitRoot), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Task[]) : [];
  } catch {
    return []; // missing/empty/corrupt → start fresh
  }
}

export async function saveTasks(gitRoot: string, tasks: Task[]): Promise<void> {
  const file = tasksFile(gitRoot);
  await mkdir(dirname(file), { recursive: true });
  // tmp + rename: readers never observe a half-written file.
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(tasks, null, 2) + '\n', 'utf-8');
  await rename(tmp, file);
}

// Mutations are serialized per process so two concurrent addTask/removeTask
// calls (e.g. two POST /api/tasks) can't read-modify-write over each other.
let writeQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(fn, fn);
  writeQueue = next.catch(() => undefined);
  return next;
}

export async function getTask(gitRoot: string, slug: string): Promise<Task | undefined> {
  return (await loadTasks(gitRoot)).find((t) => t.slug === slug);
}

// Cross-process advisory lock: `serialized()` covers concurrent writes inside
// ONE process, but the CLI (`baton new`) and a running daemon are separate
// processes writing the same tasks.json — without a lock, simultaneous
// read-modify-writes lose one side's update (writes stay crash-atomic via
// tmp+rename either way; this is about lost updates, not torn files).
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 2000;
const LOCK_STALE_MS = 5000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function withTasksLock<T>(gitRoot: string, fn: () => Promise<T>): Promise<T> {
  const lock = join(batonDir(gitRoot), 'tasks.lock');
  await mkdir(batonDir(gitRoot), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let acquired = false;
  while (!acquired) {
    try {
      await mkdir(lock); // atomic: only one process can create it
      acquired = true;
    } catch {
      try {
        const st = await stat(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await rm(lock, { recursive: true, force: true }); // crashed holder — break it
          continue;
        }
      } catch {
        continue; // lock vanished between mkdir and stat — retry immediately
      }
      if (Date.now() >= deadline) {
        // Availability over strictness: a wedged lock must not brick task writes.
        console.warn(`[baton] tasks.lock busy for ${LOCK_TIMEOUT_MS}ms — proceeding without it`);
        break;
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    if (acquired) await rm(lock, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function addTask(gitRoot: string, task: Task): Promise<void> {
  await serialized(() =>
    withTasksLock(gitRoot, async () => {
      const tasks = await loadTasks(gitRoot);
      tasks.push(task);
      await saveTasks(gitRoot, tasks);
    }),
  );
}

export async function removeTask(gitRoot: string, slug: string): Promise<void> {
  await serialized(() =>
    withTasksLock(gitRoot, async () => {
      const tasks = (await loadTasks(gitRoot)).filter((t) => t.slug !== slug);
      await saveTasks(gitRoot, tasks);
    }),
  );
}

/** kebab-case slug from free text, made unique against `taken`. */
export function slugify(text: string, taken: string[] = []): string {
  let base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  if (!base) base = 'task';
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
