// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `-z` porcelain parsing (phase 5, §1) — `worktreeStatus`'s status call gained
 * `-z` so a path containing `"`, `\`, a tab or a newline renders literally
 * instead of C-quoted, and the parse now keeps the XY status + rename/copy
 * info that the old newline parser threw away.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, appendFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, gitTry } from '../src/util/exec.js';
import { worktreeStatus, parsePorcelainZ } from '../src/git.js';
import { usePrivateHome } from './helpers/private-home.js';

usePrivateHome('baton-status-z-home-');

async function initRepo(prefix: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), prefix));
  await git(['init', '-q', '-b', 'main'], repo);
  await git(['config', 'user.email', 't@t.dev'], repo);
  await git(['config', 'user.name', 't'], repo);
  await git(['config', 'status.renames', 'true'], repo);
  await git(['config', 'diff.renames', 'true'], repo);
  return repo;
}

describe('worktreeStatus -z parsing', () => {
  let repo: string;

  async function commitFile(name: string, body = 'x\n'): Promise<void> {
    await writeFile(join(repo, name), body, 'utf-8');
    await git(['add', '-A'], repo);
    await git(['commit', '-qm', name], repo);
  }

  it('a quoted-under-default path renders literally under -z', async () => {
    repo = await initRepo('baton-z-quote-');
    await writeFile(join(repo, 'we"ird.txt'), 'x\n', 'utf-8');
    await writeFile(join(repo, 'back\\slash.txt'), 'x\n', 'utf-8');

    // Prove the fix is real: the SAME repo, without -z, C-quotes both names.
    const unquoted = await gitTry(['-C', repo, 'status', '--porcelain=v2', '--untracked-files=all']);
    expect(unquoted.stdout).toContain('"we\\"ird.txt"');
    expect(unquoted.stdout).toContain('"back\\\\slash.txt"');

    const st = await worktreeStatus(repo);
    const paths = st.files.map((f) => f.path).sort();
    expect(paths).toEqual(['back\\slash.txt', 'we"ird.txt']);
    expect(st.changedFiles.sort()).toEqual(['back\\slash.txt', 'we"ird.txt']);
    await rm(repo, { recursive: true, force: true });
  });

  it('git mv is one entry: renamed, new path, with oldPath — no tab artifact', async () => {
    repo = await initRepo('baton-z-rename-');
    await commitFile('a.ts');
    await git(['mv', 'a.ts', 'b.ts'], repo);

    const st = await worktreeStatus(repo);
    expect(st.files).toEqual([{ path: 'b.ts', status: 'renamed', oldPath: 'a.ts' }]);
    expect(st.changedFiles).toEqual(['b.ts']);
    await rm(repo, { recursive: true, force: true });
  });

  it('a git cp (copy) is distinguished from a rename', async () => {
    repo = await initRepo('baton-z-copy-');
    await git(['config', 'status.renames', 'copies'], repo);
    await commitFile('orig.ts', Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n');
    await copyFile(join(repo, 'orig.ts'), join(repo, 'copy.ts'));
    // git's default copy detection (`status.renames=copies`, no `--find-copies-harder`)
    // only matches an added file against a SOURCE already in the same change-set — an
    // untouched orig.ts is not a candidate, so it must be modified too.
    await appendFile(join(repo, 'orig.ts'), 'line extra\n', 'utf-8');
    await git(['add', '-A'], repo);

    const st = await worktreeStatus(repo);
    const copied = st.files.find((f) => f.path === 'copy.ts');
    expect(copied).toEqual({ path: 'copy.ts', status: 'copied', oldPath: 'orig.ts' });
    await rm(repo, { recursive: true, force: true });
  });

  it('a staged-then-edited file (MM) reads modified', async () => {
    repo = await initRepo('baton-z-mm-');
    await commitFile('m.ts', 'one\n');
    await appendFile(join(repo, 'm.ts'), 'two\n', 'utf-8');
    await git(['add', 'm.ts'], repo);
    await appendFile(join(repo, 'm.ts'), 'three\n', 'utf-8');

    const st = await worktreeStatus(repo);
    expect(st.files).toEqual([{ path: 'm.ts', status: 'modified' }]);
    await rm(repo, { recursive: true, force: true });
  });

  it('a staged-add then worktree-edited file (AM) reads modified, not added — worktree column wins', async () => {
    repo = await initRepo('baton-z-am-');
    await commitFile('seed.ts');
    await writeFile(join(repo, 'new.ts'), 'v1\n', 'utf-8');
    await git(['add', 'new.ts'], repo);
    await appendFile(join(repo, 'new.ts'), 'v2\n', 'utf-8');

    const st = await worktreeStatus(repo);
    expect(st.files).toEqual([{ path: 'new.ts', status: 'modified' }]);
    await rm(repo, { recursive: true, force: true });
  });

  it('a conflict fixture keeps conflictDetails unchanged, but exposes files (unlike the [] changedFiles)', async () => {
    repo = await initRepo('baton-z-conflict-');
    await commitFile('c.ts', 'base\n');
    await git(['checkout', '-qb', 'other'], repo);
    await writeFile(join(repo, 'c.ts'), 'other\n', 'utf-8');
    await git(['commit', '-qam', 'other edit'], repo);
    await git(['checkout', '-q', 'main'], repo);
    await writeFile(join(repo, 'c.ts'), 'main\n', 'utf-8');
    await git(['commit', '-qam', 'main edit'], repo);
    await gitTry(['merge', 'other'], repo); // conflicts; gitTry never throws on a non-zero exit

    const st = await worktreeStatus(repo);
    expect(st.state).toBe('conflict');
    expect(st.changedFiles).toEqual([]); // unchanged: the count stays 0 when it matters most
    expect(st.files).toEqual([{ path: 'c.ts', status: 'modified' }]); // but the real file list is not empty
    expect(st.conflictFiles).toEqual(['c.ts']);
    expect(st.conflictDetails).toEqual([{ path: 'c.ts', xy: 'UU', label: 'both modified' }]);
    await rm(repo, { recursive: true, force: true });
  });
});

describe('parsePorcelainZ (pure)', () => {
  it('parses ordinary, untracked, rename and conflict records from one -z stream', () => {
    const raw = [
      '1 M. N... 100644 100644 100644 a a plain.ts',
      '? untracked.ts',
      '2 R. N... 100644 100644 100644 a a R100 new.ts',
      'old.ts',
      'u UU N... 100644 100644 100644 100644 h1 h2 h3 conflicted.ts',
    ].join('\0') + '\0';
    const { changed, conflicts } = parsePorcelainZ(raw);
    expect(changed).toEqual([
      { path: 'plain.ts', status: 'modified' },
      { path: 'untracked.ts', status: 'untracked' },
      { path: 'new.ts', status: 'renamed', oldPath: 'old.ts' },
      // A conflicted path is ALSO in `changed` (never only in `conflicts`) so a
      // conflicted file is visible to the Changed-files panel and overlap join.
      { path: 'conflicted.ts', status: 'modified' },
    ]);
    expect(conflicts).toEqual([{ path: 'conflicted.ts', xy: 'UU', label: 'both modified' }]);
  });

  it('added ("A.") reads added, deleted ("D.") reads deleted', () => {
    const raw = [
      '1 A. N... 000000 100644 100644 0 a add.ts',
      '1 D. N... 100644 000000 000000 a 0 del.ts',
    ].join('\0') + '\0';
    expect(parsePorcelainZ(raw).changed).toEqual([
      { path: 'add.ts', status: 'added' },
      { path: 'del.ts', status: 'deleted' },
    ]);
  });
});
