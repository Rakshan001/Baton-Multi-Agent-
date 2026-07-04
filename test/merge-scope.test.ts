import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectForRepo } from '../src/commands/merge.js';
import type { KbProject } from '../src/kb/state.js';

const proj = (id: string, path: string): KbProject => ({
  id, name: id, path, graphPath: join(path, 'graphify-out', 'graph.json'),
});

describe('projectForRepo', () => {
  it('matches the project whose path is the merged repo', async () => {
    const base = await mkdtemp(join(tmpdir(), 'baton-scope-'));
    const a = join(base, 'a'); const b = join(base, 'b');
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    const hit = await projectForRepo([proj('a', a), proj('b', b)], b);
    expect(hit?.id).toBe('b');
  });

  it('matches through symlinks (realpath compare)', async () => {
    const base = await mkdtemp(join(tmpdir(), 'baton-scope2-'));
    const real = join(base, 'real');
    await mkdir(real, { recursive: true });
    const alias = join(base, 'alias');
    await symlink(real, alias, 'dir');
    const hit = await projectForRepo([proj('real', real)], alias);
    expect(hit?.id).toBe('real');
  });

  it('returns null when nothing matches or the repo path is missing', async () => {
    const base = await mkdtemp(join(tmpdir(), 'baton-scope3-'));
    const a = join(base, 'a');
    await mkdir(a, { recursive: true });
    expect(await projectForRepo([proj('a', a)], join(base, 'other'))).toBeNull();
    expect(await projectForRepo([], a)).toBeNull();
  });
});
