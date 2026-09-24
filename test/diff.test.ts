// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { usePrivateHome } from './helpers/private-home.js';
import { collectDiff, parseUnifiedDiff, DIFF_MAX_CHARS, DIFF_MAX_FILES } from '../src/diff.js';
import type { Task } from '../src/store.js';

const MODIFIED = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@
 import { x } from "./x";
-const a = 1;
+const a = 2;
+const b = 3;
 export { a };
 // end
`;

const ADDED = `diff --git a/notes.md b/notes.md
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/notes.md
@@ -0,0 +1,2 @@
+hello
+world
`;

const DELETED = `diff --git a/old.txt b/old.txt
deleted file mode 100644
index e69de29..0000000
--- a/old.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
`;

const BINARY = `diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
`;

const RENAME = `diff --git a/keep.txt b/moved.txt
similarity index 100%
rename from keep.txt
rename to moved.txt
`;

const RENAME_EDIT = `diff --git a/edit.txt b/edited2.txt
similarity index 94%
rename from edit.txt
rename to edited2.txt
index 1111111..2222222 100644
--- a/edit.txt
+++ b/edited2.txt
@@ -20,1 +20,2 @@
 line 20
+one more
`;

describe('parseUnifiedDiff', () => {
  it('returns [] for empty output', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('\n')).toEqual([]);
  });

  it('parses a modified file with line numbers and counts', () => {
    const [f] = parseUnifiedDiff(MODIFIED);
    expect(f.path).toBe('src/app.ts');
    expect(f.status).toBe('modified');
    expect(f.lang).toBe('ts');
    expect(f.add).toBe(2);
    expect(f.del).toBe(1);
    expect(f.hunks).toHaveLength(1);
    const lines = f.hunks[0].lines;
    expect(lines[0]).toEqual({ t: 'ctx', o: 1, n: 1, s: 'import { x } from "./x";' });
    expect(lines[1]).toEqual({ t: 'del', o: 2, n: null, s: 'const a = 1;' });
    expect(lines[2]).toEqual({ t: 'add', o: null, n: 2, s: 'const a = 2;' });
    expect(lines[3]).toEqual({ t: 'add', o: null, n: 3, s: 'const b = 3;' });
    expect(lines[4]).toEqual({ t: 'ctx', o: 3, n: 4, s: 'export { a };' });
  });

  it('parses added and deleted files', () => {
    const [a] = parseUnifiedDiff(ADDED);
    expect(a).toMatchObject({ path: 'notes.md', status: 'added', add: 2, del: 0 });
    const [d] = parseUnifiedDiff(DELETED);
    expect(d).toMatchObject({ path: 'old.txt', status: 'deleted', add: 0, del: 1 });
  });

  it('lists binary files without hunks', () => {
    const [f] = parseUnifiedDiff(BINARY);
    expect(f).toMatchObject({ path: 'logo.png', status: 'modified', hunks: [], add: 0, del: 0 });
  });

  it('parses multiple files in one diff', () => {
    const files = parseUnifiedDiff(MODIFIED + ADDED + BINARY);
    expect(files.map((f) => f.path)).toEqual(['src/app.ts', 'notes.md', 'logo.png']);
  });

  it('does not mistake diff-like file content for a new section', () => {
    const tricky = `diff --git a/readme.md b/readme.md
index 1111111..2222222 100644
--- a/readme.md
+++ b/readme.md
@@ -1,1 +1,2 @@
 intro
