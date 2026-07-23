import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { saveKb } from '../src/kb/state.js';
import { WorktreeWatcher } from '../src/watch.js';
import { bus } from '../src/events.js';
import {
  watchedRoots, registerWatchedRoot, recordHookEdit, registerHookSession, getSignals, checkFiles,
  SIGNAL_WINDOW_MIN, PRESENCE_WINDOW_MIN,
} from '../src/signals.js';

/**
 * ADD-07/A — the daemon watcher must derive live signals from EVERY git checkout
 * in the hub (not just `baton new` worktrees), so a plain-terminal / MCP agent —
 * or a hand-edit — is visible with zero per-agent setup.
 */
async function initRepo(dir: string): Promise<void> {
  await git(['init', '-q', '-b', 'main'], dir);
  await git(['config', 'user.email', 't@t.dev'], dir);
  await git(['config', 'user.name', 't'], dir);
  await writeFile(join(dir, 'a.ts'), 'export const a = 1;\n', 'utf-8');
  await git(['add', '.'], dir);
  await git(['commit', '-qm', 'init'], dir);
}

describe('WorktreeWatcher — which checkouts it watches', () => {
  let root: string;
  let watcher: WorktreeWatcher | null = null;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'baton-watch-')); });
  afterEach(async () => { watcher?.stop(); watcher = null; await rm(root, { recursive: true, force: true }); });

  it('single-repo: watches the root itself as `co-root`', async () => {
    await initRepo(root);
    watcher = new WorktreeWatcher(root);
    await watcher.start();

    const watched = watchedRoots(root);
    expect(watched.get('co-root')).toBe(root);
    expect([...watched.keys()]).toEqual(['co-root']);
  });

  it('multi-repo hub: watches each sub-project, NOT the hub root', async () => {
    await initRepo(root);
    const api = join(root, 'api'); const web = join(root, 'web');
    await mkdir(api); await mkdir(web);
    await initRepo(api); await initRepo(web);
    await saveKb(root, {
      root,
      projects: [
        { id: 'api', name: 'api', path: api, graphPath: join(api, 'graphify-out', 'graph.json') },
        { id: 'web', name: 'web', path: web, graphPath: join(web, 'graphify-out', 'graph.json') },
      ],
      mergedGraphPath: null, lastBuiltAt: null,
    });

    watcher = new WorktreeWatcher(root);
    await watcher.start();

    const watched = watchedRoots(root);
    expect(new Set(watched.keys())).toEqual(new Set(['co-api', 'co-web']));
    expect(watched.get('co-api')).toBe(api);
    expect(watched.has('co-root')).toBe(false); // hub root skipped — sub-project watch already covers it
  });

  it('prunes stale watched_roots left by a crashed daemon on startup', async () => {
    await initRepo(root);
    // A previous daemon died without stop(), leaving a row behind. A fresh
    // process's in-memory checkout set is empty, so read-time reconcile would
    // verify signals against this dead checkout forever (finding #4).
    registerWatchedRoot(root, 'co-ghost', join(root, 'gone'));
    watcher = new WorktreeWatcher(root);
    await watcher.start();

    expect([...watchedRoots(root).keys()]).toEqual(['co-root']); // ghost reconciled away
  });

  it('does not wipe watched_roots when the checkout probe cannot positively determine (transient)', async () => {
    await initRepo(root);
    watcher = new WorktreeWatcher(root);
    await watcher.start();
    expect([...watchedRoots(root).keys()]).toEqual(['co-root']);

    // A transient blip (git spawn failure, kb momentarily unreadable) leaves the
    // probe unable to confirm a checkout set. Simulate it by removing .git so
    // rev-parse can't confirm a work tree — resync must KEEP the existing row,
    // not treat "couldn't determine" as "nothing to watch" and prune it.
    await rm(join(root, '.git'), { recursive: true, force: true });
    // Clear the short-lived probe cache so resync actually re-probes (and hits
    // the now-failing git rev-parse) rather than reusing the cached positive.
    (watcher as unknown as { checkoutProbe: unknown }).checkoutProbe = null;
    await (watcher as unknown as { resync(): Promise<void> }).resync();

    expect([...watchedRoots(root).keys()]).toEqual(['co-root']); // preserved, not wiped
  });

  it('stop() clears the watched_roots it registered (daemon owns the registry)', async () => {
    await initRepo(root);
    watcher = new WorktreeWatcher(root);
    await watcher.start();
    expect(watchedRoots(root).size).toBe(1);
    watcher.stop(); watcher = null;
    expect(watchedRoots(root).size).toBe(0);
  });
});

