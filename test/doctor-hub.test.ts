// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { execa } from 'execa';
import { git } from '../src/util/exec.js';
import { scanShadowBatons, reconcileShadowBatons } from '../src/commands/doctor.js';

/**
 * ADD-07/C (ISS-13) — a shadow `.baton` planted inside a hub sub-project splits
 * the store so the daemon silently misses that checkout's tasks/presence.
 * `baton doctor` must surface every shadow; `--fix` removes the empty/transient
 * ones (ephemeral presence only) but NEVER an one holding real state.
 */
async function initHub(): Promise<{ hub: string; api: string; web: string }> {
  const hub = await mkdtemp(join(tmpdir(), 'baton-dhub-'));
  await mkdir(join(hub, '.baton'), { recursive: true });
  const mk = async (id: string): Promise<string> => {
    const p = join(hub, id);
    await mkdir(p, { recursive: true });
    await git(['init', '-q'], p);
    await git(['config', 'user.email', 't@t.dev'], p);
    await git(['config', 'user.name', 't'], p);
    await git(['checkout', '-q', '-b', 'main'], p);
    await git(['commit', '-q', '-m', 'init', '--allow-empty'], p);
    return p;
  };
  const api = await mk('api');
  const web = await mk('web');
  await writeFile(
    join(hub, '.baton', 'kb.json'),
    JSON.stringify({
      root: hub,
      projects: [
        { id: 'api', name: 'api', path: api, graphPath: join(api, 'graphify-out', 'graph.json') },
        { id: 'web', name: 'web', path: web, graphPath: join(web, 'graphify-out', 'graph.json') },
      ],
      mergedGraphPath: null,
      lastBuiltAt: null,
    }),
    'utf-8',
  );
  return { hub, api, web };
}

