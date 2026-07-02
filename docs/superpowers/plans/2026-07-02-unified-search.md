# Unified Context Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One BM25-ranked, token-budgeted MCP search (`search_context` + `show_change` expander) over facts, tasks, commits, and reports, joined to graph symbols — per [the spec](../specs/2026-07-02-unified-search-design.md).

**Architecture:** Extend the existing `.baton/history.db` (node:sqlite) with enrichment columns, a `commit_symbols` join table, and an FTS5 index; enrich deterministically at merge time; serve through two new tools in `baton mcp`. New code lives in `src/search/` (one responsibility per file); `history.ts`/`merge.ts`/`mcp.ts` get minimal wiring edits.

**Tech Stack:** TypeScript (strict), `node:sqlite` FTS5 (feature-detected, LIKE fallback), git via `src/util/exec.ts`, vitest.

## Global Constraints

- Zero-dependency daemon: no new npm packages. No LLM calls anywhere.
- All git through `git`/`gitTry` from `src/util/exec.ts` — never shell out.
- Strict TS; both `npm run build` and `npx vitest run` must stay green after every task.
- FTS5 must be feature-detected (`try/catch` on `CREATE VIRTUAL TABLE`); every query has a LIKE-scan fallback with the same tool contract.
- Stale memory facts are NEVER served — anchor re-check happens at query time.
- **Git rules (user's):** every commit step requires the user's explicit approval first; author must be the repo's configured identity (Rakshan001); NO `Co-Authored-By` trailer; never push.
- Test style: mirror `test/hub.test.ts` (temp dirs via `mkdtemp`, real git repos, cleanup in `afterEach`).

---

### Task 1: Analysis helpers (tokenizer + parsers)

**Files:**
- Create: `src/search/analyze.ts`
- Test: `test/search-analyze.test.ts`

**Interfaces:**
- Produces: `subtokens(text: string): string[]` · `parseConventional(message: string): { ctype: string | null; cscope: string | null; breaking: boolean }` · `parseHunkFuncnames(diff: string): Map<string, Set<string>>` (file path → funcnames)

- [ ] **Step 1: Write the failing tests**

```ts
// test/search-analyze.test.ts
import { describe, it, expect } from 'vitest';
import { subtokens, parseConventional, parseHunkFuncnames } from '../src/search/analyze.js';

describe('subtokens', () => {
  it('emits the whole identifier plus camelCase/snake_case/path subtokens, lowercased', () => {
    const t = subtokens('handleWebSocketUpgrade src/kb/graph_state.ts');
    expect(t).toContain('handlewebsocketupgrade');
    expect(t).toContain('handle'); expect(t).toContain('web');
    expect(t).toContain('socket'); expect(t).toContain('upgrade');
    expect(t).toContain('graph'); expect(t).toContain('state');
    expect(t).toContain('src/kb/graph_state.ts'); // original path kept
  });
  it('dedupes and ignores empty input', () => {
    expect(subtokens('')).toEqual([]);
    expect(new Set(subtokens('foo foo')).size).toBe(subtokens('foo foo').length);
  });
});

describe('parseConventional', () => {
  it('parses type(scope)!: subject', () => {
    expect(parseConventional('fix(server)!: reject bad upgrade')).toEqual(
      { ctype: 'fix', cscope: 'server', breaking: true });
  });
  it('parses plain type: subject', () => {
    expect(parseConventional('feat: add search')).toEqual(
      { ctype: 'feat', cscope: null, breaking: false });
  });
  it('returns nulls for non-conforming messages (never guesses)', () => {
    expect(parseConventional('wip stuff')).toEqual({ ctype: null, cscope: null, breaking: false });
  });
});

describe('parseHunkFuncnames', () => {
  it('extracts enclosing function names per file from unified=0 hunks', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts',
      '@@ -10,0 +11,2 @@ export async function createTask(taskText: string,',
      '+x', '@@ -40 +43 @@ export class ScrollbackRing {', '+y',
      'diff --git a/src/b.ts b/src/b.ts', '--- a/src/b.ts', '+++ b/src/b.ts',
      '@@ -1 +1 @@', '+z',
    ].join('\n');
    const m = parseHunkFuncnames(diff);
    expect([...m.get('src/a.ts')!]).toEqual(expect.arrayContaining(['createTask', 'ScrollbackRing']));
    expect(m.get('src/b.ts')).toBeUndefined(); // hunk with no context name → no row
  });
  it('skips control-flow keywords masquerading as calls', () => {
    const diff = ['+++ b/src/c.ts', '@@ -1 +1 @@ if (x) {'].join('\n');
    expect(parseHunkFuncnames(diff).get('src/c.ts')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/search-analyze.test.ts`
Expected: FAIL — `Cannot find module '../src/search/analyze.js'`

- [ ] **Step 3: Implement**

```ts
// src/search/analyze.ts
/**
 * Identifier-aware tokenization + deterministic commit parsing for search.
 * Emitting whole identifiers AND their camelCase/snake_case subtokens improved
 * BM25 code retrieval ~82% in arXiv 2605.18561 — FTS5's tokenizer can't split
 * camelCase, so we pre-split here and store the expansion in its own column.
 */

export function subtokens(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split(/[^A-Za-z0-9_./-]+/).filter(Boolean)) {
    out.add(raw.toLowerCase());
    for (const seg of raw.split(/[_\-./]/).filter(Boolean)) {
      out.add(seg.toLowerCase());
      for (const sub of seg.split(/(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean)) {
        out.add(sub.toLowerCase());
      }
    }
  }
  return [...out];
}

export interface ConventionalCommit {
  ctype: string | null;
  cscope: string | null;
  breaking: boolean;
}

export function parseConventional(message: string): ConventionalCommit {
  const m = message.match(/^([A-Za-z]+)(?:\(([^)]*)\))?(!)?:\s/);
  const breaking = /BREAKING[ -]CHANGE/.test(message);
  if (!m) return { ctype: null, cscope: null, breaking };
  return { ctype: m[1].toLowerCase(), cscope: m[2]?.trim() || null, breaking: breaking || m[3] === '!' };
}

/** Control-flow words that match the `name(` heuristic but aren't functions. */
const NOT_FUNCS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'await', 'typeof']);

/**
 * git's `@@ … @@ <context>` hunk headers carry the enclosing declaration —
 * a zero-dependency symbol-touch approximation straight from git.
 */
export function parseHunkFuncnames(diff: string): Map<string, Set<string>> {
  const byFile = new Map<string, Set<string>>();
  let file: string | null = null;
  for (const line of diff.split('\n')) {
    const f = line.match(/^\+\+\+ b\/(.+)$/);
    if (f) { file = f[1]; continue; }
    if (!file) continue;
    const h = line.match(/^@@ [^@]*@@ (.+)$/);
    if (!h) continue;
    const ctx = h[1];
    const call = ctx.match(/([A-Za-z_$][\w$]*)\s*\(/)?.[1];
    const decl = ctx.match(/\b(?:class|interface|enum|function|const|let|var|type)\s+([A-Za-z_$][\w$]*)/)?.[1];
    const name = (call && !NOT_FUNCS.has(call) ? call : null) ?? decl ?? null;
    if (!name) continue;
    let set = byFile.get(file);
    if (!set) byFile.set(file, (set = new Set()));
    set.add(name);
  }
  return byFile;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/search-analyze.test.ts` — Expected: PASS (6 tests)

- [ ] **Step 5: Commit (ask the user first, per repo rules)**

```bash
git add src/search/analyze.ts test/search-analyze.test.ts
git commit -m "feat(search): identifier-aware tokenizer + deterministic commit parsers"
```

---

### Task 2: Search schema, FTS5 detection, backfill

**Files:**
- Modify: `src/history.ts:25` (export the `SCHEMA` const: `export const SCHEMA = \`…\`` — no other change) and `src/history.ts:91` (`recordTask` gains optional `project`)
- Modify: `src/commands/new.ts:57` (pass `project: resolvedProjectId` to `recordTask`)
- Create: `src/search/db.ts`
- Test: `test/search-db.test.ts`

**Interfaces:**
- Consumes: `SCHEMA` from `src/history.ts`; `listHistory`, `TaskHistory` from `src/history.ts`; `listReports` from `src/reports.ts`
- Produces: `searchDb(root: string): { db: DatabaseSync; fts: boolean }` · `closeSearchDb(root: string): void` · `backfillFts(root: string): number` (rows inserted) · the migrated schema (commit_symbols, search_meta, history_fts, enrichment columns, `tasks.project`)

- [ ] **Step 1: Write the failing tests**

```ts
// test/search-db.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchDb, closeSearchDb, backfillFts } from '../src/search/db.js';
import { recordTask, recordMerge, closeHistoryDb } from '../src/history.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'baton-sdb-')); await mkdir(join(root, '.baton'), { recursive: true }); });
afterEach(async () => { closeSearchDb(root); closeHistoryDb(root); await rm(root, { recursive: true, force: true }); });

describe('searchDb', () => {
  it('migrates in place: enrichment columns + commit_symbols + fts', () => {
    const { db, fts } = searchDb(root);
    expect(fts).toBe(true); // Node ≥22.16 on dev machines
    // columns exist (throws if not)
    db.prepare(`SELECT ctype, cscope, breaking FROM commits LIMIT 0`).all();
    db.prepare(`SELECT status, insertions, deletions FROM commit_files LIMIT 0`).all();
    db.prepare(`SELECT project FROM tasks LIMIT 0`).all();
    db.prepare(`SELECT sha, slug, path, symbol, source FROM commit_symbols LIMIT 0`).all();
    db.prepare(`SELECT * FROM history_fts LIMIT 0`).all();
  });
  it('is idempotent (second open does not re-migrate or throw)', () => {
    searchDb(root); closeSearchDb(root);
    expect(() => searchDb(root)).not.toThrow();
  });
});

describe('backfillFts', () => {
  it('indexes pre-existing commits from history.db', () => {
    recordTask(root, { slug: 't1', task: 'Fix WS upgrade auth', branch: 'baton/t1', baseBranch: 'main', createdAt: '2026-01-01' });
    recordMerge(root, { slug: 't1', mergedAt: '2026-01-02', archivedRef: null, commits: [
      { sha: 'abc123', message: 'fix(server): reject bad upgrade', at: '2026-01-02', files: ['src/server.ts'] },
    ]});
    closeHistoryDb(root);
    const n = backfillFts(root);
    expect(n).toBe(1);
    const { db } = searchDb(root);
    const row = db.prepare(`SELECT slug FROM history_fts WHERE history_fts MATCH 'upgrade'`).get() as { slug: string };
    expect(row.slug).toBe('t1');
    expect(backfillFts(root)).toBe(0); // already indexed → no duplicates
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/search-db.test.ts` — Expected: FAIL, module not found

- [ ] **Step 3: Implement**

In `src/history.ts`: change `const SCHEMA` → `export const SCHEMA`; add `project` to `TaskRecord` (`project?: string | null`) and to `recordTask`'s INSERT (`project` column comes from Task 2's migration; use `ON CONFLICT … project=excluded.project`). NOTE: `recordTask` runs against the un-migrated base schema in fresh repos — have `recordTask` call `searchDb(root)` first? NO (circular import). Instead: the migration in `search/db.ts` owns ALL new columns, and `recordTask` writes `project` only via a dynamic column check:

```ts
// in recordTask, after getDb(root):
const hasProject = (db.prepare(`SELECT COUNT(*) c FROM pragma_table_info('tasks') WHERE name='project'`).get() as { c: number }).c > 0;
```
— if present, use the widened INSERT (with project); else the original. Two prepared statements, picked by flag.

```ts
// src/search/db.ts
/**
 * Search index over .baton/history.db: enrichment columns, the commit↔symbol
 * join table, and an FTS5 mirror (feature-detected; callers must handle
 * fts=false with a LIKE fallback). Opens its OWN handle to the same file —
 * established pattern (reports.ts does the same).
 */
import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { batonDir } from '../store.js';
import { SCHEMA as HISTORY_SCHEMA, listHistory } from '../history.js';
import { listReports } from '../reports.js';
import { subtokens, parseConventional } from './analyze.js';

const nodeRequire = createRequire(import.meta.url);
let _sqlite: typeof import('node:sqlite') | null = null;
function sqlite(): typeof import('node:sqlite') {
  return (_sqlite ??= nodeRequire('node:sqlite') as typeof import('node:sqlite'));
}

const MIGRATION_V1 = `
ALTER TABLE commits ADD COLUMN ctype TEXT;
ALTER TABLE commits ADD COLUMN cscope TEXT;
ALTER TABLE commits ADD COLUMN breaking INTEGER DEFAULT 0;
ALTER TABLE commit_files ADD COLUMN status TEXT;
ALTER TABLE commit_files ADD COLUMN insertions INTEGER;
ALTER TABLE commit_files ADD COLUMN deletions INTEGER;
ALTER TABLE tasks ADD COLUMN project TEXT;
CREATE TABLE IF NOT EXISTS commit_symbols (
  sha TEXT, slug TEXT, path TEXT, symbol TEXT, source TEXT,
  PRIMARY KEY (sha, path, symbol)
);
CREATE INDEX IF NOT EXISTS idx_commit_symbols_symbol ON commit_symbols(symbol);
CREATE TABLE IF NOT EXISTS search_meta (key TEXT PRIMARY KEY, value TEXT);
`;

const FTS_CREATE = `
CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
  kind UNINDEXED, ref UNINDEXED, slug UNINDEXED, project UNINDEXED, at UNINDEXED,
  message, task, symbols, paths, report,
  tokenize = "unicode61 tokenchars '_'"
);`;

export interface SearchHandle { db: DatabaseSync; fts: boolean; }
const conns = new Map<string, SearchHandle>();

export function searchDb(root: string): SearchHandle {
  const dir = batonDir(root);
  const path = join(dir, 'history.db');
  let h = conns.get(path);
  if (h) return h;
  mkdirSync(dir, { recursive: true });
  const db = new (sqlite().DatabaseSync)(path);
  db.exec(HISTORY_SCHEMA); // base tables may not exist yet on a fresh .baton
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (v < 1) {
    db.exec('BEGIN');
    try {
      for (const stmt of MIGRATION_V1.split(';').map((s) => s.trim()).filter(Boolean)) {
        try { db.exec(stmt); } catch { /* column already exists (re-run) */ }
      }
      db.exec('PRAGMA user_version = 1');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  let fts = true;
  try { db.exec(FTS_CREATE); } catch { fts = false; } // Node < 22.16: no FTS5
  h = { db, fts };
  conns.set(path, h);
  return h;
}

export function closeSearchDb(root: string): void {
  const path = join(batonDir(root), 'history.db');
  const h = conns.get(path);
  if (h) { try { h.db.close(); } catch { /* closed */ } conns.delete(path); }
}

/** One-shot: index commits already recorded before this feature existed.
 *  Uses exported history/report APIs (no schema guessing). Returns rows added. */
export function backfillFts(root: string): number {
  const { db, fts } = searchDb(root);
  if (!fts) return 0;
  const seen = new Set(
    (db.prepare(`SELECT ref FROM history_fts WHERE kind='commit'`).all() as { ref: string }[]).map((r) => r.ref),
  );
  const reportBySlug = new Map(listReports(root, 10_000).map((r) => [r.slug, r.summary]));
  const projBySlug = new Map(
    (db.prepare(`SELECT slug, project FROM tasks`).all() as { slug: string; project: string | null }[])
      .map((r) => [r.slug, r.project]),
  );
  const ins = db.prepare(
    `INSERT INTO history_fts (kind, ref, slug, project, at, message, task, symbols, paths, report)
     VALUES ('commit', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const t of listHistory(root)) {
      for (const c of t.commits) {
        if (seen.has(c.sha)) continue;
        const files = (db.prepare(`SELECT path FROM commit_files WHERE sha = ?`).all(c.sha) as { path: string }[]).map((r) => r.path);
        const conv = parseConventional(c.message);
        db.prepare(`UPDATE commits SET ctype = ?, cscope = ?, breaking = ? WHERE sha = ?`)
          .run(conv.ctype, conv.cscope, conv.breaking ? 1 : 0, c.sha);
        ins.run(c.sha, t.slug, projBySlug.get(t.slug) ?? null, c.at, c.message, t.task,
          '', subtokens(files.join(' ')).join(' '), reportBySlug.get(t.slug) ?? '');
        n++;
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return n;
}
```

- [ ] **Step 4: Run tests + full suite**

Run: `npx vitest run test/search-db.test.ts` → PASS; then `npm run build && npx vitest run` → all green (255 + new)

- [ ] **Step 5: Commit (ask the user first)**

```bash
git add src/search/db.ts src/history.ts src/commands/new.ts test/search-db.test.ts
git commit -m "feat(search): history.db search schema, FTS5 detection, backfill"
```

---

### Task 3: Merge-time enrichment (numstat, hunks, graph join, FTS row)

**Files:**
- Create: `src/search/indexer.ts`
- Modify: `src/commands/merge.ts:94-97` (call `indexMergedTask` right after `saveReport`, fire-and-forget like the kb update)
- Test: `test/search-indexer.test.ts`

**Interfaces:**
- Consumes: `searchDb` (Task 2), `subtokens`/`parseConventional`/`parseHunkFuncnames` (Task 1), `gitTry` from `src/util/exec.ts`, `loadKb`/`graphPathFor` from `src/kb/state.js`, `CommitInfo` from `src/git.js`
- Produces: `indexMergedTask(root: string, gitRepo: string, task: { slug: string; task: string; projectId?: string }, commits: CommitInfo[], reportSummary: string): Promise<void>`

- [ ] **Step 1: Write the failing test** (temp git repo, style of `test/hub.test.ts`)

```ts
// test/search-indexer.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { branchCommits } from '../src/git.js';
import { searchDb, closeSearchDb } from '../src/search/db.js';
import { indexMergedTask } from '../src/search/indexer.js';
import { closeHistoryDb, recordTask } from '../src/history.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'baton-sidx-'));
  await git(['init', '-q'], root);
  await git(['config', 'user.email', 't@b.dev'], root);
  await git(['config', 'user.name', 'T'], root);
  await git(['checkout', '-q', '-b', 'main'], root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src/pay.ts'), 'export function processPayment(x: number) {\n  return x;\n}\n');
  await git(['add', '.'], root); await git(['commit', '-q', '-m', 'initial'], root);
  await git(['checkout', '-q', '-b', 'baton/fix-pay'], root);
  await writeFile(join(root, 'src/pay.ts'), 'export function processPayment(x: number) {\n  return x + 1; // retry\n}\n');
  await git(['add', '.'], root); await git(['commit', '-q', '-m', 'fix(pay): add retryTimeout to processPayment'], root);
});
afterEach(async () => { closeSearchDb(root); closeHistoryDb(root); await rm(root, { recursive: true, force: true }); });

