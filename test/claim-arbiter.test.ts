// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * §1.1 + §7.6: in team mode the HUB decides a claim, and a hub that cannot be
 * reached is a refusal.
 *
 * The bug this closes is not visible on one machine, which is why it survived
 * this long. `.baton/tasks.lock` makes claiming a compare-and-swap and settles
 * every race between agents on one laptop — and settles nothing at all between
 * two, because each holds its own lock over its own tasks.json and each
 * concludes it won. Two agents, one task, one worktree, and one of them loses
 * work.
 *
 * So the cases below are in three groups, and the middle one is the point:
 *
 *  1. solo is untouched — no host link, no network call, behaviour as it was
 *  2. a live hub arbitrates — exactly one of two members wins the same task
 *  3. an unreachable hub REFUSES rather than falling back to the local lock,
 *     which is the whole difference between "fail closed" and a comment saying
 *     it does
 *
 * Group 2 runs against a real daemon over loopback, which `decideAccess` grants
 * without a token (someone with shell access to the host has nothing left to be
 * protected from). Token handling has its own coverage in test/team-api.test.ts;
 * what is pinned here is arbitration. The token-rejection path gets a stub
 * server below, since a real daemon cannot 401 a loopback caller.
 *
 * Gated on dist/cli.js being built (run `npm run build` first).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa, type ResultPromise } from 'execa';
import { claimTask, ClaimRefused } from '../src/commands/claim.js';
import { takeCmd } from '../src/commands/take.js';
import { saveHostLink } from '../src/host-link.js';
import { loadTasks, saveTasks, type Task } from '../src/store.js';
import { git } from '../src/util/exec.js';

const DIST_CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const hasDist = existsSync(DIST_CLI);
const PORT = 7399;
const HUB = `http://127.0.0.1:${PORT}`;

const WHO = (n: string) => ({ agent: 'claude', sessionSlug: n });

/**
 * A queued row exactly as `task add` and `plan apply` write one — including
 * `worktreePath`, which is stamped at queue time even though nothing is built
 * until a claim (`isMaterialized` keys off `baseCommit`, not the path). That
 * detail is load-bearing here: on the hub the path names the OPERATOR's disk,
 * so a member that adopted the granted row verbatim would run `git worktree
 * add` into a directory on somebody else's machine. A fixture with an empty
 * path would hide that whole class of bug.
 */
function queued(root: string, slug: string, phase = 0): Task {
  return {
    slug, task: `do ${slug}`, branch: `baton/${slug}`,
    worktreePath: join(root, '.baton', 'wt', slug),
    baseBranch: 'main', baseCommit: null,
    createdAt: '2026-08-01T00:00:00.000Z', phase, state: 'queued',
  } as Task;
}

/** A git repo with one commit and a `.baton/` holding `tasks(root)`. */
async function repoWith(prefix: string, tasks: (root: string) => Task[]): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), prefix)));
  await git(['init', '-q', '-b', 'main'], dir);
  await git(['config', 'user.email', 't@t.dev'], dir);
  await git(['config', 'user.name', 't'], dir);
  await writeFile(join(dir, '.gitignore'), '.baton/\n', 'utf-8');
  await git(['add', '.'], dir);
  await git(['commit', '-qm', 'init'], dir);
  await mkdir(join(dir, '.baton'), { recursive: true });
  await saveTasks(dir, tasks(dir));
  return dir;
}

/** What `claimTask` did, as a refusal code or a granted task. */
async function attempt(root: string, slug: string, who: ReturnType<typeof WHO>, opts = {}) {
  try {
    const r = await claimTask(root, slug, who, opts);
    return { ok: true as const, task: r.task, materialized: r.materialized };
  } catch (e) {
    if (e instanceof ClaimRefused) return { ok: false as const, code: e.code, message: e.message };
    throw e;
  }
}

