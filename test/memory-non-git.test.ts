// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveMemory, readJournal, listMemories, loadRetention, NotAGitRepoError } from '../src/memory.js';

/**
 * Memory outside a git repository.
 *
 * Every memory function resolves its root through `mainRepoRoot`, which asks
 * git for `--git-common-dir`. Outside a repo that command exits 128, and the
 * raw execa message — the whole hardened argv, reprinted — used to escape to
 * the caller. An agent calling `save_memory` over MCP got that wall of text
 * instead of a sentence telling it what was wrong.
 *
 * Every other `--git-common-dir` call in the codebase already uses the
 * non-throwing `gitTry`; these were the two that did not.
 */
describe('memory outside a git repository', () => {
  let plain: string;

  beforeAll(async () => {
    plain = await mkdtemp(join(tmpdir(), 'baton-nongit-'));
  });

  afterAll(async () => {
    await rm(plain, { recursive: true, force: true });
  });

  it('saveMemory refuses with a typed error, not raw git output', async () => {
    await expect(
      saveMemory(plain, { name: 'x', description: 'd', body: 'b', type: 'project' }),
    ).rejects.toThrow(NotAGitRepoError);
  });

  it('the message names the directory and never leaks the git argv', async () => {
    const err = await saveMemory(plain, { name: 'x', description: 'd', body: 'b', type: 'project' })
      .then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(NotAGitRepoError);
    const msg = (err as Error).message;
    expect(msg).toContain(plain);
    expect(msg).not.toContain('--git-common-dir');
    expect(msg).not.toContain('core.pager');
    expect(msg).not.toContain('exit code 128');
  });

  it('reads degrade to empty rather than throwing', async () => {
    await expect(readJournal(plain)).resolves.toEqual([]);
    await expect(listMemories(plain)).resolves.toEqual([]);
    await expect(loadRetention(plain)).resolves.toEqual({});
  });
});