it('writes enrichment + commit_symbols + a searchable FTS row', async () => {
  const commits = await branchCommits('baton/fix-pay', 'main', root);
  recordTask(root, { slug: 'fix-pay', task: 'Fix payment retry', branch: 'baton/fix-pay', baseBranch: 'main', createdAt: '2026-01-01' });
  await indexMergedTask(root, root, { slug: 'fix-pay', task: 'Fix payment retry' }, commits, 'Payment retry fixed with backoff');
  const { db } = searchDb(root);
  const c = db.prepare(`SELECT ctype, cscope FROM commits WHERE sha = ?`).get(commits[0].sha) as { ctype: string; cscope: string };
  expect(c).toEqual({ ctype: 'fix', cscope: 'pay' });
  const sym = db.prepare(`SELECT symbol, source FROM commit_symbols WHERE sha = ?`).get(commits[0].sha) as { symbol: string; source: string };
  expect(sym.symbol).toBe('processPayment'); // no graph.json in this repo → hunk source
  expect(sym.source).toBe('hunk');
  const f = db.prepare(`SELECT insertions, deletions FROM commit_files WHERE sha = ?`).get(commits[0].sha) as { insertions: number; deletions: number };
  expect(f.insertions).toBeGreaterThan(0);
  // searchable by camelCase subtoken from the SYMBOL, not the message
  const hit = db.prepare(`SELECT slug FROM history_fts WHERE history_fts MATCH 'payment'`).get() as { slug: string };
  expect(hit.slug).toBe('fix-pay');
});
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run test/search-indexer.test.ts` → FAIL, module not found

- [ ] **Step 3: Implement**

```ts
// src/search/indexer.ts
/**
 * Deterministic merge-time enrichment: per-file stats, conventional-commit
 * fields, commit↔symbol rows from git hunk headers (resolved against the
 * project's graph.json when present), and one FTS row per commit.
 * No LLM. Called fire-and-forget after a merge is recorded.
 */
