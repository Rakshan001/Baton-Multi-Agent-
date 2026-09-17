// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The worktree write verbs (`wt-write-verbs`) — the two routes that turn the
 * read-model of `GET /api/worktrees` into something a human can act on.
 *
 * There is no API path to adopt stalled work today: `src/server.ts` imports
 * only `cancelTasks, claim, releaseClaim` from the lifecycle module, and
 * `POST /api/pipeline/claim` refuses a task that is already `active`. MCP is
 * stdio-only (`src/mcp.ts:675`), so a browser cannot reach `take_task
 * {resume:true}` either. These two routes are the missing path.
 *
 * The case worth reading twice is the REFUSAL. `takeover` refuses a task that
 * is not stalled (`src/lifecycle.ts:165-168`) and that refusal is the feature,
 * not an obstacle: two agents in one worktree is the failure it prevents. The
 * route must carry its words out to the caller verbatim and let the human read
 * them — so the test asserts on the guard's own sentence, and will fail if
 * anyone ever softens the guard to make a button feel better.
 *
 * Everything here runs against a REAL daemon, because three of the four things
 * being checked (the `--write` gate, the central anti-CSRF Origin gate, and
 * the status codes) live in the server and not in a pure function. Gated on
 * dist/cli.js being built (run `npm run build` first).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa, type ResultPromise } from 'execa';
import { freePort } from './helpers/free-port.js';
import { DAEMON_START_MS } from './helpers/daemon-start.js';
import { STALL_GRACE_MS } from '../src/pipeline.js';

const DIST_CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const hasDist = existsSync(DIST_CLI);

async function post(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  let parsed: unknown = null;
  try { parsed = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: parsed };
}

