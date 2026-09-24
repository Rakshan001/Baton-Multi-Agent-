// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Phase 4a: `collectWorktrees` lists every worktree git knows, marked by kind,
 * and gives every non-task row an id no task slug and no other row can share.
 *
 * Real repos under a realpath'd root, because the classification reads git's
 * own porcelain list and the paths it reports.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { createTask } from '../src/commands/new.js';
import { isSafeProgressSlug } from '../src/handoff/progress-ledger.js';
import { collectWorktrees, worktreeId, type WorktreeRow } from '../src/worktrees.js';
import { demoWorktrees } from '../web/src/lib/demoWorktrees.js';

const ID_GRAMMAR = /^[A-Za-z0-9._-]{1,40}~[0-9a-f]{10}$/;
const KINDS = ['task', 'orphan', 'main', 'external'];

async function initRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@t.t'], ['config', 'user.name', 'T'],
    ['config', 'core.hooksPath', '/dev/null'], ['commit', '--allow-empty', '-qm', 'init']]) {
    await execa('git', a, { cwd: dir });
  }
}

const git = (cwd: string, ...args: string[]) => execa('git', args, { cwd });
const byPath = (rows: WorktreeRow[], p: string) => rows.filter((r) => r.worktreePath === p);
const isBaton = (r: WorktreeRow) => r.kind === 'task' || r.kind === 'orphan';

describe('worktreeId', () => {
  it('is stable, grammar-shaped, and never a task slug or a ledger key', () => {
    const id = worktreeId('/repo/.baton/wt/nested/alpha');
    expect(id).toMatch(ID_GRAMMAR);
    expect(id.startsWith('alpha~')).toBe(true);
    expect(worktreeId('/repo/.baton/wt/nested/alpha')).toBe(id);
    expect(worktreeId('/repo/.baton/wt/alpha')).not.toBe(id);
    // A name no slug could carry still yields a grammar-shaped id.
    expect(worktreeId('/x/My Work (copy)!')).toMatch(ID_GRAMMAR);
    expect(worktreeId('/')).toMatch(ID_GRAMMAR);
    // The progress route can never read a non-task row's ledger.
    expect(isSafeProgressSlug(id)).toBe(false);
  });

  it('pins every non-task demo id to the daemon id for its path', () => {
    for (const r of demoWorktrees().filter((x) => x.kind !== 'task')) {
      expect(r.slug, r.worktreePath).toBe(worktreeId(r.worktreePath));
    }
  });
});

