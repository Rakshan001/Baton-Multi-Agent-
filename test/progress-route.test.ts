// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `GET /api/worktrees/:slug/progress` — the plan's `wt-progress-route`.
 *
 * The progress ledger (`src/handoff/progress-ledger.ts:42-56`) is written by
 * MCP `save_progress` and, until this route, read only by `buildBrief`
 * (`src/handoff/brief.ts:207`). It is the richest statement of what a worktree
 * is actually doing that exists anywhere in the system, and nothing served it.
 * It is what turns *"quiet for 34m"* into *"quiet for 34m, and the last thing
 * it said it was doing was X"*.
 *
 * Three behaviours are pinned here because each one fails in a way that is
 * quiet rather than loud:
 *
 * 1. **Empty is not 404.** "This worktree has said nothing" and "this worktree
 *    does not exist" are different facts. Collapsing them into one status code
 *    makes a silent agent indistinguishable from a typo, which is precisely the
 *    confusion this plan exists to remove.
 * 2. **`flagged` survives the trip.** An agent claiming progress the repository
 *    cannot corroborate is the single most important thing on this response for
 *    a human reviewing stuck work. Filtering or softening it would hide the one
 *    row that needs attention.
 * 3. **A slug is hostile input that becomes a file path.** Same hazard the
 *    plan-markdown route documents at `src/server.ts:1741` — a traversal there
 *    is not a render, it is `GET /api/pipeline/plans/..%2f..%2f.baton%2fhost`
 *    reading a live token.
 *
 * Layer 1 (pure) runs without a repo. Layer 2 drives a real daemon started
 * WITHOUT `--write`, because a read-only daemon is what somebody reaches for
 * when they have found stuck work and are afraid to touch it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa, type ResultPromise } from 'execa';
import { freePort } from './helpers/free-port.js';
import { DAEMON_START_MS } from './helpers/daemon-start.js';
import { isSafeProgressSlug, progressView, saveProgress } from '../src/handoff/progress-ledger.js';

/* ------------------------------------------------------------------ */
/* Layer 1 — the pure view + the slug grammar                          */
/* ------------------------------------------------------------------ */

