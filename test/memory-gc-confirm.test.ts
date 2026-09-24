// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listMemories, saveMemory } from '../src/memory.js';
import { memoryGcCmd } from '../src/commands/memory.js';

/**
 * `baton memory gc` deletes user knowledge. The plan
 * (baton/plans/memory-self-improving.md, memory-repair-wire) says it "reports
 * what it would remove and requires confirmation for anything it cannot
 * mechanically justify" — the command did neither: it repaired, then deleted,
 * and printed the obituary afterwards.
 *
 * Non-TTY is the sharp case. A script cannot answer a prompt, and a prompt that
 * silently takes its safe default reads as "it worked"; so gc must say out loud
 * that it removed nothing and fail, exactly as `baton skills remove` does.
 */
describe('baton memory gc — preview and confirmation', () => {
  let root: string;
  let out: string[];
  const g = (args: string[]) => execa('git', args, { cwd: root });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-gc-confirm-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await g(['init', '-q']);
    await g(['config', 'user.email', 't@t.t']);
    await g(['config', 'user.name', 'T']);
    await writeFile(join(root, 'src', 'server.ts'), 'const CSRF_GUARD = true;\nfunction other() { return 1; }\n');
    await g(['add', '.']);
    await g(['commit', '-qm', 'init']);
    process.env.BATON_ROOT = root;

    out = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    process.exitCode = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    delete process.env.BATON_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  /** A fact repair CANNOT rescue: the term survives, the value it asserts flipped. */
  async function unrescuableStaleFact(): Promise<string> {
    const saved = await saveMemory(root, {
      fact: 'CSRF_GUARD is enabled in src/server.ts — the guard is central, never per-endpoint',
      type: 'convention', files: ['src/server.ts'],
    });
    await writeFile(join(root, 'src', 'server.ts'), 'const CSRF_GUARD = false;\nfunction other() { return 1; }\n');
    await g(['commit', '-qam', 'flip the guard']);
    expect((await listMemories(root)).find((f) => f.id === saved.id)!.freshness).toBe('stale');
    return saved.id;
  }

  const ids = async () => (await listMemories(root)).map((f) => f.id);

  it('--dry-run names what would go and removes nothing', async () => {
    const id = await unrescuableStaleFact();

    await memoryGcCmd({ dryRun: true });

    const text = out.join('\n');
    expect(text).toContain(id);
    expect(text.toLowerCase()).toContain('dry run');
    expect(await ids()).toContain(id); // still there
  });

  it('removes nothing without confirmation when there is no terminal, and fails loudly', async () => {
    const id = await unrescuableStaleFact();
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    await memoryGcCmd({});

    expect(await ids()).toContain(id);
    expect(out.join('\n')).toMatch(/--yes/);
    expect(process.exitCode).toBe(1);
  });

  it('--yes is the escape hatch scripts get: it removes without asking', async () => {
    const id = await unrescuableStaleFact();
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    await memoryGcCmd({ yes: true });

    expect(await ids()).not.toContain(id);
    expect(out.join('\n')).toContain(id);
    expect(process.exitCode).toBeUndefined();
  });

  it('says nothing is stale without asking anything', async () => {
    await saveMemory(root, {
      fact: 'CSRF_GUARD is enabled in src/server.ts — the guard is central, never per-endpoint',
      type: 'convention', files: ['src/server.ts'],
    });
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    await memoryGcCmd({});

    expect(out.join('\n')).toContain('nothing stale');
    expect(process.exitCode).toBeUndefined();
  });
});
