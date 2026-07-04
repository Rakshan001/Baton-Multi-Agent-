import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadKb, saveKb, resetKbValidationWarnings, type KbState } from '../src/kb/state.js';

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'baton-kbval-'));
  await mkdir(join(root, '.baton'), { recursive: true });
  return root;
}

/** Write kb.json with the given projects (id/name derived from path). */
async function writeState(root: string, paths: string[]): Promise<void> {
  const state: KbState = {
    root,
    projects: paths.map((p, i) => ({
      id: `p${i}`, name: `p${i}`, path: p, graphPath: join(p, 'graphify-out', 'graph.json'),
    })),
    mergedGraphPath: null,
    lastBuiltAt: null,
  };
  await saveKb(root, state);
}

describe('loadKb project validation', () => {
  beforeEach(() => resetKbValidationWarnings());
  afterEach(() => vi.restoreAllMocks());

  it('keeps a valid project (dir under root with a .git dir)', async () => {
    const root = await makeRoot();
    const proj = join(root, 'api');
    await mkdir(join(proj, '.git'), { recursive: true });
    await writeState(root, [proj]);
    const kb = await loadKb(root);
    expect(kb?.projects.map((p) => p.path)).toEqual([proj]);
  });

  it('keeps a git-worktree project (.git is a file)', async () => {
    const root = await makeRoot();
    const proj = join(root, 'wt');
    await mkdir(proj, { recursive: true });
    await writeFile(join(proj, '.git'), 'gitdir: /somewhere/.git/worktrees/wt\n');
    await writeState(root, [proj]);
    const kb = await loadKb(root);
    expect(kb?.projects).toHaveLength(1);
  });

  it('accepts path === root (single-repo mode)', async () => {
    const root = await makeRoot();
    await mkdir(join(root, '.git'), { recursive: true });
    await writeState(root, [root]);
    const kb = await loadKb(root);
    expect(kb?.projects).toHaveLength(1);
  });

  it('drops a project outside the root', async () => {
    const root = await makeRoot();
    const outside = await mkdtemp(join(tmpdir(), 'baton-outside-'));
    await mkdir(join(outside, '.git'), { recursive: true });
    await writeState(root, [outside]);
    const kb = await loadKb(root);
    expect(kb?.projects).toHaveLength(0);
  });

  it('drops a symlink that escapes the root', async () => {
    const root = await makeRoot();
    const outside = await mkdtemp(join(tmpdir(), 'baton-target-'));
    await mkdir(join(outside, '.git'), { recursive: true });
    const link = join(root, 'sneaky');
    await symlink(outside, link, 'dir');
    await writeState(root, [link]);
    const kb = await loadKb(root);
    expect(kb?.projects).toHaveLength(0);
  });

  it('drops a project without .git and a missing path', async () => {
    const root = await makeRoot();
    const nogit = join(root, 'plain');
    await mkdir(nogit, { recursive: true });
    await writeState(root, [nogit, join(root, 'missing')]);
    const kb = await loadKb(root);
    expect(kb?.projects).toHaveLength(0);
  });

  it('warns once per unique bad path across repeated loads', async () => {
    const root = await makeRoot();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await writeState(root, [join(root, 'missing')]);
    await loadKb(root);
    await loadKb(root);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
