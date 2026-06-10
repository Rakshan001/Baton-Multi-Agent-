/**
 * Per-worktree file watcher → `file.edited` events on the bus. This is what
 * powers live edit-signals ("agent X is editing auth.ts right now") without
 * waiting for a commit.
 *
 * Uses node:fs.watch({recursive}) — supported on macOS/Windows/Linux on the
 * Node 20 engine floor — so the daemon stays dependency-free.
 */
import { watch, type FSWatcher } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { bus } from './events.js';
import { batonDir, loadTasks } from './store.js';

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'graphify-out', '.baton', 'dist', 'build', '.next', '__pycache__', '.venv']);
/** Editor/tool noise: vim swaps, backup~, temp files, OS cruft. */
const IGNORED_FILES = /(\.sw[a-p]x?|~|\.tmp|\.DS_Store|\.lock)$|^\.#|^#.*#$/;
const DEBOUNCE_MS = 300;

function shouldIgnore(rel: string): boolean {
  const parts = rel.split(sep);
  if (parts.some((p) => IGNORED_DIRS.has(p))) return true;
  const base = parts[parts.length - 1] ?? '';
  return IGNORED_FILES.test(base) || base.startsWith('.');
}

export class WorktreeWatcher {
  private watchers = new Map<string, FSWatcher>(); // slug → watcher
  private pending = new Map<string, ReturnType<typeof setTimeout>>(); // slug:path → timer
  private root: string;
  private unsubs: Array<() => void> = [];

  constructor(root: string) {
    this.root = root;
  }

  async start(): Promise<void> {
    await this.resync();
    this.unsubs.push(
      bus.onType('task.created', () => void this.resync()),
      bus.onType('task.removed', (e) => {
        if (e.event.type === 'task.removed') this.remove(e.event.slug);
      }),
    );
    // Tasks created/removed by a CLI process (not through the daemon's HTTP
    // API) never hit this process's bus — watch the store file itself so the
    // daemon picks them up either way.
    try {
      const storeWatcher = watch(batonDir(this.root), (_evt, filename) => {
        if (filename?.toString() === 'tasks.json') void this.resync();
      });
      storeWatcher.on('error', () => undefined);
      this.unsubs.push(() => storeWatcher.close());
    } catch {
      /* .baton dir may not exist yet — bus events still cover the API path */
    }
  }

  /** Reconcile watchers with the task store: add new worktrees, drop gone ones. */
  private async resync(): Promise<void> {
    const tasks = await loadTasks(this.root);
    const live = new Set(tasks.map((t) => t.slug));
    for (const t of tasks) if (!this.watchers.has(t.slug)) this.add(t.slug, t.worktreePath);
    for (const slug of [...this.watchers.keys()]) if (!live.has(slug)) this.remove(slug);
  }

  add(slug: string, worktreePath: string): void {
    if (this.watchers.has(slug)) return;
    let watcher: FSWatcher;
    try {
      watcher = watch(worktreePath, { recursive: true }, (_evt, filename) => {
        if (!filename) return;
        const rel = relative(worktreePath, join(worktreePath, filename.toString()));
        if (shouldIgnore(rel)) return;
        this.debounced(slug, rel);
      });
    } catch {
      return; // worktree dir vanished — nothing to watch
    }
    watcher.on('error', () => this.remove(slug));
    this.watchers.set(slug, watcher);
  }

  private debounced(slug: string, rel: string): void {
    const key = `${slug}:${rel}`;
    const existing = this.pending.get(key);
    if (existing) clearTimeout(existing);
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        bus.publish({ type: 'file.edited', slug, path: rel, at: new Date().toISOString() });
      }, DEBOUNCE_MS),
    );
  }

  remove(slug: string): void {
    this.watchers.get(slug)?.close();
    this.watchers.delete(slug);
    for (const [key, timer] of this.pending) {
      if (key.startsWith(`${slug}:`)) {
        clearTimeout(timer);
        this.pending.delete(key);
      }
    }
  }

  stop(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    for (const slug of [...this.watchers.keys()]) this.remove(slug);
  }
}