const exists = async (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

describe('doctor — hub coherence (shadow .baton detection)', () => {
  let hub: string;
  afterEach(async () => { await rm(hub, { recursive: true, force: true }); });

  it('finds a shadow .baton inside a sub-project and classifies an ephemeral-only one removable', async () => {
    const h = await initHub(); hub = h.hub;
    // A mis-resolved agent wrote only ephemeral presence into a sub-project shadow.
    await mkdir(join(h.api, '.baton'), { recursive: true });
    await writeFile(join(h.api, '.baton', 'history.db'), 'sqlite', 'utf-8');

    const shadows = await scanShadowBatons(h.hub);
    expect(shadows).toHaveLength(1);
    expect(shadows[0].projectId).toBe('api');
    expect(shadows[0].removable).toBe(true);
    expect(shadows[0].tasks).toBe(0);
  });

  it('classifies a shadow holding real tasks as NOT removable', async () => {
    const h = await initHub(); hub = h.hub;
    await mkdir(join(h.web, '.baton'), { recursive: true });
    await writeFile(
      join(h.web, '.baton', 'tasks.json'),
      JSON.stringify([{ slug: 'x', task: 'wip', branch: 'x', worktreePath: '/w', baseBranch: 'main', baseCommit: null, createdAt: '2026-01-01T00:00:00Z' }]),
      'utf-8',
    );

    const shadows = await scanShadowBatons(h.hub);
    expect(shadows).toHaveLength(1);
    expect(shadows[0].removable).toBe(false);
    expect(shadows[0].tasks).toBe(1);
  });

  // Read as "0 tasks", an unreadable shadow store was classified removable,
  // and `doctor --fix` deleted it.
  it('never classifies a shadow with an unreadable tasks.json as removable', async () => {
    const h = await initHub(); hub = h.hub;
    await mkdir(join(h.web, '.baton'), { recursive: true });
    await writeFile(join(h.web, '.baton', 'tasks.json'), '[{"slug":"x",', 'utf-8');
    const [s] = await scanShadowBatons(h.hub);
    expect(s.tasksUnreadable).toBe(true);
    expect(s.removable).toBe(false);
    const { removed } = await reconcileShadowBatons(h.hub, true);
    expect(removed).toEqual([]);
    expect(await exists(join(h.web, '.baton', 'tasks.json'))).toBe(true);
  });

  it('returns nothing when no sub-project has a shadow', async () => {
    const h = await initHub(); hub = h.hub;
    expect(await scanShadowBatons(h.hub)).toEqual([]);
  });

  it('reconcile --fix removes the ephemeral shadow but leaves the one with real state', async () => {
    const h = await initHub(); hub = h.hub;
    await mkdir(join(h.api, '.baton'), { recursive: true }); // ephemeral only
    await mkdir(join(h.web, '.baton'), { recursive: true });
    await writeFile(
      join(h.web, '.baton', 'tasks.json'),
      JSON.stringify([{ slug: 'x', task: 'wip', branch: 'x', worktreePath: '/w', baseBranch: 'main', baseCommit: null, createdAt: '2026-01-01T00:00:00Z' }]),
      'utf-8',
    );

    const { removed, kept } = await reconcileShadowBatons(h.hub, true);
    expect(removed.map((s) => s.projectId)).toEqual(['api']);
    expect(kept.map((s) => s.projectId)).toEqual(['web']);
    expect(await exists(join(h.api, '.baton'))).toBe(false); // gone
    expect(await exists(join(h.web, '.baton'))).toBe(true);  // real state preserved
  });

  it('never reports the hub root itself — a single-repo KB registers the repo as its own project', async () => {
    // What `baton kb init` writes in a plain single-repo setup: one project
    // whose path IS the root. Its `.baton` is the hub store, not a shadow of it.
    const root = await mkdtemp(join(tmpdir(), 'baton-dsolo-')); hub = root;
    await git(['init', '-q'], root); // loadKb drops a project with no .git
    await mkdir(join(root, '.baton', 'memory', 'facts'), { recursive: true });
    await writeFile(join(root, '.baton', 'memory', 'facts', 'a.md'), 'fact', 'utf-8');
    await writeFile(
      join(root, '.baton', 'tasks.json'),
      JSON.stringify([{ slug: 'x', task: 'wip', branch: 'x', worktreePath: '/w', baseBranch: 'main', baseCommit: null, createdAt: '2026-01-01T00:00:00Z' }]),
      'utf-8',
    );
    await writeFile(
      join(root, '.baton', 'kb.json'),
      JSON.stringify({
        root,
        projects: [{ id: 'solo', name: 'solo', path: root, graphPath: join(root, 'graphify-out', 'graph.json') }],
        mergedGraphPath: null,
        lastBuiltAt: null,
      }),
      'utf-8',
    );

    expect(await scanShadowBatons(root)).toEqual([]);
    // …and --fix must not touch the store it was told to "reconcile".
    const { removed, kept } = await reconcileShadowBatons(root, true);
    expect(removed).toEqual([]);
    expect(kept).toEqual([]);
    expect(await exists(join(root, '.baton', 'tasks.json'))).toBe(true);
  });

  it('reconcile dry-run removes nothing', async () => {
    const h = await initHub(); hub = h.hub;
    await mkdir(join(h.api, '.baton'), { recursive: true });

    const { removed } = await reconcileShadowBatons(h.hub, false);
    expect(removed.map((s) => s.projectId)).toEqual(['api']); // reported as removable…
    expect(await exists(join(h.api, '.baton'))).toBe(true);   // …but not actually deleted
  });
});

/**
 * `baton doctor` as a user runs it (spawned against dist/cli.js, so run
 * `npm run build` first). HOME and the fleet dir point at tmp dirs so the
 * setup checks never read this machine's real agent configs or daemons.
 */
const DIST_CLI = new URL('../dist/cli.js', import.meta.url).pathname;

describe.runIf(existsSync(DIST_CLI))('doctor — exit code and a pathless kb.json project', () => {
  let dir: string;
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function fixture(): Promise<{ repo: string; env: NodeJS.ProcessEnv }> {
    dir = await mkdtemp(join(tmpdir(), 'baton-dexit-'));
    const repo = join(dir, 'repo');
    await mkdir(join(repo, '.baton'), { recursive: true });
    await git(['init', '-q', '-b', 'main'], repo);
    await git(['config', 'user.email', 't@t.dev'], repo);
    await git(['config', 'user.name', 't'], repo);
    await git(['commit', '-q', '-m', 'init', '--allow-empty'], repo);
    // The shape that printed "points at undefined" and leaked a TypeError.
    await writeFile(join(repo, '.baton', 'kb.json'), JSON.stringify({
      root: repo, projects: [{ id: 'x', name: 'x' }], mergedGraphPath: null, lastBuiltAt: null,
    }));
    await mkdir(join(dir, 'home'), { recursive: true });
    // A stand-in graphify first on PATH, so the setup checks cannot be what
    // fails: with a kb.json present, a missing graphify is itself a ✗.
    const bin = join(dir, 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'graphify'), '#!/bin/sh\necho "graphify 0.0.0-test"\n', { mode: 0o755 });
    return { repo, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: join(dir, 'home'), BATON_DAEMONS_DIR: join(dir, 'daemons') } };
  }

  const doctor = (args: string[], repo: string, env: NodeJS.ProcessEnv) =>
    execa(process.execPath, [DIST_CLI, 'doctor', ...args], { cwd: repo, env, reject: false, timeout: 90_000 });

  it('exits 1 on a KB error and names the missing path without leaking a TypeError', async () => {
    const { repo, env } = await fixture();
    const r = await doctor([], repo, env);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("project 'x' has no path in kb.json");
    expect(r.stdout).not.toContain('undefined');
    expect(r.stderr).not.toMatch(/TypeError|must be of type string/);
    // The KB error is the ONLY failure, so it is what set the exit code.
    expect(r.stdout.split('\n').filter((l) => l.includes('✗'))).toEqual(["  ✗ project 'x' has no path in kb.json"]);
  }, 120_000);

  it('exits 0 on the same setup once the KB error is gone (control)', async () => {
    const { repo, env } = await fixture();
    await rm(join(repo, '.baton', 'kb.json'));
    const r = await doctor([], repo, env);
    expect(r.stdout).not.toContain('✗');
    expect(r.exitCode).toBe(0);
  }, 120_000);

  it('rejects --docs --fix instead of silently ignoring --fix', async () => {
    const { repo, env } = await fixture();
    const r = await doctor(['--docs', '--fix'], repo, env);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/--fix does not apply to --docs/);
  }, 120_000);
});
