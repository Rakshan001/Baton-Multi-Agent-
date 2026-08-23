// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * HANDOFF.md is Baton's artifact, not the user's work. Left untracked it lands
 * in `worktreeStatus().changedFiles`, which `baton done` feeds to the evidence
 * gate as `dirtyFiles` — and one dirty file is a hard refusal. So writing a
 * brief would make the very task it describes impossible to complete.
 *
 * Dispatch writes a brief for EVERY task, so this has to hold before anything
 * else in the dispatcher is worth building.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { worktreeStatus } from '../src/git.js';
import { handoffPath, writeBrief, type HandoffBrief } from '../src/handoff/brief.js';

async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'baton-handoff-exclude-'));
  await git(['init', '-q'], root);
  await git(['config', 'user.email', 'test@baton.dev'], root);
  await git(['config', 'user.name', 'Baton Test'], root);
  await git(['checkout', '-q', '-b', 'main'], root);
  await writeFile(join(root, 'README.md'), '# test\n', 'utf-8');
  await git(['add', '.'], root);
  await git(['commit', '-q', '-m', 'initial'], root);
  return root;
}

function briefFor(worktreePath: string): HandoffBrief {
  return {
    meta: {
      baton: 1,
      from: 'claude',
      to: 'cursor',
      author: 'claude',
      model: null,
      status: 'ready',
      created: '2026-08-19T00:00:00.000Z',
      repo: 'test',
      branch: 'main',
      est_tokens: 10,
      est_cost_usd: 0,
    } as HandoffBrief['meta'],
    markdown: '---\nbaton: 1\n---\n\nDo the thing.\n',
    path: handoffPath(worktreePath),
  };
}

describe('HANDOFF.md is kept out of the dirty-file count', () => {
  let root: string;
  beforeEach(async () => {
    root = await initRepo();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('does not report a written brief as an uncommitted change', async () => {
    await writeBrief(briefFor(root));

    const status = await worktreeStatus(root);

    expect(status.changedFiles).not.toContain('HANDOFF.md');
  });

  it('still reports the user\'s own uncommitted work', async () => {
    await writeBrief(briefFor(root));
    await writeFile(join(root, 'src.ts'), 'export const x = 1;\n', 'utf-8');

    const status = await worktreeStatus(root);

    expect(status.changedFiles).toContain('src.ts');
    expect(status.changedFiles).not.toContain('HANDOFF.md');
  });

  it('writes the exclude once, however many briefs are written', async () => {
    await writeBrief(briefFor(root));
    await writeBrief(briefFor(root));
    await writeBrief(briefFor(root));

    const exclude = await readFile(join(root, '.git', 'info', 'exclude'), 'utf-8');
    const hits = exclude.split('\n').filter((l) => l.trim() === '/HANDOFF.md');

    expect(hits).toHaveLength(1);
  });
});
