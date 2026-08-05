/**
 * Tiny JSON store for Baton tasks, kept at <repo>/.baton/tasks.json (gitignored).
 * One file, no database — sufficient at this scale.
 */
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gitRoot, mainRepoRoot } from './git.js';
import type { PipelineFields } from './pipeline.js';

/**
 * A recorded task.
 *
 * The `branch`/`worktreePath`/`baseCommit` trio is what a task HAS ONCE CLAIMED.
 * A planned-but-unstarted task is a row and nothing else — no branch, no
 * checkout, no disk — so twenty planned tasks cost twenty JSON objects, and the
 * base commit is read when work actually starts rather than when it was
 * imagined. They stay non-optional here because every task that exists today
 * has them; `baton take` is what will begin writing rows without them.
 */
export interface Task extends PipelineFields {
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
  /** Declared file scope (path globs) this task owns — used to warn on overlap at
   *  creation and to steer the agent's launch prompt. Advisory, not enforced. */
  scope?: string[];
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
 * True if `hub` has a `.baton/kb.json` that lists `child` as one of its
 * projects — i.e. the hub owns that checkout, so a `.baton` sitting inside
 * `child` is a shadow of the hub store (ADD-07/C · ISS-13), not a Baton root in
 * its own right. Reads kb.json raw (no validation, no `loadKb` import so store
 * stays free of a kb cycle) so a shadow is caught even before the project's
 * graph is built; realpath both sides so a symlink or `/var`↔`/private/var`
 * mismatch still matches.
 */
async function hubClaimsProject(hub: string, child: string): Promise<boolean> {
  try {
    const raw = await readFile(join(hub, '.baton', 'kb.json'), 'utf-8');
    const kb = JSON.parse(raw) as { projects?: Array<{ path?: string }> };
    if (!kb.projects?.length) return false;
    const realChild = await realpath(child).catch(() => child);
    for (const p of kb.projects) {
      if (!p.path) continue;
      const realP = await realpath(p.path).catch(() => p.path);
      if (realP === realChild) return true;
    }
    return false;
  } catch {
    return false; // no kb.json / unreadable → this dir claims nothing
  }
}

/**
 * The Baton root — the directory that owns `.baton/` (tasks, kb, memory). For a
 * single repo this is the git root; for a multi-repo hub it's the (non-git)
 * container folder. Walk up from `cwd` for the nearest `.baton/`; if there is
 * none yet, fall back to the enclosing git repo (a fresh repo not set up yet).
 * Throws only when we're neither inside a Baton project nor a git repo.
 *
 * ADD-07/C (ISS-13): the nearest `.baton` is NOT adopted blindly — if it sits
 * inside a checkout an enclosing hub claims as a project (that hub's kb.json
 * lists this dir), it is a shadow store and we resolve to the hub instead, so
 * every agent in the hub reads/writes one coherent DB. An independent nested
 * repo the hub does not claim keeps its own `.baton`.
 */
export async function resolveBatonRoot(cwd: string = process.cwd()): Promise<string> {
  let dir = cwd;
  let nearest: string | null = null;
  for (;;) {
    let owns = false;
    try { owns = await trustedBatonDir(dir); } catch { /* no .baton here */ }
    if (owns) {
      if (nearest === null) nearest = dir; // candidate root — provisionally
      else if (await hubClaimsProject(dir, nearest)) return dir; // hub owns the shadow
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  return nearest ?? gitRoot(cwd); // no .baton anywhere → the git repo is the root
}

/**
 * The Baton root for a process running ANYWHERE in the tree — the answer every
 * command that touches `.baton` state needs. Built for `baton mcp`, whose
 * agent almost always starts INSIDE its task worktree (`.baton/wt/<slug>`),
 * but the traps it avoids are not MCP's alone:
 *
 *  1. `gitRoot()` returns the WORKTREE, whose `.baton` is an empty shadow
 *     store — so tasks, signals and reviews all come back empty. This is why
 *     `baton take` used to report "no task" in the very worktree the task owns.
 *  2. `gitRoot()` THROWS on a multi-repo hub, whose root is often not a git
 *     repo at all — so the same commands died outright there.
 *  3. `resolveBatonRoot(worktreeCwd)` alone is also defeated once a worktree
 *     has been polluted with a shadow `.baton` (older buggy builds created one
 *     on the first tool call): its upward walk stops at that shadow.
 *
 * So: trust an explicit `BATON_ROOT` when a baton-spawned agent carries one;
 * otherwise escape the worktree via the git common dir FIRST, then walk up from
 * the main repo root to the owning `.baton` (past sub-repo git boundaries, so
 * hub mode still resolves to the hub, never a sub-repo).
 *
 * Use this, not `gitRoot()`, for anything reading or writing `.baton`. Reach
 * for `gitRoot()` only when you genuinely want the git checkout you are
 * standing in (deriving a slug from a worktree path, reading that worktree's
 * HANDOFF.md).
 */
export async function activeBatonRoot(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const explicit = env.BATON_ROOT?.trim();
  if (explicit) return explicit;
  try {
    return await resolveBatonRoot(await mainRepoRoot(cwd));
  } catch {
    return resolveBatonRoot(cwd); // not a git repo — best effort
  }
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

/**
 * The sub-project a slug belongs to, or null when there is none to know: a
 * single repo, an unrecorded slug, or a session that is not a task. Callers use
 * it to scope path comparisons, so null must mean "don't scope", never "no
 * project".
 */
export async function projectOf(gitRoot: string, slug?: string): Promise<string | null> {
  if (!slug) return null;
  return (await getTask(gitRoot, slug))?.projectId ?? null;
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
      // Why mkdir failed does not change what we do — wait and retry — but it
      // MUST NOT skip the deadline and the sleep. It used to: `continue` here
      // bypassed both, so any failure that was not EEXIST while the lock also
      // could not be stat'ed (.baton read-only or removed mid-run by `baton
      // clean`, EROFS, ENOSPC) spun at 100% CPU forever, blocking the
      // `serialized()` queue behind it. Measured before the fix: 2,000,001
      // iterations in 8.5s without once reaching the deadline check.
      try {
        const st = await stat(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await rm(lock, { recursive: true, force: true }); // crashed holder — break it
        }
      } catch { /* gone or unreadable — same answer: fall through and retry */ }
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

/**
 * Read-modify-write the whole task list under the lock.
 *
 * `loadTasks` then `saveTasks` from a command is a lost update waiting to
 * happen: a running daemon writes the same file, and applying a plan rewrites
 * every row rather than one. The decision has to be made against the list that
 * is about to be overwritten, not against one read a second earlier — so the
 * caller's `fn` runs INSIDE the lock and receives the current tasks.
 *
 * Returning `tasks: null` writes nothing, which is how a dry run and a refused
 * apply share exactly one code path with a real one.
 */
export async function mutateTasks<T>(
  gitRoot: string,
  fn: (tasks: Task[]) => Promise<{ tasks: Task[] | null; result: T }> | { tasks: Task[] | null; result: T },
): Promise<T> {
  return serialized(() =>
    withTasksLock(gitRoot, async () => {
      const { tasks, result } = await fn(await loadTasks(gitRoot));
      if (tasks) await saveTasks(gitRoot, tasks);
      return result;
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
