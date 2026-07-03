import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kbContextCmd } from '../src/commands/kb.js';

describe('kbContextCmd', () => {
  const tmps: string[] = [];
  afterEach(async () => {
    for (const t of tmps.splice(0)) await rm(t, { recursive: true, force: true });
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  async function makeRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ctx-cli-'));
    tmps.push(dir);
    await mkdir(join(dir, '.baton'), { recursive: true }); // resolveBatonRoot anchor
    await writeFile(join(dir, 'README.md'), 'CLI test project.\n');
    return dir;
  }

  it('--out writes the pack and reports on stderr', async () => {
    const dir = await makeRepo();
    const out = join(dir, 'pack.md');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await kbContextCmd(dir, { out });
    expect(existsSync(out)).toBe(true);
    const md = await readFile(out, 'utf-8');
    expect(md).toContain('— project context pack');
    expect(md).toContain('CLI test project.');
    expect(err).toHaveBeenCalledWith(expect.stringContaining('context pack →'));
  });

  it('prints to stdout without --out', async () => {
    const dir = await makeRepo();
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => {
      writes.push(String(s));
      return true;
    }) as typeof process.stdout.write);
    await kbContextCmd(dir, {});
    spy.mockRestore();
    expect(writes.join('')).toContain('— project context pack');
  });

  it('unknown --project reports valid ids and sets exitCode', async () => {
    const dir = await makeRepo();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await kbContextCmd(dir, { project: 'nope' });
    expect(process.exitCode).toBe(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('valid:'));
  });
});
