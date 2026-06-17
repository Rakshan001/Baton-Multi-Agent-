import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../src/diff.js';

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
});
