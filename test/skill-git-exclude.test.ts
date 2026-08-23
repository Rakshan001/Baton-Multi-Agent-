// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Q22, from the Orcabaton progress log: P30's Done-when says an installed skill
 * directory "is git-excluded", and it was not.
 *
 * This is not tidiness. Baton writes the skill into the worktree it hands an
 * agent; every untracked file there lands in `worktreeStatus().changedFiles`,
 * which `baton done` passes to the evidence gate as `dirtyFiles`, where a single
 * entry is a hard refusal. Un-excluded, Baton makes the task it just briefed
 * impossible to finish — or the agent commits Baton's own scaffolding with its
 * work.
 *
 * `dispatch-resolve.ts` remembered to call `gitExcludeLocal`; the CLI and the
 * HTTP route did not. Which is the argument for doing it inside `installSkill`:
 * the invariant is "what Baton installs, Baton excludes", and an invariant that
 * every caller has to remember is one that callers will forget.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { installSkill, uninstallSkill } from '../src/skills/install.js';

let root: string;

async function excludeFile(): Promise<string> {
  try {
    return await readFile(join(root, '.git', 'info', 'exclude'), 'utf-8');
  } catch {
    return '';
  }
}

/** What `git status` would actually report as untracked. */
async function untracked(): Promise<string[]> {
  const { stdout } = await execa('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all']);
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'baton-skillx-'));
  await execa('git', ['init', '-q', '-b', 'main', root]);
  await execa('git', ['config', 'user.email', 't@t.dev'], { cwd: root });
  await execa('git', ['config', 'user.name', 't'], { cwd: root });
  await writeFile(join(root, 'README.md'), '# x\n');
  await execa('git', ['add', '-A'], { cwd: root });
  await execa('git', ['commit', '-q', '-m', 'init'], { cwd: root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('installSkill excludes what it writes', () => {
  it('leaves the repo clean after installing for claude', async () => {
    await installSkill(root, 'lean-code', 'claude');
    expect(await untracked()).toEqual([]);
  });

  // 🔴 The gap the dispatch path had too: it excluded SKILL.md by name, and
  // lean-code ships a references/ directory alongside it.
  it('excludes the reference files, not only the main skill file', async () => {
    const result = await installSkill(root, 'lean-code', 'claude');
    expect(result.references).toBeGreaterThan(0);
    expect(await untracked()).toEqual([]);
  });

  it('leaves the repo clean for cursor, whose references live in a sibling dir', async () => {
    await installSkill(root, 'lean-code', 'cursor');
    expect(await untracked()).toEqual([]);
  });

  it('leaves the repo clean for antigravity', async () => {
    await installSkill(root, 'lean-code', 'antigravity');
    expect(await untracked()).toEqual([]);
  });

  it('is idempotent — installing twice does not write the pattern twice', async () => {
    await installSkill(root, 'lean-code', 'claude');
    const once = await excludeFile();
    await installSkill(root, 'lean-code', 'claude');
    expect(await excludeFile()).toBe(once);
  });

  // Folder workspaces are a first-class case: not every root is a git repo.
  it('installs into a plain directory without a git repo', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'baton-skillx-plain-'));
    try {
      const result = await installSkill(plain, 'lean-code', 'claude');
      expect(result.wrote).toBe(true);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});

describe('uninstallSkill takes its exclusion back', () => {
  // A pattern left behind outlives the thing it was for: a hand-written skill
  // at the same path later would be invisible to git, and silently.
  it('removes the pattern it added, leaving the rest of the file alone', async () => {
    await mkdir(join(root, '.git', 'info'), { recursive: true });
    await writeFile(join(root, '.git', 'info', 'exclude'), '# theirs\n/notes.txt\n');

    await installSkill(root, 'lean-code', 'claude');
    expect(await excludeFile()).toContain('.claude/skills/lean-code');

    await uninstallSkill(root, 'lean-code', 'claude');
    const after = await excludeFile();
    expect(after).not.toContain('.claude/skills/lean-code');
    // Somebody else's lines are not ours to remove.
    expect(after).toContain('/notes.txt');
    expect(after).toContain('# theirs');
  });
})

describe('the daemon says whether it excluded', () => {
  // An Orca panel updates separately from the Baton it talks to. Without this
  // the panel has to guess, and the honest guess for an unknown daemon is the
  // pessimistic one — which would warn about untracked files that are not there.
  it('reports excluded for a git repo', async () => {
    expect((await installSkill(root, 'lean-code', 'claude')).excluded).toBe(true);
  });

  it('reports NOT excluded in a folder workspace, which is not a failure', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'baton-skillx-plain2-'));
    try {
      const result = await installSkill(plain, 'lean-code', 'claude');
      expect(result.wrote).toBe(true);
      expect(result.excluded).toBe(false);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
})
