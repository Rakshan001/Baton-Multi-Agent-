# Audit Hardening Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the seven remaining fixes from the 2026-07 audit: kb.json path validation, `.baton` ownership gate, scoped merge rebuild, detectAgents TTL cache, SSE connection caps, tasks.json cross-process lock, and 10-char tmux prefixes.

**Architecture:** All backend (`src/`), no API-shape changes. Each fix is local to one module with a small exported/testable surface. Validation lives in `loadKb` (single choke point); the ownership gate lives inside `resolveBatonRoot`'s walk; the SSE cap is a tiny reusable `SseGate` class in `src/util/`; the lock is an mkdir-based advisory lock inside `store.ts`.

**Tech Stack:** Node ≥ 20, TypeScript strict, vitest. Zero new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-05-hardening-bundle-design.md`

## Global Constraints

- Zero new dependencies; daemon stays raw `node:http`.
- All git calls via existing helpers (`src/git.ts` / `src/util/exec.ts`) — never shell out directly.
- No API response-shape changes; the only new response is `429 {"error":"too many event streams"}`.
- Do NOT apply the auditor's "stop the upward walk at the git repo root" idea — it breaks hubs. Only the ownership check ships.
- Ownership gate: uid match + world-writable bit only (`mode & 0o002`); group-writable is allowed (Ubuntu user-private-group umask 002 would false-positive).
- Warn-once semantics for recurring validation failures (2 s pollers must not spam logs).
- Baseline: `npm run build && npx vitest run` currently passes with **292 tests** — all must stay green; each task adds its own tests on top. `test/hub.test.ts` has a known rare teardown flake: if it alone fails, re-run just that file once.
- Commit after each task (task commits pre-approved; never push).

---

### Task 1: kb.json project-path validation

**Files:**
- Modify: `src/kb/state.ts` (imports at lines 6–9; `loadKb` at lines 43–50)
- Test: `test/kb-validate.test.ts` (new)

**Interfaces:**
- Consumes: existing `KbState`/`KbProject` types (same file).
- Produces: `loadKb(root)` now returns a state whose `projects` only contains vetted entries; `resetKbValidationWarnings(): void` exported for tests. Task 3 relies on `loadKb` returning only vetted projects.

- [ ] **Step 1: Write the failing tests**

Create `test/kb-validate.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadKb, saveKb, resetKbValidationWarnings, type KbState } from '../src/kb/state.js';

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'baton-kbval-'));
  await mkdir(join(root, '.baton'), { recursive: true });
  return root;
}

/** Write kb.json with the given projects (id/name derived from path). */
async function writeState(root: string, paths: string[]): Promise<void> {
  const state: KbState = {
    root,
    projects: paths.map((p, i) => ({
      id: `p${i}`, name: `p${i}`, path: p, graphPath: join(p, 'graphify-out', 'graph.json'),
    })),
    mergedGraphPath: null,
    lastBuiltAt: null,
  };
  await saveKb(root, state);
}

