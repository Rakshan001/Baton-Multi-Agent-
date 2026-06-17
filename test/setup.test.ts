import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { classifyTarget } from '../src/commands/setup.js';

async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(['init', '-q'], dir);
  await writeFile(join(dir, 'package.json'), '{"name":"x"}\n', 'utf-8');
}

describe('classifyTarget', () => {
  let base: string;
  beforeEach(async () => { base = await mkdtemp(join(tmpdir(), 'baton-setup-')); });
  afterEach(async () => { await rm(base, { recursive: true, force: true }); });

  it('A: a single git repo', async () => {
    await initRepo(base);
    expect((await classifyTarget(base)).kind).toBe('single-repo');
  });

  it('B: container with ≥2 git sub-repos', async () => {
    await initRepo(join(base, 'api'));
    await initRepo(join(base, 'web'));
    const t = await classifyTarget(base);
    expect(t.kind).toBe('multi-repo');
    if (t.kind === 'multi-repo') expect(t.repos.length).toBe(2);
  });

  it('C: container with exactly 1 git sub-repo', async () => {
    await initRepo(join(base, 'api'));
    const t = await classifyTarget(base);
    expect(t.kind).toBe('single-subrepo');
    if (t.kind === 'single-subrepo') expect(t.repo.name).toBe('api');
  });

  it('D: non-git folder with project markers', async () => {
    await writeFile(join(base, 'package.json'), '{}\n', 'utf-8');
    expect((await classifyTarget(base)).kind).toBe('bare-project');
  });

  it('E: empty folder', async () => {
    expect((await classifyTarget(base)).kind).toBe('empty');
  });

  it('F: an already-initialized hub (container is a git repo AND holds ≥2 sub-repos) stays multi-repo', async () => {
    await git(['init', '-q'], base);  // hub root already `git init`-ed (re-run case), no marker of its own
    await initRepo(join(base, 'api'));
    await initRepo(join(base, 'web'));
    const t = await classifyTarget(base);
    expect(t.kind).toBe('multi-repo');
    if (t.kind === 'multi-repo') expect(t.repos.length).toBe(2);
  });

  it('G: a container with ≥2 sub-repos AND its own root package.json is still multi-repo', async () => {
    await writeFile(join(base, 'package.json'), '{"name":"workspace"}\n', 'utf-8'); // shared root tooling
    await initRepo(join(base, 'api'));
    await initRepo(join(base, 'web'));
    const t = await classifyTarget(base);
    expect(t.kind).toBe('multi-repo');
    if (t.kind === 'multi-repo') expect(t.repos.length).toBe(2);
  });
});
