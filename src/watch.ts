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
import { gitTry } from './util/exec.js';
import { loadKb } from './kb/state.js';
import { registerWatchedRoot, unregisterWatchedRoot, watchedRoots } from './signals.js';

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'graphify-out', '.baton', 'dist', 'build', '.next', '__pycache__', '.venv']);
/** Editor/tool noise: vim swaps, backup~, temp files, OS cruft. */
const IGNORED_FILES = /(\.sw[a-p]x?|~|\.tmp|\.DS_Store|\.lock)$|^\.#|^#.*#$/;
const DEBOUNCE_MS = 300;
/**
 * How long a checkout probe (kb read + git rev-parse) is reused. resync fires on
 * every task lifecycle event; the checkout set changes far more slowly than
 * tasks do, so a short TTL collapses a burst of task activity into one probe
 * without meaningfully delaying a genuine checkout change.
 */
const CHECKOUT_PROBE_TTL_MS = 4_000;

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
  /** Non-task checkout slug → path currently registered in the watched_roots table. */
  private checkouts = new Map<string, string>();
  /** Cached checkout probe (kb + git), reused for CHECKOUT_PROBE_TTL_MS. */
  private checkoutProbe: { at: number; value: Map<string, string> | null } | null = null;

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
    const probed = await this.checkoutRoots();
    // A null probe means "couldn't positively determine" (git spawn failure, kb
    // momentarily unreadable). Keep the checkouts we already hold rather than
    // tearing down watchers and pruning the registry on a transient blip — read-
    // time reconcile would otherwise lose the checkout path a live signal needs.
    const checkouts = probed ?? new Map(this.checkouts);
    const desired = new Map<string, string>(); // slug → path
    for (const t of tasks) desired.set(t.slug, t.worktreePath);
    for (const [slug, path] of checkouts) desired.set(slug, path);

    for (const [slug, path] of desired) if (!this.watchers.has(slug)) this.add(slug, path);
    for (const slug of [...this.watchers.keys()]) if (!desired.has(slug)) this.remove(slug);

    // Only reconcile the persisted registry on an AUTHORITATIVE probe. On a null
    // probe leave watched_roots exactly as-is. watched_roots must mirror the
    // checkout watchers (not the task ones — tasks are resolvable via the store);
    // reconcile against the DB, not just this process's in-memory set, so a
    // crashed daemon's leftover rows are pruned on startup (the watcher is the
    // sole writer of watched_roots, so any `co-*` row not currently desired is
    // ours to drop).
    if (probed) {
      for (const [slug, path] of probed) {
        registerWatchedRoot(this.root, slug, path);
        this.checkouts.set(slug, path);
      }
      for (const slug of watchedRoots(this.root).keys()) {
        if (!probed.has(slug)) {
          unregisterWatchedRoot(this.root, slug);
          this.checkouts.delete(slug);
        }
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
   *
   * Returns `null` when it cannot POSITIVELY determine the checkout set (git
   * spawn failure, kb momentarily unreadable) so the caller leaves the watched
   * state untouched — a transient blip must never be read as "watch nothing" and
   * prune every checkout. An authoritative empty result (a real non-hub dir)
   * simply never reaches the positive branches and stays represented as null,
   * which is harmless: nothing was being watched to lose.
   */
  private async checkoutRoots(): Promise<Map<string, string> | null> {
    const now = Date.now();
    if (this.checkoutProbe && now - this.checkoutProbe.at < CHECKOUT_PROBE_TTL_MS) {
      return this.checkoutProbe.value;
    }
    const value = await this.probeCheckouts();
    this.checkoutProbe = { at: now, value };
    return value;
  }

  private async probeCheckouts(): Promise<Map<string, string> | null> {
    try {
      const kb = await loadKb(this.root);
      if (kb && kb.projects.length > 0) {
        return new Map(kb.projects.map((p) => [`co-${p.id}`, p.path]));
      }
      // No kb projects → a single-repo hub iff the root is positively a work
      // tree. rev-parse exits non-zero both when git can't run AND when the dir
      // isn't a repo; treat only a confirmed "true" as authoritative, everything
      // else as "couldn't determine" (null) so a blip can't trigger a prune.
      const probe = await gitTry(['rev-parse', '--is-inside-work-tree'], this.root);
      if (probe.ok && probe.stdout.trim() === 'true') return new Map([['co-root', this.root]]);
      return null;
    } catch {
      return null; // unexpected failure → leave watched state untouched
    }
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
    for (const slug of this.checkouts.keys()) unregisterWatchedRoot(this.root, slug);
    this.checkouts.clear();
  }
}