describe('collectWorktrees — every worktree git knows', { timeout: 60_000 }, () => {
  let base: string;
  let root: string;
  let rows: WorktreeRow[];
  let alphaPath: string;

  beforeAll(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), 'baton-cover-')));
    root = join(base, 'repo');
    await initRepo(root);
    alphaPath = (await createTask('alpha', root)).worktreePath;
    await git(root, 'worktree', 'add', '-q', '-b', 'feature', join(base, 'plain'));
    await git(root, 'worktree', 'add', '-q', '-b', 'cx', join(root, '.claude', 'worktrees', 'cx'));
    await git(root, 'worktree', 'add', '-q', '--detach', join(root, '.baton', 'wt', 'det'));
    await git(root, 'worktree', 'add', '-q', '-b', 'baton/alpha-dup', join(root, '.baton', 'wt', 'nested', 'alpha'));
    // Prunable: git still records it, the directory is gone.
    await git(root, 'worktree', 'add', '-q', '-b', 'gone', join(base, 'gone'));
    await rm(join(base, 'gone'), { recursive: true, force: true });
    rows = await collectWorktrees(root);
  });
  afterAll(async () => { await rm(base, { recursive: true, force: true }); });

  it('gives an orphan named like a task its own stable id', async () => {
    const slugs = rows.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(rows.find((r) => r.kind === 'task')!.slug).toBe('alpha');
    const dup = byPath(rows, join(root, '.baton', 'wt', 'nested', 'alpha'))[0]!;
    expect(dup.kind).toBe('orphan');
    expect(dup.slug).toMatch(ID_GRAMMAR);
    const again = await collectWorktrees(root);
    expect(again.find((r) => r.worktreePath === dup.worktreePath)!.slug).toBe(dup.slug);
  });

  it('marks every row with its kind, and orphan exactly when the kind says so', () => {
    for (const r of rows) {
      expect(KINDS).toContain(r.kind);
      expect(r.orphan).toBe(r.kind === 'orphan');
    }
  });

  it('lists the main checkout as kind main, health unmanaged, with its branch', () => {
    const [main] = byPath(rows, root);
    expect(main).toMatchObject({ kind: 'main', health: 'unmanaged', branch: 'main', state: null });
    expect(main!.slug).toMatch(ID_GRAMMAR);
    expect(main!.filesChanged).toBeNull();
  });

  it('lists a plain `git worktree add` and .claude/worktrees/x as external', () => {
    expect(byPath(rows, join(base, 'plain'))[0]).toMatchObject({ kind: 'external', health: 'unmanaged', branch: 'feature' });
    expect(byPath(rows, join(root, '.claude', 'worktrees', 'cx'))[0]).toMatchObject({ kind: 'external', health: 'unmanaged' });
  });

  it('still calls a baton-owned worktree with no task an orphan', () => {
    expect(byPath(rows, join(root, '.baton', 'wt', 'nested', 'alpha'))[0]).toMatchObject({ kind: 'orphan', health: 'orphan-disk' });
  });

  it('reports branch null for a detached orphan, never an empty string', () => {
    expect(byPath(rows, join(root, '.baton', 'wt', 'det'))[0]).toMatchObject({ kind: 'orphan', branch: null });
  });

  it('does not list a prunable external whose directory is gone', () => {
    expect(byPath(rows, join(base, 'gone'))).toHaveLength(0);
  });

  it('lists the task row once, as the task', () => {
    expect(rows.filter((r) => r.kind === 'task').map((r) => r.slug)).toEqual(['alpha']);
    expect(rows.filter((r) => realpathSync(r.worktreePath) === realpathSync(alphaPath))).toHaveLength(1);
  });

  it('sorts every Baton row before every unmanaged row, main first', () => {
    const firstUnmanaged = rows.findIndex((r) => !isBaton(r));
    expect(firstUnmanaged).toBeGreaterThan(0);
    expect(rows.slice(firstUnmanaged).every((r) => !isBaton(r))).toBe(true);
    expect(rows[firstUnmanaged]!.kind).toBe('main');
  });

  it('tasksOnly returns the task rows and nothing else', async () => {
    const only = await collectWorktrees(root, { tasksOnly: true });
    expect(only.map((r) => r.kind)).toEqual(['task']);
  });
});

describe('collectWorktrees — a multi-repo hub', { timeout: 60_000 }, () => {
  let hub: string;

  beforeAll(async () => {
    hub = realpathSync(await mkdtemp(join(tmpdir(), 'baton-cover-hub-')));
    const api = join(hub, 'api');
    const web = join(hub, 'web');
    await initRepo(api);
    await initRepo(web);
    const wt = join(hub, '.baton', 'wt', 'api-task');
    await git(api, 'worktree', 'add', '-q', '-b', 'baton/api-task', wt);
    await git(api, 'worktree', 'add', '-q', '-b', 'side', join(hub, 'api-side'));
    await git(web, 'worktree', 'add', '-q', '-b', 'baton/ghost', join(hub, 'ghost'));
    await mkdir(join(hub, '.baton'), { recursive: true });
    const at = '2026-09-21T09:00:00.000Z';
    await writeFile(join(hub, '.baton', 'tasks.json'), JSON.stringify([{
      slug: 'api-task', task: 'api work', branch: 'baton/api-task', worktreePath: wt, repoRoot: api,
      baseBranch: 'main', baseCommit: 'HEAD', createdAt: at, state: 'active',
    }]));
    const project = (id: string, path: string) => ({ id, name: id, path, graphPath: join(path, 'graphify-out', 'graph.json') });
    // `web` twice and `hub` itself: each repo is still listed exactly once.
    await writeFile(join(hub, '.baton', 'kb.json'), JSON.stringify({
      root: hub, projects: [project('api', api), project('web', web), project('web2', web), project('hub', hub)],
      mergedGraphPath: null, lastBuiltAt: null,
    }));
  });
  afterAll(async () => { await rm(hub, { recursive: true, force: true }); });

  it("lists a hub's sub-project mains, externals and orphans, each exactly once", async () => {
    const rows = await collectWorktrees(hub);
    const paths = rows.map((r) => r.worktreePath);
    expect(new Set(paths).size).toBe(paths.length);
    const kindOf = (p: string) => rows.filter((r) => r.worktreePath === p).map((r) => r.kind);
    expect(kindOf(join(hub, 'api'))).toEqual(['main']);
    expect(kindOf(join(hub, 'web'))).toEqual(['main']);
    expect(kindOf(join(hub, 'api-side'))).toEqual(['external']);
    expect(kindOf(join(hub, 'ghost'))).toEqual(['orphan']);
    expect(kindOf(join(hub, '.baton', 'wt', 'api-task'))).toEqual(['task']);
    // The hub is not a repo: nothing from any git repo above it is listed.
    expect(rows.every((r) => r.worktreePath.startsWith(hub))).toBe(true);
  });
});

