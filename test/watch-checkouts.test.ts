import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { saveKb } from '../src/kb/state.js';
import { WorktreeWatcher } from '../src/watch.js';
import {
  watchedRoots, registerWatchedRoot, recordHookEdit, registerHookSession, getSignals, checkFiles, SIGNAL_WINDOW_MIN,
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

  it('stop() clears the watched_roots it registered (daemon owns the registry)', async () => {
    await initRepo(root);
    watcher = new WorktreeWatcher(root);
    await watcher.start();
    expect(watchedRoots(root).size).toBe(1);
    watcher.stop(); watcher = null;
    expect(watchedRoots(root).size).toBe(0);
  });
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
