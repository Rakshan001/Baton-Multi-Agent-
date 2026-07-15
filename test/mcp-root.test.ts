import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// git canonicalizes paths (on macOS /var → /private/var), so compare real paths.
const same = async (a: string, b: string) =>
  expect(await realpath(a)).toBe(await realpath(b));
import { git } from '../src/util/exec.js';
import { createTask } from '../src/commands/new.js';
import { resolveMcpRoot } from '../src/store.js';

async function initRepo(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await git(['init', '-q'], root);
  await git(['config', 'user.email', 'test@baton.dev'], root);
  await git(['config', 'user.name', 'Baton Test'], root);
  await git(['checkout', '-q', '-b', 'main'], root);
  await writeFile(join(root, '.gitignore'), '.baton/\n', 'utf-8');
  await mkdir(join(root, '.baton'), { recursive: true }); // the real hub store
  await git(['add', '.'], root);
  await git(['commit', '-q', '-m', 'initial', '--allow-empty'], root);
  return root;
}

describe('resolveMcpRoot — coordination tools must read the hub store, not a worktree shadow', () => {
  let root: string;
  beforeEach(async () => { root = await initRepo('baton-mcproot-'); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('resolves to the repo root when called from inside a task worktree — even after the worktree was polluted with a shadow .baton', async () => {
    const task = await createTask('Fix the auth middleware', root);
    // Reproduce the bug's damage: the old gitRoot()-based code mkdir'd a
    // per-worktree .baton the first time any coordination tool ran in the worktree.
    await mkdir(join(task.worktreePath, '.baton'), { recursive: true });

    await same(await resolveMcpRoot(task.worktreePath, {}), root);
  });

  it('prefers an explicit BATON_ROOT env (how baton-spawned agents are told their hub root)', async () => {
    const task = await createTask('Add dark mode', root);
    await mkdir(join(task.worktreePath, '.baton'), { recursive: true });

    await same(await resolveMcpRoot(task.worktreePath, { BATON_ROOT: root }), root);
  });

  it('resolves a plain (non-worktree) repo checkout to the repo root', async () => {
    await same(await resolveMcpRoot(root, {}), root);
  });
});

/**
 * ADD-07/C (ISS-13) — one coherent hub DB. An agent working directly inside a
 * hub sub-project must read/write the HUB `.baton`, never a shadow `.baton` that
 * got planted inside the sub-project checkout (older buggy build, or an agent
 * that mis-resolved once). A split store silently drops that agent's tasks and
 * presence from the daemon's view.
 */
async function initHub(): Promise<{ hub: string; api: string }> {
  const hub = await mkdtemp(join(tmpdir(), 'baton-hub-'));
  await mkdir(join(hub, '.baton'), { recursive: true }); // the real hub store
  const api = join(hub, 'api');
  await mkdir(api, { recursive: true });
  await git(['init', '-q'], api);
  await git(['config', 'user.email', 'test@baton.dev'], api);
  await git(['config', 'user.name', 'Baton Test'], api);
  await git(['checkout', '-q', '-b', 'main'], api);
  await git(['commit', '-q', '-m', 'initial', '--allow-empty'], api);
  await writeFile(
    join(hub, '.baton', 'kb.json'),
    JSON.stringify({
      root: hub,
      projects: [{ id: 'api', name: 'api', path: api, graphPath: join(api, 'graphify-out', 'graph.json') }],
      mergedGraphPath: null,
      lastBuiltAt: null,
    }),
    'utf-8',
  );
  return { hub, api };
}

describe('resolveMcpRoot — a hub sub-project resolves to the hub store, not a shadow', () => {
  let hub: string;
  afterEach(async () => { await rm(hub, { recursive: true, force: true }); });

  it('resolves an agent inside a hub-owned sub-project to the HUB, not a sub-project shadow .baton (ISS-13)', async () => {
    const h = await initHub(); hub = h.hub;
    // A shadow store got planted inside the sub-project checkout. The hub's
    // kb.json lists this checkout as a project, so the shadow is illegitimate.
    await mkdir(join(h.api, '.baton'), { recursive: true });

    await same(await resolveMcpRoot(h.api, {}), h.hub);
  });

  it('does NOT hijack an independent nested repo the hub does not claim', async () => {
    const h = await initHub(); hub = h.hub;
    // vendor/ is its own git repo with its own .baton, but the hub's kb.json
    // does not list it — it is a legitimately separate Baton root.
    const vendor = join(h.hub, 'vendor');
    await mkdir(vendor, { recursive: true });
    await git(['init', '-q'], vendor);
    await mkdir(join(vendor, '.baton'), { recursive: true });

    await same(await resolveMcpRoot(vendor, {}), vendor);
  });
});
