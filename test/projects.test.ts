import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { detectProjects, findNestedGitRepos } from '../src/kb/projects.js';

async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(['init', '-q'], dir);
  await writeFile(join(dir, 'package.json'), '{"name":"x"}\n', 'utf-8');
}
async function pkgDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), '{"name":"y"}\n', 'utf-8');
}

describe('detectProjects / findNestedGitRepos', () => {
  let base: string;
  beforeEach(async () => { base = await mkdtemp(join(tmpdir(), 'baton-proj-')); });
  afterEach(async () => { await rm(base, { recursive: true, force: true }); });

  it('a single repo (root marker, no nested git) → one project at root', async () => {
    await initRepo(base);
    const p = await detectProjects(base);
    expect(p).toHaveLength(1);
    expect(p[0].path).toBe(base);
  });

  it('a container of ≥2 git repos (no root marker) → one project per repo', async () => {
    await initRepo(join(base, 'api'));
    await initRepo(join(base, 'web'));
    const p = await detectProjects(base);
    expect(p.map((x) => x.name).sort()).toEqual(['api', 'web']);
  });

  it('REGRESSION FIX: container with ≥2 git repos AND its own root package.json still splits per-repo', async () => {
    await writeFile(join(base, 'package.json'), '{"name":"workspace"}\n', 'utf-8'); // shared root tooling
    await initRepo(join(base, 'api'));
    await initRepo(join(base, 'web'));
    const p = await detectProjects(base);
    expect(p.map((x) => x.name).sort()).toEqual(['api', 'web']); // not collapsed to [root]
  });

  it('a monorepo (root marker, nested packages without their own .git) → one project at root', async () => {
    await initRepo(base);                 // the monorepo itself is the only git repo
    await pkgDir(join(base, 'packages', 'a'));
    await pkgDir(join(base, 'packages', 'b'));
    const p = await detectProjects(base);
    expect(p).toHaveLength(1);
    expect(p[0].path).toBe(base);
  });

  it('REGRESSION FIX: linked worktrees of an indexed repo are not projects of their own', async () => {
    await initRepo(join(base, 'api'));
    await initRepo(join(base, 'web'));
    // What `baton new` (and `git worktree add`) leaves behind, in both layouts
    // seen in the wild: a worktrees/ container and a sibling at the root.
    await git(['worktree', 'add', '-q', '-b', 'task-a', join(base, 'worktrees', 'wt-a')], join(base, 'api'));
    await git(['worktree', 'add', '-q', '-b', 'task-b', join(base, 'wt-b')], join(base, 'api'));

    const p = await detectProjects(base);
    expect(p.map((x) => x.name).sort()).toEqual(['api', 'web']); // not 4 projects
  });

  it('a submodule keeps its own project (its .git file points at modules/, not worktrees/)', async () => {
    await initRepo(join(base, 'lib'));
    await git(['commit', '-qm', 'init', '--allow-empty'], join(base, 'lib'));
    await initRepo(join(base, 'app'));
    await git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', join(base, 'lib'), 'vendored'], join(base, 'app'));

    expect((await findNestedGitRepos(base)).map((x) => x.name).sort()).toEqual(['app', 'lib']);
    expect((await findNestedGitRepos(join(base, 'app'))).map((x) => x.name)).toEqual(['vendored']);
  });

  /**
   * The id is interpolated into a TOML table header in the user's GLOBAL
   * ~/.codex/config.toml and into the daemon's proxy route, whose regex is
   * [A-Za-z0-9._-]+. A newline in a directory name produced an illegal TOML
   * basic string that left the whole file unparseable — breaking every MCP
   * server the user had, not just Baton's — and a space produced an id that
   * could never match its own route (a silently dead graph server).
   */
  it('sanitizes project ids to the charset the proxy route and TOML can carry', async () => {
    await initRepo(join(base, 'my app'));      // space → dead route
    await initRepo(join(base, 'we\nird"one')); // newline + quote → unparseable TOML
    await initRepo(join(base, 'plain'));

    const ids = (await findNestedGitRepos(base)).map((p) => p.id).sort();
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9._-]+$/); // the route regex, exactly
    }
    expect(ids).toEqual(['my-app', 'plain', 'we-ird-one']);
    // The human-facing name is untouched — only the id is constrained.
    const names = (await findNestedGitRepos(base)).map((p) => p.name).sort();
    expect(names).toContain('my app');
  });

  it('keeps ids unique and non-empty after sanitizing collapses them together', async () => {
    await initRepo(join(base, 'a b'));
    await initRepo(join(base, 'a-b'));
    const ids = (await findNestedGitRepos(base)).map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length); // no collision
    expect(ids.every((i) => i.length > 0)).toBe(true);
  });

  it('findNestedGitRepos sees repos regardless of a root marker', async () => {
    await writeFile(join(base, 'package.json'), '{"name":"workspace"}\n', 'utf-8');
    await initRepo(join(base, 'api'));
    await initRepo(join(base, 'web'));
    expect((await findNestedGitRepos(base)).map((x) => x.name).sort()).toEqual(['api', 'web']);
    expect(await findNestedGitRepos(join(base, 'api'))).toHaveLength(0); // a leaf repo has no nested repos
  });
});
