// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The worktree read-model (`GET /api/worktrees`) — the plan's `wt-health-api`.
 *
 * Two layers, because they fail differently:
 *
 * 1. `deriveHealth` is pure, so every branch of the evidence ladder is pinned
 *    here without a repo. The one that matters most is the failure case: a row
 *    whose git calls did not answer must say `unknown`, never `working` and
 *    never `ok`. A health model that guesses "fine" when it cannot see is worse
 *    than no health model, because it launders dead work into looking fresh —
 *    the exact bug this plan exists to kill.
 *
 * 2. The route itself, against a real daemon started WITHOUT `--write`, because
 *    the read-only case is the one somebody reaches for when a worktree has
 *    gone quiet and they are afraid to touch anything.
 *
 * Layer 2 is gated on dist/cli.js being built (run `npm run build` first).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa, type ResultPromise } from 'execa';
import { freePort } from './helpers/free-port.js';
import { DAEMON_START_MS } from './helpers/daemon-start.js';
import { deriveHealth, STALL_QUIET_MS, type WorktreeFacts } from '../src/worktrees.js';
import { STALL_GRACE_MS } from '../src/pipeline.js';

const NOW = Date.UTC(2026, 8, 17, 12, 0, 0);

/** A healthy, live, claimed worktree — every test below mutates one fact off this. */
function facts(over: Partial<WorktreeFacts> = {}): WorktreeFacts {
  return {
    slug: 'api',
    branch: 'baton/api',
    worktreePath: '/tmp/wt/api',
    state: 'active',
    git: {
      status: 'clean',
      repoState: 'clean',
      ahead: 0,
      behind: 0,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    },
    localOnlyCommits: 0,
    agent: 'claude',
    claimedBy: 'claude',
    holderRunning: true,
    lastActivityAt: NOW - 1000,
    planId: null,
    phase: null,
    dependsOn: [],
    orphan: false,
    wipRef: null,
    ...over,
  };
}

const health = (over: Partial<WorktreeFacts> = {}) => deriveHealth(facts(over), NOW);

describe('worktree health derivation', () => {
  it('reports unknown — never working — when git could not answer', () => {
    expect(health({ git: null })).toBe('unknown');
  });

  it('reports unknown when local-only commits could not be counted', () => {
    // The refs read is a git call like any other. If it failed we cannot say
    // whether this branch exists anywhere but this disk, which is the whole
    // question, so we must not answer `ok`.
    expect(health({ localOnlyCommits: null })).toBe('unknown');
  });

  it('reports abandoned when the holder is gone and work is uncommitted', () => {
    expect(health({
      holderRunning: false,
      agent: null,
      git: { status: 'dirty', repoState: 'clean', ahead: 0, behind: 0, filesChanged: 3, insertions: 120, deletions: 4 },
    })).toBe('abandoned');
  });

  it('reports abandoned when the holder is gone and commits exist nowhere else', () => {
    // Committed is not the same as safe: these commits are on one branch on one
    // disk. This is the row the reporter is afraid of.
    expect(health({ holderRunning: false, agent: null, localOnlyCommits: 4 })).toBe('abandoned');
  });

  it('does not call a clean, fully-pushed dead holder abandoned', () => {
    expect(health({ holderRunning: false, agent: null })).not.toBe('abandoned');
  });

  it('reports missing for a recorded worktree whose directory is gone', () => {
    expect(health({
      git: { status: 'missing', repoState: 'clean', ahead: 0, behind: 0, filesChanged: 0, insertions: 0, deletions: 0 },
    })).toBe('missing');
  });

  it('reports orphan-disk for a baton worktree no task owns', () => {
    expect(health({ orphan: true, state: null, claimedBy: null, agent: null, holderRunning: false })).toBe('orphan-disk');
  });

  it('ranks conflict and an in-progress rebase above the liveness names', () => {
    expect(health({
      git: { status: 'conflict', repoState: 'clean', ahead: 0, behind: 0, filesChanged: 0, insertions: 1, deletions: 1 },
    })).toBe('conflict');
    expect(health({
      git: { status: 'dirty', repoState: 'rebasing', ahead: 0, behind: 0, filesChanged: 1, insertions: 1, deletions: 0 },
    })).toBe('rebasing');
  });

  it('walks working → quiet → stalled as the progress token ages', () => {
    expect(health({ lastActivityAt: NOW - (STALL_QUIET_MS - 1000) })).toBe('working');
    expect(health({ lastActivityAt: NOW - (STALL_QUIET_MS + 1000) })).toBe('quiet');
    expect(health({ lastActivityAt: NOW - (STALL_GRACE_MS + 1000) })).toBe('stalled');
  });

  it('never reports stalled for a holder that is demonstrably running', () => {
    // A twenty-minute build makes no tool calls and touches no file in the
    // worktree. Handing that agent's checkout to somebody else is a data-loss
    // operation, not a retry — see the plan's Kubernetes note.
    expect(health({ holderRunning: true, lastActivityAt: 0 })).toBe('unknown');
  });

  it('falls back to git truth when nobody holds the worktree', () => {
    const unheld = { state: 'queued' as const, claimedBy: null, agent: null, holderRunning: false };
    expect(health(unheld)).toBe('ok');
    expect(health({
      ...unheld,
      git: { status: 'dirty', repoState: 'clean', ahead: 0, behind: 0, filesChanged: 2, insertions: 9, deletions: 0 },
    })).toBe('dirty');
  });

  it('keeps health independent of state — a done task can still be unknown', () => {
    expect(health({ state: 'done', git: null })).toBe('unknown');
  });
});