/**
 * What the watcher is allowed to call an "edit". fs.watch({recursive}) reports
 * the DIRECTORY as well as the file when a path inside it changes, and reports
 * a deletion as a change event. Recording those verbatim is how a real hub
 * ended up holding `bin`, `controllers`, `agent/superpowers` as "files being
 * edited right now" — 65 of one task's 791 pinned paths were directories.
 */
describe('WorktreeWatcher — what counts as an edit', () => {
  let root: string;
  let watcher: WorktreeWatcher | null = null;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'baton-watchrec-')); await initRepo(root); });
  afterEach(async () => { watcher?.stop(); watcher = null; await rm(root, { recursive: true, force: true }); });

  /**
   * Collect file.edited paths published while `fn` runs. Waits for `signal` — a
   * path the watcher MUST report — to arrive, then settles briefly so any
   * sibling events (the directory renames these tests are about) land too.
   *
   * Condition-based, not a fixed sleep: fs.watch latency plus the 300ms debounce
   * fits comfortably in a fixed wait when this file runs alone, and becomes a
   * coin flip when all 83 test files run in parallel. Polling for the signal
   * keeps the fast path fast and the loaded path correct.
   *
   * Every caller must pass EDITS_TIMEOUT. Vitest's default per-test limit is
   * 5s — less than the budget below — so under full-suite load the runner
   * killed the test while this helper was still legitimately waiting, and the
   * condition-based wait could never actually reach its own deadline.
   */
  const EDITS_TIMEOUT = 40_000; // > arm() + the 8s poll + 400ms settle, with headroom

  /**
   * Wait until the watcher is provably delivering events before the test makes
   * the change it cares about.
   *
   * fs.watch({recursive}) is backed by FSEvents on macOS, which is not yet
   * streaming when watch() returns — a change made in that window is lost
   * outright, not delayed. That is why the failure looked like a timeout but
   * was really `seen` still EMPTY after a full 8s wait: the event was never
   * coming. Rewriting the probe on a loop is deliberate — a single write issued
   * before the watch arms is gone forever, so we keep poking until one lands.
   */
  async function arm(): Promise<void> {
    const probe = '__arm.ts';
    let live = false;
    const off = bus.onType('file.edited', (e) => {
      if (e.event.type === 'file.edited' && e.event.path === probe) live = true;
    });
    try {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !live) {
        await writeFile(join(root, probe), `export const t = ${Date.now()};\n`, 'utf-8');
        // Longer than DEBOUNCE_MS (300): polling faster would keep resetting
        // the debounce and no event would ever fire.
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!live) throw new Error('fs.watch never armed — no file.edited event in 15s');
    } finally {
      off();
    }
  }

  async function edits(fn: () => Promise<void>, signal: string): Promise<string[]> {
    const seen: string[] = [];
    const off = bus.onType('file.edited', (e) => {
      if (e.event.type === 'file.edited') seen.push(e.event.path);
    });
    try {
      await fn();
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && !seen.includes(signal)) {
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => setTimeout(r, 400)); // settle: let sibling events land
      return seen;
    } finally {
      off();
    }
  }

  // Creating a nested tree reports EVERY level as a rename event — `agent`,
  // `agent/superpowers`, `agent/superpowers/specs` all arrived this way in the
  // real hub, from a single scaffold that only wrote leaf files.
  it('does not record created directories as edited files', async () => {
    watcher = new WorktreeWatcher(root);
    await watcher.start();
    await arm();

    const paths = await edits(async () => {
      await mkdir(join(root, 'controllers', 'qr'), { recursive: true });
      await writeFile(join(root, 'controllers', 'qr', 'gen.ts'), 'export const q = 1;\n', 'utf-8');
    }, 'controllers/qr/gen.ts');

    expect(paths).toContain('controllers/qr/gen.ts'); // the real edit still lands
    expect(paths).not.toContain('controllers');       // the directory levels do not
    expect(paths).not.toContain('controllers/qr');
  }, EDITS_TIMEOUT);

  /**
   * CODEBASE.md is baton's OWN generated artifact — `kb rebuild` writes one into
   * every project. The watcher then reported each write as an agent edit, so a
   * real 6-project hub showed "CODEBASE.md — 6 agents editing" with every holder
   * a `co-*` slug and no agent involved. Reconcile can't save us here: baton just
   * modified the file, so it IS genuinely dirty in git. `.baton/` and
   * `graphify-out/` are already ignored for exactly this reason; CODEBASE.md only
   * escaped because it sits at the project root instead of inside a baton dir.
   */
  it('does not record baton\'s own generated CODEBASE.md as an agent edit', async () => {
    watcher = new WorktreeWatcher(root);
    await watcher.start();
    await arm();

    const paths = await edits(async () => {
      await writeFile(join(root, 'CODEBASE.md'), '# generated by baton kb\n', 'utf-8');
      await mkdir(join(root, 'sub'), { recursive: true });
      await writeFile(join(root, 'sub', 'CODEBASE.md'), '# generated\n', 'utf-8');
      await writeFile(join(root, 'real.ts'), 'export const r = 1;\n', 'utf-8');
    }, 'real.ts');

    expect(paths).toContain('real.ts');            // genuine agent edits unaffected
    expect(paths).not.toContain('CODEBASE.md');    // baton's own write
    expect(paths).not.toContain('sub/CODEBASE.md'); // ...at any project level
  }, EDITS_TIMEOUT);

  // The stat can only type a path that still EXISTS, so a removed tree's root is
  // still recorded (see isDirectory's known limit) — read-time reconcile prunes
  // it, since git never reports a bare directory as dirty. Pinned here so the
  // gap is a documented boundary rather than a surprise.
  it('records a removed directory (cannot be typed once gone) — reconcile prunes it', async () => {
    await mkdir(join(root, 'pkg'), { recursive: true });
    await writeFile(join(root, 'pkg', 'x.ts'), 'export const x = 1;\n', 'utf-8');
    watcher = new WorktreeWatcher(root);
    await watcher.start();
    await arm();

    const paths = await edits(async () => {
      await rm(join(root, 'pkg'), { recursive: true, force: true });
    }, 'pkg');

    expect(paths).toContain('pkg');
  }, EDITS_TIMEOUT);

  // A deletion IS a real edit — an agent removing a file is holding that path,
  // and `git status` will show it. Existence is not the test; being a directory is.
  it('still records a deleted file as an edit', async () => {
    watcher = new WorktreeWatcher(root);
    await watcher.start();
    await arm();

    const paths = await edits(async () => {
      await rm(join(root, 'a.ts'));
    }, 'a.ts');

    expect(paths).toContain('a.ts');
  }, EDITS_TIMEOUT);
});