describe('solo — no host link, no arbiter, nothing changed', () => {
  let root = '';
  beforeEach(async () => { root = await repoWith('baton-solo-', (d) => [queued(d, 'alpha')]); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('claims locally and builds the worktree', async () => {
    const r = await attempt(root, 'alpha', WHO('s1'));
    expect(r.ok).toBe(true);
    expect(r.ok && r.materialized).toBe(true);
    expect((await loadTasks(root))[0]!.state).toBe('active');
  });

  it('still refuses a task that is already held', async () => {
    await attempt(root, 'alpha', WHO('s1'));
    const second = await attempt(root, 'alpha', WHO('s2'));
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.code).toBe('held');
  });
});

describe('team — the hub is the single writer', () => {
  let hub = '';
  let child: ResultPromise | null = null;
  const members: string[] = [];

  async function member(): Promise<string> {
    // No tasks of its own. A member's rows arrive WITH the grant — the plan is
    // applied on the hub (§7.6) and never here, so an empty tasks.json is the
    // realistic starting state, not a shortcut.
    const dir = await repoWith('baton-member-', () => []);
    await saveHostLink(dir, { url: HUB, token: 'baton_test' });
    members.push(dir);
    return dir;
  }

  beforeAll(async () => {
    hub = await repoWith('baton-hub-', (d) => [queued(d, 'alpha'), queued(d, 'beta'), queued(d, 'gamma')]);
    child = execa('node', [DIST_CLI, 'serve', '--write', '--port', String(PORT)], { cwd: hub, reject: false });
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${HUB}/api/meta`, { signal: AbortSignal.timeout(1000) })).ok) break;
      } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error('daemon did not start');
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 40_000);

  afterAll(async () => {
    child?.kill('SIGTERM');
    await child?.catch(() => undefined);
    for (const m of members) await rm(m, { recursive: true, force: true });
    if (hub) await rm(hub, { recursive: true, force: true });
  });

  it('grants a claim, and the row lands on the member with a LOCAL worktree', async () => {
    const m = await member();
    const r = await attempt(m, 'alpha', WHO('m1'));
    expect(r.ok).toBe(true);

    // The hub's row names the hub's filesystem. Adopting it verbatim would run
    // `git worktree add` at a path belonging to somebody else's machine.
    expect(r.ok && r.task.worktreePath.startsWith(m)).toBe(true);
    expect(existsSync(r.ok ? r.task.worktreePath : '')).toBe(true);

    // And the hub records the claim, which is what makes it exclusive.
    expect((await loadTasks(hub)).find((t) => t.slug === 'alpha')!.state).toBe('claimed');
  });

  it('two members, one task — exactly one wins', async () => {
    const [a, b] = [await member(), await member()];
    const results = await Promise.all([
      attempt(a, 'beta', WHO('ma')),
      attempt(b, 'beta', WHO('mb')),
    ]);
    // The assertion the whole feature exists for. With the local lock as the
    // arbiter this is 2 — both machines claim, both build a worktree.
    expect(results.filter((r) => r.ok)).toHaveLength(1);

    const loser = results.find((r) => !r.ok)!;
    // The hub's own wording reaches the person who typed the command, rather
    // than being re-worded into something vaguer on the way through.
    expect(loser.ok === false && loser.message).toMatch(/'beta' is claimed/);
    // And the loser wrote nothing: no row, no worktree, nothing to clean up.
    const loserRoot = results[0]!.ok ? b : a;
    expect(await loadTasks(loserRoot)).toEqual([]);
  });

  it('re-grants to the same session, so a paused task can be picked back up', async () => {
    const m = await member();
    const first = await attempt(m, 'alpha', WHO('m1'));
    // 'alpha' is already claimed on the hub by m1 from the first test. The hub
    // never sees activate/pause/done — those happen on the member's disk — so
    // without an idempotent branch its own record of this claim would lock the
    // holder out of the task for good.
    expect(first.ok).toBe(true);
  });

  it('`baton take <slug>` reaches the hub for a slug this machine has never seen', async () => {
    /*
     * The command, not just `claimTask`. `takeCmd` looks the slug up locally
     * first and falls through to the handoff-brief path when there is no row —
     * correct when solo (that is how every pre-pipeline `take` still works),
     * and exactly wrong in team mode, where an unknown slug is the normal state
     * of every task this machine has not started. Live-probing caught this
     * after the in-process tests above were all green: they called `claimTask`
     * directly and never touched the lookup that was swallowing the command.
     */
    const m = await member();
    const cwd = process.cwd();
    const out: string[] = [];
    const log = console.log, err = console.error;
    console.log = (...a: unknown[]) => void out.push(a.map(String).join(' '));
    console.error = (...a: unknown[]) => void out.push(a.map(String).join(' '));
    process.chdir(m);
    try {
      await takeCmd('gamma');
    } finally {
      console.log = log; console.error = err; process.chdir(cwd);
    }
    expect(out.join('\n')).not.toMatch(/No task 'gamma'/);
    expect((await loadTasks(m)).map((t) => t.slug)).toContain('gamma');
  });

  it('refuses --resume: stall detection reads a worktree on another machine', async () => {
    const m = await member();
    const r = await attempt(m, 'alpha', WHO('m9'), { resume: true });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe('resume-needs-hub');
  });

  it('refuses a task held by ANOTHER member — which only the hub knows', async () => {
    /*
     * Deliberately worded so a local fallback cannot fake it. This member's
     * tasks.json is empty, so if `claimTask` ever stopped asking the hub it
     * would answer "No task 'alpha'" — a refusal, and a passing test, for
     * entirely the wrong reason. "is claimed" is a sentence only the hub is in
     * a position to say.
     */
    const m = await member();
    const r = await attempt(m, 'alpha', WHO('other-session'));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toMatch(/'alpha' is claimed/);
    expect(r.ok === false && r.message).not.toMatch(/No task/);
  });
});

describe('team — fail closed', () => {
  let root = '';
  beforeEach(async () => {
    root = await repoWith('baton-closed-', (d) => [queued(d, 'alpha')]);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('refuses when the hub is not there, and writes NOTHING', async () => {
    // Port 1 — nothing listens, and the connection is refused immediately
    // rather than hanging, so this stays a fast test rather than a timeout one.
    await saveHostLink(root, { url: 'http://127.0.0.1:1', token: 'baton_test' });

    const r = await attempt(root, 'alpha', WHO('s1'));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe('hub-unreachable');

    /*
     * This is the assertion that separates fail-closed from a comment claiming
     * it. The tempting behaviour — "the hub is down, fall back to the local
     * lock" — passes every other test in this file and reintroduces the exact
     * double-claim the arbiter exists to prevent, at the worst possible moment:
     * a network partition is when two members are MOST likely to be reaching
     * for the same task with no way to see each other.
     */
    expect((await loadTasks(root))[0]!.state).toBe('queued');
    expect(existsSync(join(root, '.baton', 'wt', 'alpha'))).toBe(false);
  });

  it('names the hub and offers the way out', async () => {
    await saveHostLink(root, { url: 'http://127.0.0.1:1', token: 'baton_test' });
    const r = await attempt(root, 'alpha', WHO('s1'));
    // A refusal an agent cannot act on gets worked around by whatever means it
    // invents, so the message carries both the cause and the exit.
    expect(r.ok === false && r.message).toContain('http://127.0.0.1:1');
    expect(r.ok === false && r.message).toContain('baton host clear');
  });

  it('refuses on a rejected token rather than proceeding', async () => {
    const stub = await stubHub(401, { error: 'a member token is required' });
    try {
      await saveHostLink(root, { url: stub.url, token: 'baton_revoked' });
      const r = await attempt(root, 'alpha', WHO('s1'));
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.code).toBe('hub-rejected');
      expect((await loadTasks(root))[0]!.state).toBe('queued');
    } finally {
      await stub.close();
    }
  });

  it('refuses on a hub error, which is not the same as a hub saying no', async () => {
    // 500 is "the arbiter is broken", 409 is "the arbiter decided". Collapsing
    // them would let a crashing hub read as a clean refusal — or worse, invite
    // a retry loop that eventually falls through to local.
    const stub = await stubHub(500, { error: 'boom' });
    try {
      await saveHostLink(root, { url: stub.url, token: 'baton_test' });
      const r = await attempt(root, 'alpha', WHO('s1'));
      expect(r.ok === false && r.code).toBe('hub-error');
      expect((await loadTasks(root))[0]!.state).toBe('queued');
    } finally {
      await stub.close();
    }
  });
});

/** A hub that answers everything with one status — for paths a real daemon
 *  cannot produce for a loopback caller (it trusts loopback by design). */
async function stubHub(status: number, body: unknown): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