+diff --git a/fake b/fake
`;
    const files = parseUnifiedDiff(tricky);
    expect(files).toHaveLength(1);
    expect(files[0].add).toBe(1);
    expect(files[0].hunks[0].lines[1].s).toBe('diff --git a/fake b/fake');
  });

  it('reports a pure rename as renamed, with its old path', () => {
    const [f] = parseUnifiedDiff(RENAME);
    expect(f).toMatchObject({ status: 'renamed', path: 'moved.txt', oldPath: 'keep.txt', add: 0, del: 0, hunks: [] });
  });

  it('reports a rename with an edit as renamed, with counts', () => {
    const [f] = parseUnifiedDiff(RENAME_EDIT);
    expect(f).toMatchObject({ status: 'renamed', path: 'edited2.txt', oldPath: 'edit.txt', add: 1, del: 0 });
  });

  it('does not carry a rename into the next file', () => {
    const [r, m] = parseUnifiedDiff(RENAME + MODIFIED);
    expect(r.status).toBe('renamed');
    expect(m.status).toBe('modified');
    expect(m.oldPath).toBeUndefined();
  });
});

/** 2d: a diff too big to read says so, instead of reading as "no changes". */
describe('collectDiff truncation', () => {
  // No user git config (e.g. a global diff driver) may shape these diffs. exec.ts
  // caches git's env on the first call, so git keeps the first test's HOME.
  usePrivateHome('baton-diff-home-');
  let repo: string;
  const task = (): Task => ({
    slug: 't', task: 't', branch: 'b', worktreePath: repo, baseBranch: 'main', baseCommit: null,
    createdAt: '2026-09-21T10:00:00.000Z', phase: 1, dependsOn: [], assignee: null, scope: [], expects: [],
    state: 'queued', requireReview: true,
  } as Task);

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'baton-diff-trunc-'));
    await git(['init', '-q', '-b', 'main'], repo);
    await git(['config', 'user.email', 't@t.dev'], repo);
    await git(['config', 'user.name', 't'], repo);
    await writeFile(join(repo, 'big.txt'), 'seed\n', 'utf-8');
    await writeFile(join(repo, 'small.txt'), 'seed\n', 'utf-8');
    await git(['add', '-A'], repo);
    await git(['commit', '-qm', 'init'], repo);
  });
  afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

  it('has sane defaults', () => {
    expect(DIFF_MAX_CHARS).toBe(5_000_000);
    expect(DIFF_MAX_FILES).toBe(1000);
  });

  it('a small diff is not truncated', async () => {
    await writeFile(join(repo, 'small.txt'), 'seed\nmore\n', 'utf-8');
    const r = await collectDiff(task());
    expect(r.truncated).toBe(false);
    expect(r.files.map((f) => f.path)).toEqual(['small.txt']);
  });

  it('a tracked diff past the cap keeps the partial files and says truncated', async () => {
    await writeFile(join(repo, 'big.txt'), Array.from({ length: 2000 }, (_, i) => `row ${i} ${'x'.repeat(20)}`).join('\n'), 'utf-8');
    const r = await collectDiff(task(), { maxChars: 2_000 });
    expect(r.truncated).toBe(true);
    expect(r.files.length).toBeGreaterThanOrEqual(1);
    expect(r.files[0].path).toBe('big.txt');
  });

  it('caps tracked and untracked files together at maxFiles', async () => {
    await writeFile(join(repo, 'small.txt'), 'seed\nmore\n', 'utf-8');
    for (let i = 0; i < 5; i++) await writeFile(join(repo, `u${i}.txt`), 'u\n', 'utf-8');
    const r = await collectDiff(task(), { maxFiles: 3 });
    expect(r.truncated).toBe(true);
    expect(r.files).toHaveLength(3);
    expect(r.files[0].path).toBe('small.txt');
  });

  it('one untracked file over the per-file cap is marked tooLarge, not the whole diff truncated', async () => {
    await writeFile(join(repo, 'huge.txt'), Array.from({ length: 4000 }, () => 'z'.repeat(70)).join('\n'), 'utf-8');
    await writeFile(join(repo, 'note.txt'), 'hello\n', 'utf-8');
    const r = await collectDiff(task());
    expect(r.truncated).toBe(false);
    const huge = r.files.find((f) => f.path === 'huge.txt');
    const note = r.files.find((f) => f.path === 'note.txt');
    expect(huge).toMatchObject({ status: 'added', hunks: [], add: 0, tooLarge: true });
    expect(note?.hunks.length).toBe(1);
    expect(note?.tooLarge).toBeUndefined();
  });

  it('untracked files past the 50th are listed as tooLarge, without the global flag', async () => {
    for (let i = 0; i < 52; i++) await writeFile(join(repo, `u${String(i).padStart(2, '0')}.txt`), 'u\n', 'utf-8');
    const r = await collectDiff(task());
    expect(r.truncated).toBe(false);
    expect(r.files).toHaveLength(52);
    expect(r.files.filter((f) => f.tooLarge)).toHaveLength(2);
    expect(r.files.slice(0, 50).every((f) => f.hunks.length === 1)).toBe(true);
  });

  it('the budget is shared: tracked output spends it before untracked files', async () => {
    await writeFile(join(repo, 'big.txt'), Array.from({ length: 400 }, (_, i) => `row ${i} ${'x'.repeat(20)}`).join('\n'), 'utf-8');
    await writeFile(join(repo, 'new.txt'), Array.from({ length: 400 }, (_, i) => `new ${i} ${'x'.repeat(20)}`).join('\n'), 'utf-8');
    // Enough for either diff alone (~12 KB each), not both.
    const r = await collectDiff(task(), { maxChars: 16_000 });
    expect(r.truncated).toBe(true);
    const big = r.files.find((f) => f.path === 'big.txt');
    const added = r.files.find((f) => f.path === 'new.txt');
    expect(big?.hunks.length).toBeGreaterThan(0);
    expect(big?.tooLarge).toBeUndefined();
    expect(added).toMatchObject({ status: 'added', hunks: [], tooLarge: true });
  });
});