describe('checkout signals — reconcile + agent attribution', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'baton-cosig-')); await initRepo(root); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const aged = () => new Date(Date.now() - 20_000).toISOString(); // past the 15s reconcile grace

  it('prunes a settled checkout signal (file no longer dirty) but keeps a dirty one', async () => {
    registerWatchedRoot(root, 'co-root', root);
    // `a.ts` is committed/clean; `b.ts` is a live uncommitted edit.
    await writeFile(join(root, 'b.ts'), 'export const b = 2;\n', 'utf-8');
    recordHookEdit(root, { slug: 'co-root', path: 'a.ts', at: aged() }); // settled
    recordHookEdit(root, { slug: 'co-root', path: 'b.ts', at: aged() }); // still dirty

    const paths = (await getSignals(root)).map((s) => s.path);
    expect(paths).toContain('b.ts');     // uncommitted → kept
    expect(paths).not.toContain('a.ts'); // clean → reconciled away
  });

  it('layers the agent name from a session registered at the checkout', async () => {
    registerWatchedRoot(root, 'co-root', root);
    registerHookSession(root, 'sess-abc', 'cursor', root); // a cursor session working in this checkout
    await writeFile(join(root, 'b.ts'), 'export const b = 2;\n', 'utf-8');
    recordHookEdit(root, { slug: 'co-root', path: 'b.ts', at: aged() });

    const sig = (await getSignals(root, SIGNAL_WINDOW_MIN)).find((s) => s.path === 'b.ts');
    expect(sig).toBeDefined();
    expect(sig!.holders[0].agent).toBe('cursor'); // borrowed from the session at this root
  });

  // ADD-07/A finding #1: a hooked session's edit is recorded once by the guard
  // (under its own slug) and again by the daemon's fs-watch (under `co-root`).
  // The same physical edit must not surface as two holders — that fabricates a
  // conflict warning and makes the guard flag the agent's OWN file as busy.
  it('collapses the co-root fs-watch echo of a hooked session edit (no false overlap)', async () => {
    registerWatchedRoot(root, 'co-root', root);
    registerHookSession(root, 'sess-abc', 'claude', root); // a claude session at the plain checkout
    await writeFile(join(root, 'b.ts'), 'export const b = 2;\n', 'utf-8');
    recordHookEdit(root, { slug: 'sess-abc', path: 'b.ts', at: aged() }); // guard/hook write
    recordHookEdit(root, { slug: 'co-root', path: 'b.ts', at: aged() });  // fs-watch echo of the same edit

    const sig = (await getSignals(root)).find((s) => s.path === 'b.ts');
    expect(sig).toBeDefined();
    expect(sig!.holders.map((h) => h.slug)).toEqual(['sess-abc']); // echo collapsed into the session holder
    expect(sig!.level).toBe('info'); // NOT a phantom 2-holder warning
  });

  it("the guard does not report a hooked session's own file busy via the co-root echo", async () => {
    registerWatchedRoot(root, 'co-root', root);
    registerHookSession(root, 'sess-abc', 'claude', root);
    await writeFile(join(root, 'b.ts'), 'export const b = 2;\n', 'utf-8');
    recordHookEdit(root, { slug: 'sess-abc', path: 'b.ts', at: aged() });
    recordHookEdit(root, { slug: 'co-root', path: 'b.ts', at: aged() });

    // checkFiles excludes the caller's own slug; the co-root echo must not stand
    // in as a *different* holder and make the agent's own file look busy.
    const check = (await checkFiles(root, ['b.ts'], 'sess-abc'))['b.ts'];
    expect(check.busy).toBe(false);
  });

  // Review-fix #6: a departed session (last seen beyond the presence window)
  // must not keep labeling fresh signals at its old checkout.
  it('does not attribute a co-* signal from an out-of-window session', async () => {
    const gone = new Date(Date.now() - (PRESENCE_WINDOW_MIN + 5) * 60_000).toISOString();
    registerWatchedRoot(root, 'co-root', root);
    registerHookSession(root, 'sess-gone', 'cursor', root, gone); // departed
    await writeFile(join(root, 'b.ts'), 'export const b = 2;\n', 'utf-8');
    recordHookEdit(root, { slug: 'co-root', path: 'b.ts', at: aged() });

    const sig = (await getSignals(root)).find((s) => s.path === 'b.ts');
    expect(sig!.holders[0].agent).toBeNull(); // no live session here → not mislabeled
  });

  // Finding #3: attribution must resolve through path canonicalization. The
  // session registers the checkout via a symlinked path while the watcher
  // registered it by its real path — raw string keys would miss.
  it('attributes the agent across a symlinked/canonical-mismatched checkout path', async () => {
    const link = join(await mkdtemp(join(tmpdir(), 'baton-link-')), 'checkout');
    await symlink(root, link, 'dir');
    registerWatchedRoot(root, 'co-root', root);        // watcher: real path
    registerHookSession(root, 'sess-x', 'codex', link); // session: symlinked path, same dir
    await writeFile(join(root, 'b.ts'), 'export const b = 2;\n', 'utf-8');
    recordHookEdit(root, { slug: 'co-root', path: 'b.ts', at: aged() });

    const sig = (await getSignals(root)).find((s) => s.path === 'b.ts');
    expect(sig!.holders[0].agent).toBe('codex'); // resolved despite the path form differing
  });

  // Finding #3: when two sessions share a checkout, attribute to the most
  // recently seen one — not whichever the unordered scan happened to visit last.
  // The fresher session is registered FIRST so a naive last-writer-wins picks
  // the stale one.
  it('attributes a shared checkout to the most recently seen session', async () => {
    const fresh = new Date(Date.now() - 60_000).toISOString();
    const stale = new Date(Date.now() - 20 * 60_000).toISOString();
    registerWatchedRoot(root, 'co-root', root);
    registerHookSession(root, 'sess-fresh', 'codex', root, fresh);  // inserted first
    registerHookSession(root, 'sess-stale', 'cursor', root, stale); // inserted second
    await writeFile(join(root, 'b.ts'), 'export const b = 2;\n', 'utf-8');
    recordHookEdit(root, { slug: 'co-root', path: 'b.ts', at: aged() });

    const sig = (await getSignals(root)).find((s) => s.path === 'b.ts');
    expect(sig!.holders[0].agent).toBe('codex'); // freshest session wins, not last-inserted
  });
});