describe('loadKb project validation', () => {
  beforeEach(() => resetKbValidationWarnings());
  afterEach(() => vi.restoreAllMocks());

  it('keeps a valid project (dir under root with a .git dir)', async () => {
    const root = await makeRoot();
    const proj = join(root, 'api');
    await mkdir(join(proj, '.git'), { recursive: true });
    await writeState(root, [proj]);
    const kb = await loadKb(root);
    expect(kb?.projects.map((p) => p.path)).toEqual([proj]);
  });

  it('keeps a git-worktree project (.git is a file)', async () => {
    const root = await makeRoot();
    const proj = join(root, 'wt');
    await mkdir(proj, { recursive: true });
    await writeFile(join(proj, '.git'), 'gitdir: /somewhere/.git/worktrees/wt\n');
    await writeState(root, [proj]);
    const kb = await loadKb(root);
    expect(kb?.projects).toHaveLength(1);
  });

  it('accepts path === root (single-repo mode)', async () => {
    const root = await makeRoot();
    await mkdir(join(root, '.git'), { recursive: true });
    await writeState(root, [root]);
    const kb = await loadKb(root);
    expect(kb?.projects).toHaveLength(1);
  });

  it('drops a project outside the root', async () => {
    const root = await makeRoot();
    const outside = await mkdtemp(join(tmpdir(), 'baton-outside-'));
    await mkdir(join(outside, '.git'), { recursive: true });
    await writeState(root, [outside]);
    const kb = await loadKb(root);
    expect(kb?.projects).toHaveLength(0);
  });

  it('drops a symlink that escapes the root', async () => {
    const root = await makeRoot();
    const outside = await mkdtemp(join(tmpdir(), 'baton-target-'));
    await mkdir(join(outside, '.git'), { recursive: true });
    const link = join(root, 'sneaky');
    await symlink(outside, link, 'dir');
    await writeState(root, [link]);
    const kb = await loadKb(root);
    expect(kb?.projects).toHaveLength(0);
  });

  it('drops a project without .git and a missing path', async () => {
    const root = await makeRoot();
    const nogit = join(root, 'plain');
    await mkdir(nogit, { recursive: true });
    await writeState(root, [nogit, join(root, 'missing')]);
    const kb = await loadKb(root);
    expect(kb?.projects).toHaveLength(0);
  });

  it('warns once per unique bad path across repeated loads', async () => {
    const root = await makeRoot();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await writeState(root, [join(root, 'missing')]);
    await loadKb(root);
    await loadKb(root);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && npx vitest run test/kb-validate.test.ts`
Expected: FAIL — `resetKbValidationWarnings` is not exported (and validation doesn't exist yet).

- [ ] **Step 3: Implement validation in `src/kb/state.ts`**

Extend the fs import (line 6) and add a path import addition:

```ts
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
```

Add above `loadKb` and replace `loadKb`:

```ts
// Warn once per bad path — loadKb runs on 2s poll paths and must not spam.
const invalidWarned = new Set<string>();

/** Test-only: clear the warn-once memory between test cases. */
export function resetKbValidationWarnings(): void {
  invalidWarned.clear();
}

/**
 * A kb.json project entry is trusted only if its path realpath-resolves to the
 * Baton root or below AND is a directory containing `.git` (dir for a repo,
 * file for a git worktree). kb.json is plain JSON on disk — a tampered or
 * stale entry must not steer graphify spawns or stats reads elsewhere.
 */
async function isValidProject(root: string, p: KbProject): Promise<boolean> {
  try {
    const [realRoot, realProj] = await Promise.all([realpath(root), realpath(p.path)]);
    if (realProj !== realRoot && !realProj.startsWith(realRoot + sep)) throw new Error('outside the Baton root');
    if (!(await stat(p.path)).isDirectory()) throw new Error('not a directory');
    await stat(join(p.path, '.git')); // repo dir or worktree file — either is fine
    return true;
  } catch (e) {
    if (!invalidWarned.has(p.path)) {
      invalidWarned.add(p.path);
      console.warn(`[baton] kb.json: skipping project '${p.id}' — ${p.path}: ${(e as Error).message}`);
    }
    return false;
  }
}

export async function loadKb(root: string): Promise<KbState | null> {
  try {
    const raw = await readFile(kbFile(root), 'utf-8');
    const state = JSON.parse(raw) as KbState;
    const checks = await Promise.all(state.projects.map((p) => isValidProject(root, p)));
    state.projects = state.projects.filter((_, i) => checks[i]);
    return state;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run test/kb-validate.test.ts`
Expected: 7 passed. Then `npx vitest run` — full suite green (292 + 7). If an existing test now fails because its fixture kb.json lacks `.git` dirs, fix the FIXTURE to create `.git` dirs (the validation is the desired behavior) and note it in your report.

- [ ] **Step 5: Commit**

```bash
git add src/kb/state.ts test/kb-validate.test.ts
git commit -m "fix(kb): validate kb.json project paths on load — under-root + git-repo only"
```

---

### Task 2: `.baton` ownership gate in resolveBatonRoot

**Files:**
- Modify: `src/store.ts` (lines 45–56, `resolveBatonRoot`)
- Test: extend `test/store.test.ts` (new describe block)

**Interfaces:**
- Consumes: nothing new.
- Produces: same `resolveBatonRoot(cwd?: string): Promise<string>` signature; behavior change only.

- [ ] **Step 1: Write the failing test**

Append to `test/store.test.ts` (match the file's existing imports/style — it already exercises `resolveBatonRoot` with tmp dirs):

```ts
describe('resolveBatonRoot ownership gate', () => {
  it.skipIf(process.platform === 'win32')('skips a world-writable .baton and keeps walking up', async () => {
    const { mkdtemp, mkdir, chmod } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const base = await mkdtemp(join(tmpdir(), 'baton-own-'));
    // legit root at base, planted world-writable .baton deeper down
    await mkdir(join(base, '.baton'), { recursive: true });
    await chmod(join(base, '.baton'), 0o755);
    const deep = join(base, 'sub', 'repo');
    await mkdir(join(deep, '.baton'), { recursive: true });
    await chmod(join(deep, '.baton'), 0o777); // world-writable → untrusted
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = await resolveBatonRoot(deep);
    expect(root).toBe(base);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it.skipIf(process.platform === 'win32')('accepts a normal user-owned 755 .baton', async () => {
    const { mkdtemp, mkdir, chmod } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const base = await mkdtemp(join(tmpdir(), 'baton-own2-'));
    await mkdir(join(base, '.baton'), { recursive: true });
    await chmod(join(base, '.baton'), 0o755);
    expect(await resolveBatonRoot(base)).toBe(base);
  });
});
```

(Import `vi` from vitest in the file's import line if not already there.)

- [ ] **Step 2: Run to verify the first test fails**

Run: `npm run build && npx vitest run test/store.test.ts`
Expected: FAIL — world-writable `.baton` is currently accepted, so `root` equals `deep`, not `base`.

- [ ] **Step 3: Implement the gate in `src/store.ts`**

Replace `resolveBatonRoot` (lines 45–56) with:

```ts
// Warn once per untrusted .baton dir — resolveBatonRoot runs on hot paths.
const untrustedWarned = new Set<string>();

/**
 * True if `dir/.baton` exists, is a directory, and is safe to adopt: owned by
 * the current user and not world-writable. Group-writable is deliberately
 * allowed (Debian/Ubuntu user-private-group setups run umask 002); the uid
 * match is the real gate against a .baton planted by another user. On
 * platforms without getuid (Windows) the ownership check is skipped.
 */
async function trustedBatonDir(dir: string): Promise<boolean> {
  const st = await stat(join(dir, '.baton'));
  if (!st.isDirectory()) return false;
  if (typeof process.getuid !== 'function') return true;
  if (st.uid !== process.getuid() || (st.mode & 0o002) !== 0) {
    if (!untrustedWarned.has(dir)) {
      untrustedWarned.add(dir);
      console.warn(
        `[baton] ignoring untrusted .baton at ${dir} (uid ${st.uid}, mode ${(st.mode & 0o777).toString(8)}) — continuing upward`,
      );
    }
    return false;
  }
  return true;
}

export async function resolveBatonRoot(cwd: string = process.cwd()): Promise<string> {
  let dir = cwd;
  for (;;) {
    try {
      if (await trustedBatonDir(dir)) return dir;
    } catch { /* no .baton here — keep walking up */ }
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  return gitRoot(cwd); // not set up yet → the git repo is the Baton root
}
```

(`stat` is already imported at line 5. Do NOT add any git-boundary stop to the walk.)

- [ ] **Step 4: Run tests**

Run: `npm run build && npx vitest run test/store.test.ts`
Expected: all pass, including the pre-existing resolveBatonRoot tests (tmp dirs default to 755 under umask 022; if CI umask is 002 the dirs are group-writable, which the gate allows by design).

- [ ] **Step 5: Commit**

```bash
git add src/store.ts test/store.test.ts
git commit -m "fix(security): refuse untrusted .baton dirs in the root walk (uid + world-writable gate)"
```

---

### Task 3: Scoped merge rebuild

**Files:**
- Modify: `src/commands/merge.ts` (imports ~line 9–18; rebuild block at lines 104–110)
- Test: `test/merge-scope.test.ts` (new)

**Interfaces:**
- Consumes: `KbProject` from `src/kb/state.js`; vetted `kb.projects` from Task 1's `loadKb`.
- Produces: `projectForRepo(projects: KbProject[], gitRepo: string): Promise<KbProject | null>` exported from `src/commands/merge.ts`.

Background: today the post-merge block enqueues `update(p.path)` for EVERY kb project. The merged graph is NOT refreshed on merge today (that only happens in `POST /api/kb/rebuild`, server.ts:518–527) — preserve that: scope the per-project rebuild, add nothing for merged.

- [ ] **Step 1: Write the failing test**

Create `test/merge-scope.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && npx vitest run test/merge-scope.test.ts`
Expected: FAIL — `projectForRepo` is not exported.

- [ ] **Step 3: Implement in `src/commands/merge.ts`**

Add `realpath` to the imports:

```ts
import { realpath } from 'node:fs/promises';
import { buildQueue, loadKb, type KbProject } from '../kb/state.js';
```

Add the helper (near the other exports):

```ts
/** The kb project whose path is the merged task's git repo (realpath-compared). */
export async function projectForRepo(projects: KbProject[], gitRepo: string): Promise<KbProject | null> {
  let real: string;
  try {
    real = await realpath(gitRepo);
  } catch {
    return null;
  }
  for (const p of projects) {
    try {
      if ((await realpath(p.path)) === real) return p;
    } catch { /* project path missing — skip */ }
  }
  return null;
}
```

Replace the rebuild block (lines 104–110):

```ts
  // Keep the knowledge graph current: squash-merges land on the base branch
  // outside graphify's per-commit hook, so queue an incremental update here.
  // Only the merged repo's project changed — never rebuild the whole hub.
  // Fire-and-forget — a graph refresh must never block or fail a merge.
  void loadKb(repoRoot).then(async (kb) => {
    if (!kb) return;
    const target = await projectForRepo(kb.projects, gitRepo);
    if (!target) {
      console.warn(`[baton] merge ${slug}: no kb project matches ${gitRepo} — skipping graph refresh`);
      return;
    }
    buildQueue.enqueue(target.id, () => update(target.path), (err) => {
      if (!err) bus.publish({ type: 'kb.rebuilt', project: target.id });
    });
  }).catch(() => undefined);
```

- [ ] **Step 4: Run tests**

Run: `npm run build && npx vitest run test/merge-scope.test.ts && npx vitest run`
Expected: new tests pass; full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/commands/merge.ts test/merge-scope.test.ts
git commit -m "perf(kb): merge rebuilds only the affected project, not the whole hub"
```

---

### Task 4: detectAgents TTL cache

**Files:**
- Modify: `src/agents.ts` (the `detectAgents` function, lines ~68–87)
- Test: extend `test/agents.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `detectAgents(worktreePaths: string[], opts?: { now?: () => number; scan?: (paths: string[]) => Promise<Map<string, string>> }): Promise<Map<string, string>>` — `opts` is test-only injection; all existing call sites (board.ts:28, signals.ts:149/182, merge.ts:62) pass only the array and need no changes. Also `resetDetectAgentsCache(): void` for tests.

- [ ] **Step 1: Write the failing test**

Append to `test/agents.test.ts` (respect its existing imports; add `resetDetectAgentsCache` to the import from `../src/agents.js`):

```ts
describe('detectAgents TTL cache', () => {
  it('reuses the scan within 2s for the same paths, rescans after and on key change', async () => {
    resetDetectAgentsCache();
    let calls = 0;
    const scan = async () => { calls++; return new Map([['/wt/a', 'claude']]); };
    let t = 1_000_000;
    const now = () => t;

    const r1 = await detectAgents(['/wt/a'], { scan, now });
    expect(r1.get('/wt/a')).toBe('claude');
    expect(calls).toBe(1);

    const r2 = await detectAgents(['/wt/a'], { scan, now }); // within TTL
    expect(calls).toBe(1);
    expect(r2).not.toBe(r1); // defensive copy, not the cached Map itself
    expect([...r2.entries()]).toEqual([...r1.entries()]);

    t += 2001; // TTL expired
    await detectAgents(['/wt/a'], { scan, now });
    expect(calls).toBe(2);

    await detectAgents(['/wt/a', '/wt/b'], { scan, now }); // different key
    expect(calls).toBe(3);
  });

  it('returns an empty map for no paths without scanning', async () => {
    resetDetectAgentsCache();
    let calls = 0;
    const scan = async () => { calls++; return new Map<string, string>(); };
    expect((await detectAgents([], { scan })).size).toBe(0);
    expect(calls).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && npx vitest run test/agents.test.ts`
Expected: FAIL — `resetDetectAgentsCache` not exported; `detectAgents` takes one arg.

- [ ] **Step 3: Implement in `src/agents.ts`**

Rename the existing exported `detectAgents` function to a private `scanAgents` (same body, drop `export`), then add:

```ts
// The process-table sweep (ps + per-pid lsof) is the daemon's most expensive
// poll-path call and gets hit by the board poller, /api/status and
// /api/signals concurrently — up to 12×/s measured. One shared 2s cache
// collapses those bursts; ≤2s staleness is invisible at the board's own 2s tick.
const DETECT_TTL_MS = 2000;
let detectCache: { key: string; at: number; result: Map<string, string> } | null = null;

/** Test-only: drop the cache between test cases. */
export function resetDetectAgentsCache(): void {
  detectCache = null;
}

export async function detectAgents(
  worktreePaths: string[],
  opts: { now?: () => number; scan?: (paths: string[]) => Promise<Map<string, string>> } = {},
): Promise<Map<string, string>> {
  if (worktreePaths.length === 0) return new Map();
  const now = opts.now ?? Date.now;
  const scan = opts.scan ?? scanAgents;
  const key = [...worktreePaths].sort().join(' ');
  const t = now();
  if (detectCache && detectCache.key === key && t - detectCache.at < DETECT_TTL_MS) {
    return new Map(detectCache.result);
  }
  const result = await scan(worktreePaths);
  detectCache = { key, at: t, result: new Map(result) };
  return result;
}
```

(Keep `scanAgents`'s internal early-return for empty input; it's now unreachable but harmless.)

- [ ] **Step 4: Run tests**

Run: `npm run build && npx vitest run test/agents.test.ts && npx vitest run`
Expected: new tests pass; full suite green (existing agents tests unaffected — they test the pure matchers).

- [ ] **Step 5: Commit**

```bash
git add src/agents.ts test/agents.test.ts
git commit -m "perf(agents): 2s TTL cache on detectAgents — one ps/lsof sweep per poll tick"
```

---

### Task 5: SSE connection caps

**Files:**
- Create: `src/util/sse-gate.ts`
- Modify: `src/server.ts` (`handleEvents` at ~line 163, `handleTerminalStream` at ~line 200)
- Test: `test/sse-gate.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: `class SseGate { constructor(max: number); tryAcquire(): (() => void) | null; get count(): number }` in `src/util/sse-gate.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/sse-gate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SseGate } from '../src/util/sse-gate.js';

describe('SseGate', () => {
  it('grants up to max slots, rejects beyond, and frees on release', () => {
    const gate = new SseGate(2);
    const a = gate.tryAcquire();
    const b = gate.tryAcquire();
    expect(a).toBeTypeOf('function');
    expect(b).toBeTypeOf('function');
    expect(gate.tryAcquire()).toBeNull();
    expect(gate.count).toBe(2);
    b!();
    expect(gate.count).toBe(1);
    expect(gate.tryAcquire()).toBeTypeOf('function');
  });

  it('release is idempotent', () => {
    const gate = new SseGate(1);
    const rel = gate.tryAcquire()!;
    rel();
    rel();
    expect(gate.count).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && npx vitest run test/sse-gate.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `src/util/sse-gate.ts`**

```ts
/**
 * Bounded counter for concurrent SSE connections. The event bus intentionally
 * has no listener cap (each stream cleans up on disconnect); this gate bounds
 * the number of streams at the connection layer instead, so a runaway client
 * can't grow the per-publish fan-out without limit.
 */
export class SseGate {
  private n = 0;
  constructor(private readonly max: number) {}

  /** A release function when a slot is free, null when at capacity. */
  tryAcquire(): (() => void) | null {
    if (this.n >= this.max) return null;
    this.n++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.n--;
      }
    };
  }

  get count(): number {
    return this.n;
  }
}
```

- [ ] **Step 4: Wire into `src/server.ts`**

Add the import next to the other util imports:

```ts
import { SseGate } from './util/sse-gate.js';
```

Add module-level gates (near other module-level state, before the handlers):

```ts
// Cap concurrent SSE streams — a stuck or hostile client must not grow the
// bus fan-out unboundedly. 64 covers any realistic number of dashboard tabs.
const MAX_SSE_STREAMS = 64;
const eventsGate = new SseGate(MAX_SSE_STREAMS);
const terminalGate = new SseGate(MAX_SSE_STREAMS);
```

At the very top of `handleEvents` (before `res.writeHead`):

```ts
  const releaseSlot = eventsGate.tryAcquire();
  if (!releaseSlot) return send(res, 429, { error: 'too many event streams' }, origin);
```

and in its `req.on('close', …)` callback add `releaseSlot();` after `release();`.

Same pattern at the top of `handleTerminalStream` (before its `res.writeHead`), using `terminalGate`, and `releaseSlot();` in that handler's close/cleanup path (find its `req.on('close'` or equivalent teardown and add the call).

Note: `handleEvents` already has a variable named `release` (the poller retain) — the new one must be `releaseSlot` to avoid shadowing.

- [ ] **Step 5: Run tests**

Run: `npm run build && npx vitest run test/sse-gate.test.ts && npx vitest run`
Expected: new tests pass; full suite green (route e2e tests open only a few streams, far below 64).

- [ ] **Step 6: Commit**

```bash
git add src/util/sse-gate.ts src/server.ts test/sse-gate.test.ts
git commit -m "fix(server): cap concurrent SSE streams at 64 per kind (429 beyond)"
```

---

### Task 6: tasks.json cross-process lock

**Files:**
- Modify: `src/store.ts` (imports line 5; `addTask`/`removeTask` at lines 94–107)
- Test: extend `test/store.test.ts`

**Interfaces:**
- Consumes: `batonDir`, `serialized` (same file).
- Produces: no signature changes; `addTask`/`removeTask` now lock across processes.

- [ ] **Step 1: Write the failing test**

Append to `test/store.test.ts` (uses the file's existing tmp-repo helpers; adapt names to what's there):

```ts
describe('tasks.json cross-process lock', () => {
  it('breaks a stale lock and still writes', async () => {
    const { mkdtemp, mkdir, utimes } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'baton-lock-'));
    await mkdir(join(root, '.baton'), { recursive: true });
    // a lock dir left behind by a crashed process, 10s old
    const lock = join(root, '.baton', 'tasks.lock');
    await mkdir(lock);
    const old = (Date.now() - 10_000) / 1000;
    await utimes(lock, old, old);
    await addTask(root, {
      slug: 't1', task: 'T1', branch: 'baton/t1', worktreePath: join(root, 'wt'),
      baseBranch: 'main', baseCommit: null, createdAt: new Date().toISOString(),
    });
    expect((await loadTasks(root)).map((t) => t.slug)).toEqual(['t1']);
  });

  it('releases the lock after a write (second write is fast)', async () => {
    const { mkdtemp, mkdir, stat } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'baton-lock2-'));
    await mkdir(join(root, '.baton'), { recursive: true });
    const task = (slug: string) => ({
      slug, task: slug, branch: `baton/${slug}`, worktreePath: join(root, slug),
      baseBranch: 'main', baseCommit: null, createdAt: new Date().toISOString(),
    });
    await addTask(root, task('a'));
    await expect(stat(join(root, '.baton', 'tasks.lock'))).rejects.toThrow(); // released
    const t0 = Date.now();
    await addTask(root, task('b'));
    expect(Date.now() - t0).toBeLessThan(500); // no lock contention
    expect((await loadTasks(root)).map((t) => t.slug)).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run to verify the first test fails**

Run: `npm run build && npx vitest run test/store.test.ts`
Expected: the stale-lock test FAILS only after implementation exists — before it, both currently PASS trivially (no lock is consulted). That makes this a characterization risk: to confirm the tests bite, temporarily note that the stale-lock test passing pre-change is expected; the real assertion is post-change behavior (lock consulted, broken, released). Proceed.

- [ ] **Step 3: Implement in `src/store.ts`**

Extend the fs import (line 5):

```ts
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
```

Add above `addTask`:

```ts
// Cross-process advisory lock: `serialized()` covers concurrent writes inside
// ONE process, but the CLI (`baton new`) and a running daemon are separate
// processes writing the same tasks.json — without a lock, simultaneous
// read-modify-writes lose one side's update (writes stay crash-atomic via
// tmp+rename either way; this is about lost updates, not torn files).
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 2000;
const LOCK_STALE_MS = 5000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function withTasksLock<T>(gitRoot: string, fn: () => Promise<T>): Promise<T> {
  const lock = join(batonDir(gitRoot), 'tasks.lock');
  await mkdir(batonDir(gitRoot), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let acquired = false;
  while (!acquired) {
    try {
      await mkdir(lock); // atomic: only one process can create it
      acquired = true;
    } catch {
      try {
        const st = await stat(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await rm(lock, { recursive: true, force: true }); // crashed holder — break it
          continue;
        }
      } catch {
        continue; // lock vanished between mkdir and stat — retry immediately
      }
      if (Date.now() >= deadline) {
        // Availability over strictness: a wedged lock must not brick task writes.
        console.warn(`[baton] tasks.lock busy for ${LOCK_TIMEOUT_MS}ms — proceeding without it`);
        break;
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    if (acquired) await rm(lock, { recursive: true, force: true }).catch(() => undefined);
  }
}
```

Wrap the bodies of `addTask` and `removeTask`:

```ts
export async function addTask(gitRoot: string, task: Task): Promise<void> {
  await serialized(() =>
    withTasksLock(gitRoot, async () => {
      const tasks = await loadTasks(gitRoot);
      tasks.push(task);
      await saveTasks(gitRoot, tasks);
    }),
  );
}

export async function removeTask(gitRoot: string, slug: string): Promise<void> {
  await serialized(() =>
    withTasksLock(gitRoot, async () => {
      const tasks = (await loadTasks(gitRoot)).filter((t) => t.slug !== slug);
      await saveTasks(gitRoot, tasks);
    }),
  );
}
```

- [ ] **Step 4: Run tests**

Run: `npm run build && npx vitest run test/store.test.ts && npx vitest run`
Expected: all pass; full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts test/store.test.ts
git commit -m "fix(store): advisory cross-process lock around tasks.json read-modify-write"
```

---

### Task 7: tmux prefix entropy + docs + STATUS + verification

**Files:**
- Modify: `src/util/tmux.ts:41` (`slice(0, 6)` → `slice(0, 10)`)
- Modify: `test/terminals.test.ts` if it asserts prefix length/values (check first)
- Modify: `STATUS.md` (one row, match the existing table format)
- Verify: everything

**Interfaces:** none new.

- [ ] **Step 1: Widen the hash**

In `src/util/tmux.ts` line 41, change:

```ts
  return `baton-${createHash('sha1').update(root).digest('hex').slice(0, 6)}-`;
```

to:

```ts
  // 10 hex chars (40 bits): two repos colliding on the prefix is effectively
  // impossible even across large hubs. Sessions named under the old 6-char
  // prefix stop matching after upgrade and age out on their own — accepted.
  return `baton-${createHash('sha1').update(root).digest('hex').slice(0, 10)}-`;
```

- [ ] **Step 2: Fix any length assertions**

Run: `grep -n "baton-" test/terminals.test.ts test/*.test.ts | grep -i "prefix\|session"` and update any test asserting the 6-char shape to expect 10 hex chars (e.g. regex `/^baton-[0-9a-f]{10}-/`).

- [ ] **Step 3: STATUS.md row**

Read `STATUS.md`, then add one row to the built table matching its format:

```markdown
| Audit hardening bundle | kb.json path validation, `.baton` ownership gate, scoped merge rebuild, detectAgents 2s cache, SSE stream cap (64), tasks.json cross-process lock, 10-char tmux prefixes | `npx vitest run` — kb-validate/store/merge-scope/agents/sse-gate tests |
```

- [ ] **Step 4: Full verification**

```bash
npm run build && npx vitest run     # expect 292 + all new tests passing, zero failures
npm run build --prefix web          # unchanged but must stay green
```

(`test/hub.test.ts` rare teardown flake: if it alone fails, re-run that file once.)

- [ ] **Step 5: Commit**

```bash
git add src/util/tmux.ts test/terminals.test.ts STATUS.md
git commit -m "fix(tmux): 10-char repo prefix; docs: record hardening bundle in STATUS"
```
