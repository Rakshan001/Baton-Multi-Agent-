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
import { isGitRepo } from './git.js';
import { loadKb } from './kb/state.js';
import { registerWatchedRoot, unregisterWatchedRoot, watchedRoots } from './signals.js';

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
  /** Non-task checkout slugs currently registered in the watched_roots table. */
  private checkouts = new Set<string>();

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

  /**
   * Reconcile watchers with what should be watched: every `baton new` task
   * worktree PLUS every non-task git checkout in the hub (ADD-07/A) — the hub
   * root in a single-repo setup, or each sub-project in a multi-repo hub — so a
   * plain-terminal / MCP agent (or a hand-edit) produces live signals with zero
   * per-agent setup. Adds new watchers, drops gone ones, and keeps the
   * watched_roots registry (which read-time reconcile + agent attribution lean
   * on) in step with the checkout watchers we actually hold.
   */
  private async resync(): Promise<void> {
    const tasks = await loadTasks(this.root);
    const checkouts = await this.checkoutRoots();
    const desired = new Map<string, string>(); // slug → path
    for (const t of tasks) desired.set(t.slug, t.worktreePath);
    for (const [slug, path] of checkouts) desired.set(slug, path);

    for (const [slug, path] of desired) if (!this.watchers.has(slug)) this.add(slug, path);
    for (const slug of [...this.watchers.keys()]) if (!desired.has(slug)) this.remove(slug);

    // watched_roots must mirror the checkout watchers (not the task ones — tasks
    // are already resolvable via the task store).
    for (const [slug, path] of checkouts) {
      registerWatchedRoot(this.root, slug, path);
      this.checkouts.add(slug);
    }
    // Reconcile against the DB, not just this process's in-memory set: a crashed
    // daemon leaves rows behind and a fresh process starts with `this.checkouts`
    // empty, so read-time reconcile would verify signals against a dead checkout
    // forever (finding #4). The watcher is the sole writer of watched_roots, so
    // any `co-*` row not in the current checkout set is ours to prune.
    for (const slug of watchedRoots(this.root).keys()) {
      if (!checkouts.has(slug)) {
        unregisterWatchedRoot(this.root, slug);
        this.checkouts.delete(slug);
      }
    }
  }

  /**
   * The non-task git checkouts to watch. In a multi-repo hub these are the
   * sub-projects (the real checkouts); we skip the hub root there so a recursive
   * root watch doesn't double-count files a sub-project watch already sees. In a
   * single-repo setup the root itself IS the checkout an agent works in (no
   * worktree), which is exactly the case that currently shows nothing.
   *
   * KNOWN LIMIT (finding #2): a checkout is watched under ONE slug (`co-<id>`),
   * so fs-watch attributes an edit to the *checkout*, not the *agent*. When two
   * agents share one plain checkout and edit the same file, the `(slug, path)`
   * signal collapses to a single holder and no overlap `warning` fires. Reliable
   * per-agent attribution there requires the edit hook (which records under each
   * session's own slug); agent-agnostic fs-watch capture cannot and does not
   * replace it. Do not paper over this by guessing an agent for `co-*` edits.
   */
  private async checkoutRoots(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    try {
      const kb = await loadKb(this.root);
      if (kb && kb.projects.length > 0) {
        for (const p of kb.projects) out.set(`co-${p.id}`, p.path);
      } else if (await isGitRepo(this.root)) {
        out.set('co-root', this.root);
      }
    } catch {
      /* kb/git probing is best-effort — task watchers still work without it */
    }
    return out;
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
    // The daemon owns the watched_roots registry — clear our checkouts so a
    // fresh CLI process doesn't reconcile against roots nobody is watching.
    for (const slug of [...this.checkouts]) unregisterWatchedRoot(this.root, slug);
    this.checkouts.clear();
  }
}