import { readFile } from 'node:fs/promises';
import { gitTry } from '../util/exec.js';
import type { CommitInfo } from '../git.js';
import { loadKb, graphPathFor } from '../kb/state.js';
import { searchDb } from './db.js';
import { parseConventional, parseHunkFuncnames, subtokens } from './analyze.js';

interface GraphNode { id: string; norm_label?: string; source_file?: string; }

/** source_file → (lowercased norm_label → node id). Empty map when no graph. */
async function loadSymbolMap(root: string, projectId?: string): Promise<Map<string, Map<string, string>>> {
  const map = new Map<string, Map<string, string>>();
  try {
    const kb = await loadKb(root);
    const proj = projectId
      ? kb?.projects.find((p) => p.id === projectId)
      : kb?.projects.length === 1 ? kb.projects[0] : undefined;
    const graphPath = proj ? graphPathFor(proj.path) : null;
    if (!graphPath) return map;
    const g = JSON.parse(await readFile(graphPath, 'utf-8')) as { nodes?: GraphNode[] };
    for (const n of g.nodes ?? []) {
      if (!n.source_file || !n.norm_label) continue;
      let inner = map.get(n.source_file);
      if (!inner) map.set(n.source_file, (inner = new Map()));
      inner.set(n.norm_label.toLowerCase(), n.id);
    }
  } catch { /* graph missing/corrupt → hunk-only rows */ }
  return map;
}