/* ------------------------------------------------------------------ */
/* The route                                                           */
/* ------------------------------------------------------------------ */

const DIST_CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const hasDist = existsSync(DIST_CLI);
let PORT_RO = 0;

async function api(port: number, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(8000) });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
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

describe.runIf(hasDist)('GET /api/worktrees', () => {
  let base = '';
  let repo = '';
  let registry = '';
  const children: ResultPromise[] = [];

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'baton-wt-health-'));
    registry = join(base, 'registry');
    repo = join(base, 'repo');
    await makeRepo(repo);

    // One real worktree, claimed by an agent that is not running, holding
    // uncommitted work: the abandoned case, end to end.
    const wt = join(repo, '.baton', 'wt', 'api');
    await execa('git', ['worktree', 'add', '-q', '-b', 'baton/api', wt, 'main'], { cwd: repo });
    await writeFile(join(wt, 'half-done.ts'), 'export const x = 1;\n');

    const at = '2026-09-17T09:00:00.000Z';
    await mkdir(join(repo, '.baton'), { recursive: true });
    await writeFile(join(repo, '.baton', 'tasks.json'), JSON.stringify([{
      slug: 'api', task: 'Wire the API', branch: 'baton/api', worktreePath: wt,
      baseBranch: 'main', baseCommit: 'HEAD', createdAt: at,
      planId: 'auth', phase: 2, dependsOn: ['schema'], state: 'active',
      claimedBy: { agent: 'claude', sessionSlug: 's1', at },
    }], null, 2));

    PORT_RO = await freePort();
    // No --write on purpose: this read-model must be reachable from a daemon
    // that cannot change anything.
    const child = execa('node', [DIST_CLI, 'serve', '--port', String(PORT_RO)], {
      cwd: repo, reject: false, env: { ...process.env, BATON_DAEMONS_DIR: registry },
    });
    children.push(child);
    const deadline = Date.now() + DAEMON_START_MS;
    for (;;) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT_RO}/api/meta`, { signal: AbortSignal.timeout(1000) })).ok) break;
      } catch { /* not yet */ }
      if (Date.now() > deadline) throw new Error(`daemon on ${PORT_RO} did not start`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }, DAEMON_START_MS + 30_000);

  afterAll(async () => {
    for (const c of children) c.kill('SIGTERM');
    await Promise.allSettled(children.map((c) => c));
    if (base) await rm(base, { recursive: true, force: true });
  });

  it('serves one row per worktree on a read-only daemon', async () => {
    const { status, body } = await api(PORT_RO, '/api/worktrees');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.map((r: any) => r.slug)).toEqual(['api']);
    // The main checkout is not a task worktree and must not be listed as one.
    expect(body.some((r: any) => r.worktreePath === repo)).toBe(false);
  });

  it('carries every field the flow canvas needs, with health distinct from state', async () => {
    const { body } = await api(PORT_RO, '/api/worktrees');
    const row = body[0];
    for (const key of [
      'slug', 'branch', 'worktreePath', 'state', 'health', 'quietForMs', 'lastActivityAt',
      'unprotected', 'filesChanged', 'ahead', 'behind', 'repoState', 'agent', 'claimedBy',
      'holderRunning', 'planId', 'phase', 'dependsOn', 'orphan', 'wipRef',
    ]) {
      expect(row, `missing field ${key}`).toHaveProperty(key);
    }
    expect(row.state).toBe('active');
    expect(row.branch).toBe('baton/api');
    expect(row.planId).toBe('auth');
    expect(row.phase).toBe(2);
    expect(row.dependsOn).toEqual(['schema']);
    expect(row.orphan).toBe(false);
  });

  it('says the holder is not running, and calls the dirty worktree abandoned', async () => {
    const { body } = await api(PORT_RO, '/api/worktrees');
    const row = body[0];
    expect(row.claimedBy).toBe('claude');
    expect(row.holderRunning).toBe(false);
    expect(row.health).toBe('abandoned');
    expect(row.unprotected.atRisk).toBe(true);
    expect(row.filesChanged).toBeGreaterThan(0);
  });
});