describe('collectWorktrees — a root that is a linked worktree of an outer repo', { timeout: 60_000 }, () => {
  let base: string;
  afterAll(async () => { if (base) await rm(base, { recursive: true, force: true }); });

  it("keeps the orphans under root and drops the outer repo's main", async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), 'baton-cover-linked-')));
    const outer = join(base, 'outer');
    await initRepo(outer);
    const root = join(base, 'root');
    await git(outer, 'worktree', 'add', '-q', '-b', 'rootbranch', root);
    await git(root, 'worktree', 'add', '-q', '-b', 'baton/o2', join(root, '.baton', 'wt', 'o2'));
    const rows = await collectWorktrees(root);
    expect(rows.some((r) => r.worktreePath === outer)).toBe(false);
    expect(byPath(rows, join(root, '.baton', 'wt', 'o2'))[0]).toMatchObject({ kind: 'orphan', branch: 'baton/o2' });
    // The checkout the daemon serves is this project's main, not an external.
    expect(byPath(rows, root).map((r) => r.kind)).toEqual(['main']);
  });
});

describe('collectWorktrees — an orphan\'s risk', { timeout: 60_000 }, () => {
  let base: string;
  afterAll(async () => { if (base) await rm(base, { recursive: true, force: true }); });

  it('is at risk while its directory holds files, and not once the directory is gone', async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), 'baton-cover-risk-')));
    const root = join(base, 'repo');
    await initRepo(root);
    const live = join(root, '.baton', 'wt', 'live');
    const gone = join(root, '.baton', 'wt', 'gone');
    await git(root, 'worktree', 'add', '-q', '-b', 'baton/live', live);
    await git(root, 'worktree', 'add', '-q', '-b', 'baton/gone', gone);
    await writeFile(join(live, 'unsaved.txt'), 'nobody committed this');
    await rm(gone, { recursive: true, force: true });
    const rows = await collectWorktrees(root);
    expect(byPath(rows, live)[0]).toMatchObject({ kind: 'orphan', unprotected: { atRisk: true } });
    expect(byPath(rows, gone)[0]).toMatchObject({ kind: 'orphan', unprotected: { atRisk: false } });
  });
});

describe('collectWorktrees — edge repos', { timeout: 60_000 }, () => {
  let base: string;
  afterAll(async () => { if (base) await rm(base, { recursive: true, force: true }); });

  it('does not list the main twice when a kb project is the root itself', async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), 'baton-cover-edge-')));
    const root = join(base, 'solo');
    await initRepo(root);
    await mkdir(join(root, '.baton'), { recursive: true });
    await writeFile(join(root, '.baton', 'kb.json'), JSON.stringify({
      root, projects: [{ id: 'solo', name: 'solo', path: root, graphPath: join(root, 'g.json') }],
      mergedGraphPath: null, lastBuiltAt: null,
    }));
    const rows = await collectWorktrees(root);
    expect(rows.filter((r) => r.kind === 'main')).toHaveLength(1);
  });

  it('does not list a non-git hub nested inside an outer repo as that repo', async () => {
    const outer = join(base, 'outer');
    await initRepo(outer);
    const inner = join(outer, 'hub');
    await mkdir(join(inner, '.baton'), { recursive: true });
    expect(await collectWorktrees(inner)).toEqual([]);
  });

  it('skips a bare main, but still lists the worktrees it carries', async () => {
    const root = join(base, 'bare-layout');
    await execa('git', ['init', '-q', '--bare', '-b', 'main', join(root, '.bare')]);
    await writeFile(join(root, '.git'), 'gitdir: ./.bare\n');
    const seed = join(base, 'seed');
    await initRepo(seed);
    await git(seed, 'push', '-q', join(root, '.bare'), 'main');
    await git(root, 'worktree', 'add', '-q', join(root, 'main-wt'), 'main');
    const rows = await collectWorktrees(root);
    expect(rows.some((r) => r.worktreePath === join(root, '.bare'))).toBe(false);
    expect(rows.filter((r) => r.worktreePath === join(root, 'main-wt')).map((r) => r.kind)).toEqual(['external']);
  });
});