export async function indexMergedTask(
  root: string,
  gitRepo: string,
  task: { slug: string; task: string; projectId?: string },
  commits: CommitInfo[],
  reportSummary: string,
): Promise<void> {
  const { db, fts } = searchDb(root);
  const symMap = await loadSymbolMap(root, task.projectId);

  for (const c of commits) {
    // 1. per-file numbers + status
    const numstat = await gitTry(['show', '--numstat', '--pretty=format:', c.sha], gitRepo);
    const statusR = await gitTry(['show', '--name-status', '--pretty=format:', c.sha], gitRepo);
    const statusByPath = new Map<string, string>();
    if (statusR.ok) for (const line of statusR.stdout.split('\n')) {
      const m = line.match(/^([A-Z])\d*\t(?:.*\t)?(.+)$/); // R100\told\tnew → new path
      if (m) statusByPath.set(m[2], m[1]);
    }
    if (numstat.ok) for (const line of numstat.stdout.split('\n')) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      db.prepare(`UPDATE commit_files SET insertions = ?, deletions = ?, status = ? WHERE sha = ? AND path = ?`)
        .run(m[1] === '-' ? 0 : Number(m[1]), m[2] === '-' ? 0 : Number(m[2]), statusByPath.get(m[3]) ?? null, c.sha, m[3]);
    }

    // 2. conventional-commit fields
    const conv = parseConventional(c.message);
    db.prepare(`UPDATE commits SET ctype = ?, cscope = ?, breaking = ? WHERE sha = ?`)
      .run(conv.ctype, conv.cscope, conv.breaking ? 1 : 0, c.sha);

    // 3. hunk funcnames → commit_symbols (graph-resolved when possible)
    const hunks = await gitTry(['show', '--unified=0', '--pretty=format:', c.sha], gitRepo);
    const symbols: string[] = [];
    if (hunks.ok) {
      const insSym = db.prepare(
        `INSERT INTO commit_symbols (sha, slug, path, symbol, source) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(sha, path, symbol) DO NOTHING`,
      );
      for (const [path, names] of parseHunkFuncnames(hunks.stdout)) {
        for (const name of names) {
          const nodeId = symMap.get(path)?.get(name.toLowerCase());
          insSym.run(c.sha, task.slug, path, nodeId ?? name, nodeId ? 'graph' : 'hunk');
          symbols.push(name);
        }
      }
    }

    // 4. the FTS row (skip silently when FTS5 is unavailable)
    if (fts) {
      db.prepare(`DELETE FROM history_fts WHERE kind = 'commit' AND ref = ?`).run(c.sha);
      db.prepare(
        `INSERT INTO history_fts (kind, ref, slug, project, at, message, task, symbols, paths, report)
         VALUES ('commit', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(c.sha, task.slug, task.projectId ?? null, c.at, c.message, task.task,
        subtokens(symbols.join(' ')).join(' '), subtokens(c.files.join(' ')).join(' '), reportSummary);
    }
  }
}
```

In `src/commands/merge.ts`, after `void writeReportFile(repoRoot, report);` add:

```ts
  // Search index: deterministic enrichment (numstat, hunk symbols, FTS row).
  // Fire-and-forget — indexing must never block or fail a merge.
  void indexMergedTask(repoRoot, gitRepo, { slug, task: task.task, projectId: task.projectId }, commits, report.summary)
    .catch(() => undefined);
```
with `import { indexMergedTask } from '../search/indexer.js';` at the top.

- [ ] **Step 4: Run tests** — `npx vitest run test/search-indexer.test.ts` then the full suite → all green

- [ ] **Step 5: Commit (ask the user first)**

```bash
git add src/search/indexer.ts src/commands/merge.ts test/search-indexer.test.ts
git commit -m "feat(search): deterministic merge-time enrichment + commit↔symbol join"
```

---

### Task 4: Fact index (sync-by-rebuild) — deviation from spec, noted

**Files:**
- Create: `src/search/facts.ts`
- Test: `test/search-facts.test.ts`

**Design note (spec deviation):** the spec proposed per-write FTS hooks in `saveMemory`/`removeMemory`/`gcMemories`. Facts are also mutated by retention pruning, purge, and hand-edits — per-write hooks WILL drift. Instead: on every search, compare a cheap stamp (fact count + max mtime of `.baton/memory/facts/`) against `search_meta`; on drift, wipe kind='fact' rows and reinsert all (≤500 facts hard cap — milliseconds). Always consistent, no hooks.

**Interfaces:**
- Consumes: `searchDb` (Task 2), `listMemories`/`MemoryStatus` + `memoryDir`/`mainRepoRoot` from `src/memory.js`, `subtokens` (Task 1)
- Produces: `refreshFactIndex(root: string): Promise<void>` · fact rows in `history_fts` with `kind='fact'`, `ref=<fact id>`, fact text in `message`, anchor paths in `paths`, project in `project`

- [ ] **Step 1: Write the failing test**

```ts
// test/search-facts.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import { saveMemory, removeMemory } from '../src/memory.js';
import { searchDb, closeSearchDb } from '../src/search/db.js';
import { refreshFactIndex } from '../src/search/facts.js';
import { closeHistoryDb } from '../src/history.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'baton-sfact-'));
  await git(['init', '-q'], root);
  await git(['config', 'user.email', 't@b.dev'], root);
  await git(['config', 'user.name', 'T'], root);
  await git(['commit', '-q', '--allow-empty', '-m', 'init'], root);
  await mkdir(join(root, '.baton'), { recursive: true });
});
afterEach(async () => { closeSearchDb(root); closeHistoryDb(root); await rm(root, { recursive: true, force: true }); });

it('indexes facts and removes deleted ones on the next refresh', async () => {
  const saved = await saveMemory(root, { fact: 'The websocket upgrade path requires an auth session check before accepting.', type: 'decision', agent: 'test' });
  await refreshFactIndex(root);
  const { db } = searchDb(root);
  const hit = db.prepare(`SELECT ref FROM history_fts WHERE kind='fact' AND history_fts MATCH 'websocket'`).get() as { ref: string };
  expect(hit.ref).toBe(saved.id);
  await removeMemory(root, saved.id);
  await refreshFactIndex(root);
  expect(db.prepare(`SELECT COUNT(*) c FROM history_fts WHERE kind='fact'`).get()).toEqual({ c: 0 });
});
```

- [ ] **Step 2: Run to verify it fails** — module not found

- [ ] **Step 3: Implement**

```ts
// src/search/facts.ts
/**
 * FTS shadow index for memory facts — sync-by-rebuild. Facts change through
 * many paths (save, remove, gc, retention prune, purge, hand edits); instead
 * of hooking each one, compare a cheap directory stamp per search and rebuild
 * the ≤500-row fact index when it drifts. Staleness is NOT decided here —
 * the anchor re-check happens at query time (query.ts) so a fact indexed
 * fresh can still be withheld the moment its anchored code changes.
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { listMemories, mainRepoRoot, memoryDir } from '../memory.js';
import { searchDb } from './db.js';
import { subtokens } from './analyze.js';

async function dirStamp(dir: string): Promise<string> {
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.md'));
    let maxM = 0;
    for (const f of files) {
      const s = await stat(join(dir, f)).catch(() => null);
      if (s && s.mtimeMs > maxM) maxM = s.mtimeMs;
    }
    return `${files.length}:${maxM}`;
  } catch { return '0:0'; }
}

export async function refreshFactIndex(root: string): Promise<void> {
  const { db, fts } = searchDb(root);
  if (!fts) return; // LIKE fallback scores facts straight from listMemories
  const mainRoot = await mainRepoRoot(root).catch(() => root);
  const stamp = await dirStamp(join(memoryDir(mainRoot)));
  const prev = (db.prepare(`SELECT value FROM search_meta WHERE key = 'facts_stamp'`).get() as { value: string } | undefined)?.value;
  if (prev === stamp) return;
  const facts = await listMemories(root);
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM history_fts WHERE kind = 'fact'`).run();
    const ins = db.prepare(
      `INSERT INTO history_fts (kind, ref, slug, project, at, message, task, symbols, paths, report)
       VALUES ('fact', ?, ?, ?, ?, ?, ?, '', ?, '')`,
    );
    for (const f of facts) {
      ins.run(f.id, f.task ?? null, f.project ?? null, f.createdAt, f.fact, f.task ?? '',
        subtokens(f.anchors.files.map((a) => a.path).join(' ')).join(' '));
    }
    db.prepare(`INSERT INTO search_meta (key, value) VALUES ('facts_stamp', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(stamp);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
```

(Check `MemoryStatus` field names against `src/memory.ts` while implementing — `project` and `anchors.files[].path` exist per the memory schema; adjust property access if the actual names differ.)

- [ ] **Step 4: Run tests** — new test + full suite green

- [ ] **Step 5: Commit (ask the user first)**

```bash
git add src/search/facts.ts test/search-facts.test.ts
git commit -m "feat(search): fact shadow index with sync-by-rebuild"
```

---

### Task 5: `searchContext` query, ranking, budget, fallback

**Files:**
- Create: `src/search/query.ts`
- Test: `test/search-query.test.ts`

**Interfaces:**
- Consumes: `searchDb`, `refreshFactIndex`, `subtokens`; `listMemories` from `src/memory.js` (stale filter)
- Produces:
```ts
export interface SearchInput {
  query?: string; kind?: 'commit' | 'fact' | 'any';
  path?: string; symbol?: string; agent?: string; project?: string;
  since?: string; until?: string; limit?: number; maxTokens?: number;
}
export interface SearchResult { text: string; hits: number; truncated: boolean; }
export function searchContext(root: string, input: SearchInput): Promise<SearchResult>
```

- [ ] **Step 1: Write the failing tests**

```ts
// test/search-query.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordTask, recordMerge, closeHistoryDb } from '../src/history.js';
import { searchDb, closeSearchDb, backfillFts } from '../src/search/db.js';
import { searchContext } from '../src/search/query.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'baton-sq-'));
  await mkdir(join(root, '.baton'), { recursive: true });
  recordTask(root, { slug: 'fix-ws', task: 'Fix websocket upgrade auth bypass', branch: 'baton/fix-ws', baseBranch: 'main', createdAt: '2026-01-01' });
  recordMerge(root, { slug: 'fix-ws', mergedAt: '2026-01-02', archivedRef: null, commits: [
    { sha: 'aaa111', message: 'fix(server): reject upgrade before session check', at: '2026-01-02', files: ['src/server.ts'] },
  ]});
  recordTask(root, { slug: 'add-dark', task: 'Add dark mode toggle', branch: 'baton/add-dark', baseBranch: 'main', createdAt: '2026-01-03' });
  recordMerge(root, { slug: 'add-dark', mergedAt: '2026-01-04', archivedRef: null, commits: [
    { sha: 'bbb222', message: 'feat(web): theme switcher', at: '2026-01-04', files: ['web/src/theme.ts'] },
  ]});
  closeHistoryDb(root);
  backfillFts(root);
});
afterEach(async () => { closeSearchDb(root); closeHistoryDb(root); await rm(root, { recursive: true, force: true }); });

it('finds a commit by keyword and renders a cited compact row', async () => {
  const r = await searchContext(root, { query: 'websocket auth' });
  expect(r.hits).toBe(1);
  expect(r.text).toContain('fix-ws');
  expect(r.text).toContain('aaa111');
  expect(r.text).toContain('cite: aaa111:src/server.ts');
  expect(r.text).not.toContain('add-dark');
});

it('filters by path prefix', async () => {
  const r = await searchContext(root, { query: 'fix add theme upgrade', path: 'web/' });
  expect(r.text).toContain('add-dark');
  expect(r.text).not.toContain('fix-ws');
});

it('enforces the token budget and flags truncation', async () => {
  const r = await searchContext(root, { query: 'fix add theme upgrade', maxTokens: 30 });
  expect(r.truncated).toBe(true);
});

it('rejects a filterless, queryless call', async () => {
  await expect(searchContext(root, {})).rejects.toThrow(/at least one/i);
});
```

- [ ] **Step 2: Run to verify FAIL** — module not found

- [ ] **Step 3: Implement**

```ts
// src/search/query.ts
/**
 * search_context: one BM25-ranked, token-budgeted search over commits + facts.
 * Two-step retrieval (RepoMem): this returns cheap ranked rows; show_change
 * expands one item. Compact indented-text output (LocAgent Table 9: tree text
 * beat JSON for agent consumption). Stale facts are dropped AFTER ranking via
 * the memory anchor re-check — never served.
 */
import { searchDb } from './db.js';
import { refreshFactIndex } from './facts.js';
import { subtokens } from './analyze.js';
import { listMemories } from '../memory.js';

export interface SearchInput {
  query?: string; kind?: 'commit' | 'fact' | 'any';
  path?: string; symbol?: string; agent?: string; project?: string;
  since?: string; until?: string; limit?: number; maxTokens?: number;
}
export interface SearchResult { text: string; hits: number; truncated: boolean; }

const est = (s: string) => Math.ceil(s.length / 4); // ~4 chars/token

interface Row {
  kind: string; ref: string; slug: string; project: string | null; at: string;
  message: string; task: string; score: number;
}

/** FTS5 MATCH string: every term + its subtokens, OR-joined, each quoted. */
function matchExpr(query: string): string {
  const toks = subtokens(query);
  return toks.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
}

export async function searchContext(root: string, input: SearchInput): Promise<SearchResult> {
  if (!input.query && !input.path && !input.symbol) {
    throw new Error('search_context needs at least one of: query, path, symbol');
  }
  const { db, fts } = searchDb(root);
  await refreshFactIndex(root);
  const limit = Math.min(Math.max(input.limit ?? 8, 1), 25);
  const budget = Math.min(Math.max(input.maxTokens ?? 1200, 200), 4000);

  const conds: string[] = []; const params: unknown[] = [];
  if (input.kind && input.kind !== 'any') { conds.push(`kind = ?`); params.push(input.kind); }
  if (input.project) { conds.push(`project = ?`); params.push(input.project); }
  if (input.since) { conds.push(`at >= ?`); params.push(input.since); }
  if (input.until) { conds.push(`at <= ?`); params.push(input.until); }

  let rows: Row[];
  if (fts && input.query) {
    conds.unshift(`history_fts MATCH ?`); params.unshift(matchExpr(input.query));
    rows = db.prepare(
      `SELECT kind, ref, slug, project, at, message, task,
              bm25(history_fts, 0, 0, 0, 0, 0, 1.0, 3.0, 4.0, 2.0, 2.0) AS score
       FROM history_fts WHERE ${conds.join(' AND ')}
       ORDER BY score LIMIT ?`,
    ).all(...params, limit * 4) as unknown as Row[]; // over-fetch: path/symbol/stale filters below
  } else {
    // LIKE fallback (or filter-only query): scan the same data, score = matched terms.
    const terms = input.query ? subtokens(input.query) : [];
    const like = terms.map(() => `(message LIKE ? OR task LIKE ? OR symbols LIKE ? OR paths LIKE ?)`);
    const likeParams = terms.flatMap((t) => [`%${t}%`, `%${t}%`, `%${t}%`, `%${t}%`]);
    const where = [...conds, ...(like.length ? [`(${like.join(' OR ')})`] : [])];
    rows = db.prepare(
      `SELECT kind, ref, slug, project, at, message, task, 0 AS score
       FROM history_fts ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY at DESC LIMIT ?`,
    ).all(...params, ...likeParams, limit * 4) as unknown as Row[];
  }

  // Secondary filters that need the relational tables.
  if (input.path) {
    const shas = new Set((db.prepare(`SELECT DISTINCT sha FROM commit_files WHERE path LIKE ?`)
      .all(`${input.path}%`) as { sha: string }[]).map((r) => r.sha));
    rows = rows.filter((r) => r.kind !== 'commit' || shas.has(r.ref));
  }
  if (input.symbol) {
    const subs = subtokens(input.symbol);
    const shaRows = db.prepare(`SELECT DISTINCT sha, symbol FROM commit_symbols`).all() as { sha: string; symbol: string }[];
    const shas = new Set(shaRows.filter((r) => subs.some((s) => r.symbol.toLowerCase().includes(s))).map((r) => r.sha));
    rows = rows.filter((r) => r.kind !== 'commit' || shas.has(r.ref));
  }
  if (input.agent) {
    const slugs = new Set((db.prepare(`SELECT slug FROM tasks WHERE agent = ?`).all(input.agent) as { slug: string }[]).map((r) => r.slug));
    rows = rows.filter((r) => slugs.has(r.slug));
  }

  // Stale facts: re-check anchors NOW; a drifted fact is dropped, not served.
  const factIds = rows.filter((r) => r.kind === 'fact').map((r) => r.ref);
  if (factIds.length) {
    const statuses = new Map((await listMemories(root)).map((f) => [f.id, f.freshness]));
    rows = rows.filter((r) => r.kind !== 'fact' || statuses.get(r.ref) !== 'stale');
  }

  rows = rows.slice(0, limit);

  // Render compact rows within budget.
  const lines: string[] = []; let used = 0; let shown = 0; let truncated = false;
  for (const r of rows) {
    const block = r.kind === 'fact' ? renderFact(db, r) : renderCommit(db, r);
    const cost = est(block);
    if (used + cost > budget) { truncated = true; break; }
    lines.push(block); used += cost; shown++;
  }
  if (rows.length > shown) truncated = true;
  const text = lines.length
    ? lines.join('\n') + `\n— ${shown} hit(s)${truncated ? ' (truncated — refine or raise max_tokens)' : ''}. Expand with show_change(<sha|slug>).`
    : 'No matches. Try broader terms, or drop filters.';
  return { text, hits: shown, truncated };
}

function renderCommit(db: ReturnType<typeof searchDb>['db'], r: Row): string {
  const meta = db.prepare(`SELECT ctype, cscope FROM commits WHERE sha = ?`).get(r.ref) as { ctype: string | null; cscope: string | null } | undefined;
  const files = db.prepare(`SELECT path, insertions, deletions FROM commit_files WHERE sha = ? LIMIT 4`)
    .all(r.ref) as { path: string; insertions: number | null; deletions: number | null }[];
  const syms = (db.prepare(`SELECT DISTINCT symbol FROM commit_symbols WHERE sha = ? LIMIT 5`)
    .all(r.ref) as { symbol: string }[]).map((s) => s.symbol);
  const t = meta?.ctype ? `${meta.ctype}${meta.cscope ? `(${meta.cscope})` : ''}` : 'commit';
  const head = `${t} ${r.ref.slice(0, 7)} · ${r.slug} · ${r.at.slice(0, 10)}`;
  const fileStr = files.map((f) => `${f.path}${f.insertions != null ? ` +${f.insertions}/-${f.deletions}` : ''}`).join(' · ');
  return [
    head,
    `  task: ${r.task}`,
    `  why:  ${r.message.split('\n')[0]}`,
    files.length ? `  files: ${fileStr}` : null,
    syms.length ? `  symbols: ${syms.join(' · ')}` : null,
    `  cite: ${r.ref.slice(0, 7)}:${files[0]?.path ?? ''}`,
  ].filter(Boolean).join('\n');
}

function renderFact(db: ReturnType<typeof searchDb>['db'], r: Row): string {
  return [
    `fact ${r.ref} · ${r.at.slice(0, 10)}`,
    `  ${r.message.slice(0, 200)}`,
    `  cite: memory:${r.ref}`,
  ].join('\n');
}
```

- [ ] **Step 4: Run tests** — new + full suite green. Also run the fallback path: temporarily assert the LIKE branch by passing filter-only input in a test if not covered.

- [ ] **Step 5: Commit (ask the user first)**

```bash
git add src/search/query.ts test/search-query.test.ts
git commit -m "feat(search): ranked, budgeted search_context query core"
```

---

### Task 6: `showChange` expander

**Files:**
- Create: `src/search/show.ts`
- Test: `test/search-show.test.ts`

**Interfaces:**
- Consumes: `searchDb`; `gitTry` from `src/util/exec.js`; `loadKb` from `src/kb/state.js`
- Produces: `showChange(root: string, ref: string): Promise<string>` — ref is a sha (prefix ok) or a task slug; output = full message + files + patch (capped 32 KB)

- [ ] **Step 1: Failing test** — in a temp git repo (reuse Task 3's setup helper inline): record + index a merged commit, then `showChange(root, sha)` returns text containing the full message and a `+` diff line; `showChange(root, 'fix-pay')` (slug) returns the same; unknown ref → throws.

```ts
// test/search-show.test.ts — same beforeEach repo as test/search-indexer.test.ts, then:
it('expands a sha and a slug to the full patch', async () => {
  const commits = await branchCommits('baton/fix-pay', 'main', root);
  recordTask(root, { slug: 'fix-pay', task: 'Fix payment retry', branch: 'baton/fix-pay', baseBranch: 'main', createdAt: '2026-01-01' });
  recordMerge(root, { slug: 'fix-pay', mergedAt: '2026-01-02', archivedRef: null, commits });
  const bySha = await showChange(root, commits[0].sha);
  expect(bySha).toContain('retryTimeout');       // full message
  expect(bySha).toContain('+  return x + 1');    // patch line
  const bySlug = await showChange(root, 'fix-pay');
  expect(bySlug).toContain(commits[0].sha.slice(0, 7));
  await expect(showChange(root, 'nope-nope')).rejects.toThrow(/no commit or task/i);
});
```

- [ ] **Step 2: Verify FAIL** · **Step 3: Implement**

```ts
// src/search/show.ts
/** show_change: the on-demand expander — full patch straight from git (the DB
 *  stays an index; git stays the source of truth, incl. archived refs). */
import { gitTry } from '../util/exec.js';
import { loadKb } from '../kb/state.js';
import { searchDb } from './db.js';

const PATCH_CAP = 32 * 1024; // chars — an agent asked for detail, not a dump

async function patchFrom(repo: string, sha: string): Promise<string | null> {
  const r = await gitTry(['show', '--stat', '--patch', '--no-color', sha], repo);
  return r.ok ? r.stdout : null;
}

export async function showChange(root: string, ref: string): Promise<string> {
  const { db } = searchDb(root);
  // Resolve slug → its commits; sha (prefix) → one commit.
  const bySlug = db.prepare(`SELECT sha FROM commits WHERE slug = ? ORDER BY at DESC`).all(ref) as { sha: string }[];
  const byShaRow = db.prepare(`SELECT sha FROM commits WHERE sha LIKE ?`).get(`${ref}%`) as { sha: string } | undefined;
  const shas = bySlug.length ? bySlug.map((r) => r.sha) : byShaRow ? [byShaRow.sha] : [];
  if (!shas.length) throw new Error(`no commit or task matching '${ref}' — try search_context first`);

  // The commit lives in the served repo (single) or one of the hub's sub-repos.
  const kb = await loadKb(root);
  const repos = [root, ...(kb?.projects.map((p) => p.path) ?? [])];
  const out: string[] = [];
  for (const sha of shas.slice(0, 5)) {
    let patch: string | null = null;
    for (const repo of repos) {
      patch = await patchFrom(repo, sha);
      if (patch) break;
    }
    out.push(patch ?? `${sha}: objects unreachable (repo moved or purged)`);
  }
  const text = out.join('\n\n');
  return text.length > PATCH_CAP ? text.slice(0, PATCH_CAP) + '\n… [truncated at 32KB]' : text;
}
```

- [ ] **Step 4: Tests green** · **Step 5: Commit (ask the user first)**

```bash
git add src/search/show.ts test/search-show.test.ts
git commit -m "feat(search): show_change expander (full patch from git)"
```

---

### Task 7: MCP wiring + backfill on daemon start + docs

**Files:**
- Modify: `src/mcp.ts` (register the two tools, after `recall_memory`)
- Modify: `src/server.ts:~911` (`serve()`: fire-and-forget `backfillFts(root)` once at startup, alongside the existing sweeps)
- Modify: `docs/mcp-tools.md`, `AGENTS.md` template source (grep for where `AGENTS.md` guidance text is generated — `src/kb/` docs writer), `STATUS.md`
- Test: `test/search-mcp.test.ts` (call the underlying functions; stdio transport not needed)

**Interfaces:**
- Consumes: `searchContext` (Task 5), `showChange` (Task 6), `backfillFts` (Task 2)

- [ ] **Step 1: Failing test** — `searchContext` and `showChange` are already unit-tested; here test only the root-resolution glue if any is added. If no new logic beyond registration, SKIP the new test file and rely on a manual smoke (Step 4).

- [ ] **Step 2: Register the tools in `src/mcp.ts`** (mirror the `recall_memory` block at src/mcp.ts:110):

```ts
  server.registerTool(
    'search_context',
    {
      description:
        'Search project knowledge BEFORE reading git log or exploring: one ranked query over memory facts, past tasks, commits, and completion reports — joined to code symbols. Filters: kind, path, symbol, agent, project, since/until. Returns compact cited rows within a token budget. Stale facts are withheld. Expand any hit with show_change.',
      inputSchema: {
        query: z.string().optional().describe('Keywords — identifiers welcome (camelCase is split automatically)'),
        kind: z.enum(['commit', 'fact', 'any']).optional(),
        path: z.string().optional().describe('File path prefix filter'),
        symbol: z.string().optional().describe('Function/class name filter'),
        agent: z.string().optional(), project: z.string().optional(),
        since: z.string().optional(), until: z.string().optional(),
        limit: z.number().optional(), max_tokens: z.number().optional(),
      },
    },
    async (a) => {
      const r = await searchContext(root, { ...a, maxTokens: a.max_tokens });
      return asText(r.text);
    },
  );

  server.registerTool(
    'show_change',
    {
      description: 'Expand one search_context hit: full commit message, file list, and patch for a sha or task slug (fetched live from git; capped at 32KB).',
      inputSchema: { ref: z.string().describe('Commit sha (prefix ok) or task slug') },
    },
    async ({ ref }) => asText(await showChange(root, ref)),
  );
```
with imports `import { searchContext } from './search/query.js'; import { showChange } from './search/show.js';`. Check how `root` is resolved in `startMcpServer` — if it uses `gitRoot()`, switch to `resolveBatonRoot()` (from the hub work) so search works from a hub root too.

- [ ] **Step 3: Backfill at daemon start** — in `serve()` next to `sweepTmpFiles`:

```ts
  // Index pre-existing history into the search FTS once (no-op after first run).
  void Promise.resolve().then(() => backfillFts(root)).catch(() => undefined);
```

- [ ] **Step 4: Manual smoke** — build, then in a scratch repo with a merged task:

```bash
npm run build && npx vitest run          # everything green
node dist/cli.js mcp <<'EOF' 2>/dev/null # optional: verify tools list over stdio
EOF
```
Simplest reliable smoke: a tiny script calling `searchContext(root, { query: '…' })` against a repo with history (the vitest integration tests already cover this — the smoke is for the MCP registration only: run `baton mcp` and check it boots without error).

- [ ] **Step 5: Docs** — `docs/mcp-tools.md`: add both tools with the input table and a worked example ("who changed the checkout retry logic?" → rows). `STATUS.md`: add the feature row + session entry. AGENTS.md guidance text: add one line "search_context before git log; cite what you use."

- [ ] **Step 6: Commit (ask the user first)**

```bash
git add src/mcp.ts src/server.ts docs/mcp-tools.md STATUS.md <agents-md-source>
git commit -m "feat(search): expose search_context + show_change over MCP; index backfill on serve"
```

---

## Self-review notes (done at plan time)

- **Spec coverage:** schema ✅ (T2) · merge pipeline ✅ (T3) · fact search with stale-withhold ✅ (T4+T5) · two tools ✅ (T5/T6/T7) · budget/citations ✅ (T5) · LIKE fallback ✅ (T2/T5) · hub `project` ✅ (T2/T3/T5) · backfill ✅ (T2/T7) · focal-path bump — CUT from v1 (spec marked it optional; path filter covers the need; revisit after dogfooding).
- **Type consistency:** `SearchHandle {db, fts}` consumed by T3/T4/T5/T6; `subtokens` shared T1→T2/T3/T4/T5; `indexMergedTask` signature matches merge.ts call site (task.projectId from the hub work).
- **Known judgment calls for the implementer:** `MemoryStatus` field names in T4 (verify against `src/memory.ts` — noted inline); bm25() takes one weight per column incl. UNINDEXED (5 zeros then 5 weights — verify column count matches the CREATE); `recordTask` project-column feature-detect (T2) avoids a chicken-and-egg with the migration.