async function makeRepo(dir: string): Promise<void> {
  await execa('git', ['init', '-q', '-b', 'main', dir]);
  await execa('git', ['config', 'user.email', 't@t.dev'], { cwd: dir });
  await execa('git', ['config', 'user.name', 't'], { cwd: dir });
  // A machine-global core.hooksPath must not fire in a throwaway repo — its
  // child inherits git's pipes and execa then waits on a stream that never
  // closes. (Same hazard the daemon-api and worktree-health suites document.)
  await execa('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: dir });
  await execa('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
}

/** Liveness is `max(heartbeat, newest mtime in the worktree)` (liveness.ts:69),
 *  so a worktree created a second ago is alive however old its claim is. Aging
 *  the files is the only way to stage a genuinely stalled task. */
async function ageWorktree(file: string, ms: number): Promise<void> {
  const when = new Date(Date.now() - ms);
  await utimes(file, when, when);
}

async function waitForDaemon(port: number): Promise<void> {
  const deadline = Date.now() + DAEMON_START_MS;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/meta`, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`daemon on ${port} did not start`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function tasksOnDisk(repo: string): Promise<any[]> {
  return JSON.parse(await readFile(join(repo, '.baton', 'tasks.json'), 'utf8'));
}

describe.runIf(hasDist)('worktree write verbs', () => {
  let base = '';
  let repoW = '';
  let repoR = '';
  let portW = 0;
  let portR = 0;
  const children: ResultPromise[] = [];

  /** Two tasks per repo: one that went quiet an hour ago, one that is moving. */
  async function seed(repo: string): Promise<void> {
    await mkdir(join(repo, '.baton'), { recursive: true });
    const rows: any[] = [];
    for (const [slug, ageMs] of [['quiet-api', STALL_GRACE_MS * 2], ['busy-ui', 0]] as const) {
      const wt = join(repo, '.baton', 'wt', slug);
      await execa('git', ['worktree', 'add', '-q', '-b', `baton/${slug}`, wt, 'main'], { cwd: repo });
      const file = join(wt, 'half-done.ts');
      await writeFile(file, 'export const x = 1;\n');
      if (ageMs) await ageWorktree(file, ageMs);
      rows.push({
        slug, task: `Work on ${slug}`, branch: `baton/${slug}`, worktreePath: wt,
        baseBranch: 'main', baseCommit: 'HEAD',
        createdAt: new Date(Date.now() - STALL_GRACE_MS * 3).toISOString(),
        state: 'active',
        claimedBy: {
          agent: 'claude', sessionSlug: `s-${slug}`,
          // The claim time is a liveness FLOOR (liveness.ts:79), so the busy
          // row has to be claimed recently as well as touched recently.
          at: new Date(Date.now() - (ageMs ? STALL_GRACE_MS * 2 : 1000)).toISOString(),
        },
      });
    }
    await writeFile(join(repo, '.baton', 'tasks.json'), JSON.stringify(rows, null, 2));
  }

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'baton-wt-verbs-'));
    repoW = join(base, 'write');
    repoR = join(base, 'read');
    for (const repo of [repoW, repoR]) {
      await makeRepo(repo);
      await seed(repo);
    }
    [portW, portR] = [await freePort(), await freePort()];
    for (const [repo, port, write] of [[repoW, portW, true], [repoR, portR, false]] as const) {
      children.push(execa('node', [
        DIST_CLI, 'serve', '--port', String(port), ...(write ? ['--write'] : []),
      ], {
        cwd: repo, reject: false,
        env: { ...process.env, BATON_DAEMONS_DIR: join(base, `registry-${port}`) },
      }));
    }
    await Promise.all([waitForDaemon(portW), waitForDaemon(portR)]);
  }, DAEMON_START_MS + 60_000);

  afterAll(async () => {
    for (const c of children) c.kill('SIGTERM');
    await Promise.allSettled(children.map((c) => c));
    if (base) await rm(base, { recursive: true, force: true });
  });

  /* ── takeover ─────────────────────────────────────────────────────────── */

  it('refuses a worktree that is not stalled, in the guard\'s own words', async () => {
    const { status, body } = await post(portW, '/api/worktrees/busy-ui/takeover', { agent: 'codex' });
    // 409, not 400: the request was well-formed and the STATE said no.
    expect(status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.code).toBe('not-stalled');
    // Verbatim from src/lifecycle.ts:167. If this assertion ever has to be
    // relaxed, the guard has been weakened and the feature is gone.
    expect(body.error).toContain('Two agents in one worktree is the failure this prevents');
    // And nothing moved.
    const held = (await tasksOnDisk(repoW)).find((t) => t.slug === 'busy-ui');
    expect(held.claimedBy.agent).toBe('claude');
  });

  it('adopts a stalled worktree and records the new holder', async () => {
    const { status, body } = await post(portW, '/api/worktrees/quiet-api/takeover', { agent: 'codex' });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.task.claimedBy.agent).toBe('codex');
    expect(body.task.state).toBe('active');

    const row = (await tasksOnDisk(repoW)).find((t) => t.slug === 'quiet-api');
    expect(row.claimedBy.agent).toBe('codex');
    // The displaced agent's stretch is CLOSED, not overwritten: "who wrote
    // this" has to stay answerable afterwards (lifecycle.ts:47).
    const stretches = row.contributors ?? [];
    expect(stretches.at(-1)).toMatchObject({ agent: 'codex' });
    expect(stretches.filter((c: any) => !c.to)).toHaveLength(1);
  });

  it('answers 404 for a slug no task owns, not 409', async () => {
    const { status, body } = await post(portW, '/api/worktrees/no-such-thing/takeover', { agent: 'codex' });
    expect(status).toBe(404);
    expect(body.code).toBe('missing');
  });

  it('needs an agent to hand the work to', async () => {
    const { status } = await post(portW, '/api/worktrees/quiet-api/takeover', {});
    expect(status).toBe(400);
  });

  /* ── pause ────────────────────────────────────────────────────────────── */

  it('records stoppedReason and hands the task back', async () => {
    const { status, body } = await post(portW, '/api/worktrees/busy-ui/pause', {
      reason: 'out of context window',
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.task.state).toBe('queued');
    expect(body.task.stoppedReason).toBe('out of context window');

    const row = (await tasksOnDisk(repoW)).find((t) => t.slug === 'busy-ui');
    expect(row.state).toBe('queued');
    expect(row.stoppedReason).toBe('out of context window');
    // Destructive of nothing: the worktree and the branch survive a pause.
    expect(row.worktreePath).toBeTruthy();
    expect(row.branch).toBe('baton/busy-ui');
  });

  it('refuses a pause of a task that is not in progress, with the reason', async () => {
    // busy-ui is `queued` after the test above — there is nothing to hand back.
    const { status, body } = await post(portW, '/api/worktrees/busy-ui/pause', { reason: 'again' });
    expect(status).toBe(409);
    expect(body.code).toBe('wrong-state');
    expect(body.error).toContain('nothing to hand back');
  });

  /* ── the two gates ────────────────────────────────────────────────────── */

  it('refuses both verbs on a read-only daemon with the existing error', async () => {
    for (const path of ['/api/worktrees/quiet-api/takeover', '/api/worktrees/quiet-api/pause']) {
      const { status, body } = await post(portR, path, { agent: 'codex', reason: 'nope' });
      expect(status, path).toBe(403);
      expect(body.error, path).toBe('read-only');
      expect(body.hint, path).toBe('start: baton serve --write');
    }
    // And the read-only daemon wrote nothing.
    const row = (await tasksOnDisk(repoR)).find((t) => t.slug === 'quiet-api');
    expect(row.claimedBy.agent).toBe('claude');
    expect(row.state).toBe('active');
  });

  it('is covered by the central anti-CSRF Origin gate, with no per-endpoint check', async () => {
    for (const path of ['/api/worktrees/quiet-api/takeover', '/api/worktrees/quiet-api/pause']) {
      const { status, body } = await post(portR, path, { agent: 'codex', reason: 'nope' }, {
        Origin: 'http://evil.example',
      });
      // Refused by the gate in server.ts before the route is ever reached — the
      // routes add no Origin check of their own (see docs/decisions.md).
      expect(status, path).toBe(403);
      expect(body.error, path).toBe('cross-origin request refused');
    }
  });
});