describe('progress slug grammar', () => {
  it('accepts the slugs tasks actually use', () => {
    for (const ok of ['api', 'wt-progress-route', 'phase_2', 'a', 'x9']) {
      expect(isSafeProgressSlug(ok), ok).toBe(true);
    }
  });

  it('refuses anything that could leave .baton/progress', () => {
    // Dots are excluded outright, so `..` cannot be spelled at all — the check
    // never has to reason about a normalized path.
    for (const bad of [
      '..', '../../etc/passwd', '../../.baton/host', '.baton', 'a/b', 'a\\b',
      '', '   ', 'a'.repeat(200), 'tab\there', 'nul\0byte',
    ]) {
      expect(isSafeProgressSlug(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('progressView', () => {
  let root = '';
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-progress-view-'));
  });
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it('answers honestly for a worktree that has never checkpointed', async () => {
    const view = await progressView(root, 'never-spoke');
    expect(view.slug).toBe('never-spoke');
    // Present, empty, and SAYING it is empty — not an error, not a 404.
    expect(view.hasLedger).toBe(false);
    expect(view.plan).toEqual([]);
    expect(view.notes).toEqual([]);
    expect(view.filesEdited).toEqual([]);
    expect(view.next).toBeNull();
    expect(view.flagged).toBeNull();
    expect(view.updatedAt).toBeNull();
  });

  it('carries plan, next action, files edited and the flagged marker', async () => {
    await saveProgress(root, 'api', {
      plan: [{ content: 'wire the route', status: 'completed' }],
      notes: ['the ledger was never served'],
      next: 'serve the ledger over HTTP',
      filesEdited: ['src/server.ts'],
      // A checkpoint that ticked an item while the repo shows nothing at all.
      stamp: { filesChanged: 0, insertions: 0, deletions: 0, commits: 0 },
    });
    const view = await progressView(root, 'api');
    expect(view.hasLedger).toBe(true);
    expect(view.plan).toEqual([{ content: 'wire the route', status: 'completed' }]);
    expect(view.notes).toEqual(['the ledger was never served']);
    expect(view.next).toBe('serve the ledger over HTTP');
    expect(view.filesEdited).toEqual(['src/server.ts']);
    expect(view.flagged).toContain('nothing here shows that work');
    expect(view.stamp).toEqual({ filesChanged: 0, insertions: 0, deletions: 0, commits: 0 });
    expect(typeof view.updatedAt).toBe('string');
  });
});

/* ------------------------------------------------------------------ */
/* Layer 2 — the route                                                 */
/* ------------------------------------------------------------------ */

const DIST_CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const hasDist = existsSync(DIST_CLI);

async function api(port: number, path: string): Promise<{ status: number; text: string; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(8000) });
  const text = await res.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, text, body };
}

async function makeRepo(dir: string): Promise<void> {
  await execa('git', ['init', '-q', '-b', 'main', dir]);
  await execa('git', ['config', 'user.email', 't@t.dev'], { cwd: dir });
  await execa('git', ['config', 'user.name', 't'], { cwd: dir });
  // A machine-global core.hooksPath must not fire in a throwaway repo — its
  // child inherits git's pipes and execa then waits on a stream that never
  // closes. (Same hazard the daemon-api suite documents.)
  await execa('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: dir });
  await execa('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
}

describe.runIf(hasDist)('GET /api/worktrees/:slug/progress', () => {
  let base = '';
  let repo = '';
  let registry = '';
  let port = 0;
  const children: ResultPromise[] = [];

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'baton-progress-route-'));
    registry = join(base, 'registry');
    repo = join(base, 'repo');
    await makeRepo(repo);

    const wt = join(repo, '.baton', 'wt', 'api');
    await execa('git', ['worktree', 'add', '-q', '-b', 'baton/api', wt, 'main'], { cwd: repo });

    const at = '2026-09-17T09:00:00.000Z';
    await mkdir(join(repo, '.baton'), { recursive: true });
    await writeFile(join(repo, '.baton', 'tasks.json'), JSON.stringify([{
      slug: 'api', task: 'Wire the API', branch: 'baton/api', worktreePath: wt,
      baseBranch: 'main', baseCommit: 'HEAD', createdAt: at, state: 'active',
      claimedBy: { agent: 'claude', sessionSlug: 's1', at },
    }], null, 2));

    // The ledger the route must serve. Written through `saveProgress` rather
    // than hand-rolled JSON so the test cannot drift from the writer's shape.
    await saveProgress(repo, 'api', {
      plan: [
        { content: 'read the ledger module', status: 'completed' },
        { content: 'serve it', status: 'in_progress' },
      ],
      notes: ['buildBrief is the only reader'],
      next: 'add the route to server.ts',
      filesEdited: ['src/server.ts', 'src/handoff/progress-ledger.ts'],
      stamp: { filesChanged: 0, insertions: 0, deletions: 0, commits: 0 },
    });

    // A planted secret outside .baton/progress, so a traversal that worked
    // would be visible as leaked bytes rather than merely a wrong status.
    await writeFile(join(repo, '.baton', 'host'), 'SECRET-DAEMON-TOKEN-9f3a\n');

    port = await freePort();
    // No --write on purpose: inspecting stuck work must not require a daemon
    // that can change anything.
    const child = execa('node', [DIST_CLI, 'serve', '--port', String(port)], {
      cwd: repo, reject: false, env: { ...process.env, BATON_DAEMONS_DIR: registry },
    });
    children.push(child);
    const deadline = Date.now() + DAEMON_START_MS;
    for (;;) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/meta`, { signal: AbortSignal.timeout(1000) })).ok) break;
      } catch { /* not yet */ }
      if (Date.now() > deadline) throw new Error(`daemon on ${port} did not start`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }, DAEMON_START_MS + 30_000);

  afterAll(async () => {
    for (const c of children) c.kill('SIGTERM');
    await Promise.allSettled(children.map((c) => c));
    if (base) await rm(base, { recursive: true, force: true });
  });

  it('serves the plan, next action and files edited on a read-only daemon', async () => {
    const { status, body } = await api(port, '/api/worktrees/api/progress');
    expect(status).toBe(200);
    expect(body.slug).toBe('api');
    expect(body.hasLedger).toBe(true);
    expect(body.plan.map((t: any) => t.content)).toEqual(['read the ledger module', 'serve it']);
    expect(body.plan[1].status).toBe('in_progress');
    expect(body.next).toBe('add the route to server.ts');
    expect(body.filesEdited).toEqual(['src/server.ts', 'src/handoff/progress-ledger.ts']);
    expect(body.notes).toEqual(['buildBrief is the only reader']);
    expect(typeof body.updatedAt).toBe('string');
  });

  it('carries the flagged overclaim marker through untouched', async () => {
    const { body } = await api(port, '/api/worktrees/api/progress');
    expect(typeof body.flagged).toBe('string');
    expect(body.flagged).toContain('nothing here shows that work');
  });

  it('returns an honest empty result — not a 404 — for a worktree with no ledger', async () => {
    const { status, body } = await api(port, '/api/worktrees/quiet/progress');
    expect(status).toBe(200);
    expect(body.hasLedger).toBe(false);
    expect(body.slug).toBe('quiet');
    expect(body.plan).toEqual([]);
    expect(body.notes).toEqual([]);
    expect(body.filesEdited).toEqual([]);
    expect(body.next).toBeNull();
    expect(body.flagged).toBeNull();
    expect(body.updatedAt).toBeNull();
  });

  it('refuses a traversal slug instead of reading outside .baton/progress', async () => {
    for (const hostile of [
      '..%2f..%2f.baton%2fhost',
      '..%2F..%2Fpackage.json',
      '%2e%2e%2f%2e%2e%2f.baton%2fhost',
      '.baton',
    ]) {
      const { status, text } = await api(port, `/api/worktrees/${hostile}/progress`);
      expect(status, hostile).toBe(400);
      expect(text, hostile).not.toContain('SECRET-DAEMON-TOKEN');
    }
  });
});
