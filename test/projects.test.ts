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

  it('findNestedGitRepos sees repos regardless of a root marker', async () => {
    await writeFile(join(base, 'package.json'), '{"name":"workspace"}\n', 'utf-8');
    await initRepo(join(base, 'api'));
    await initRepo(join(base, 'web'));
    expect((await findNestedGitRepos(base)).map((x) => x.name).sort()).toEqual(['api', 'web']);
    expect(await findNestedGitRepos(join(base, 'api'))).toHaveLength(0); // a leaf repo has no nested repos
  });
});
