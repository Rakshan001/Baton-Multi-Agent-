/**
 * What a MEMBER can do, end to end, over a real daemon.
 *
 * Every rule in `src/access.ts` had unit tests and no daemon behind them: no
 * suite ever ran a request that was not loopback, because doing so needs a
 * network bind (and `--host 0.0.0.0` in a test suite is its own bad idea). So
 * the gates were pinned as pure functions while the WIRING — does this route
 * actually consult them, and in what order — was pinned nowhere. That gap hid
 * the two defects this file now guards: `POST /api/tasks` never called the
 * read-only gate at all, and `/api/storage/purge` never called the owner gate.
 *
 * `--behind-proxy` is the lever that closes it without a network. It exists
 * because a tunnel dials the daemon over loopback, so under it a loopback
 * request is treated exactly as a remote member's is — which is precisely the
 * request no other suite can make.
 *
 * Gated on dist/cli.js being built (run `npm run build` first).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa, type ResultPromise } from 'execa';

const DIST_CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const hasDist = existsSync(DIST_CLI);
// 7415: test files run in PARALLEL, so a port shared with another suite is a
// race, not a detail — 7398 is already team-api's and member-controls'.
const PORT = 7415;
const BASE = `http://127.0.0.1:${PORT}`;

interface Json { status: number; body: any }

/** A token is printed once, on the line after the "shown ONCE" banner. */
function tokenFrom(stdout: string): string {
  const m = /baton_[A-Za-z0-9_-]{16,}/.exec(stdout);
  if (!m) throw new Error(`no token in member-add output:\n${stdout}`);
  return m[0];
}

async function api(path: string, token?: string, init?: RequestInit): Promise<Json> {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(5000),
    ...init,
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON (static assets) */ }
  return { status: res.status, body };
}

const post = (path: string, token?: string, body?: unknown): Promise<Json> =>
  api(path, token, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe.runIf(hasDist)('a member reaching the daemon through a proxy', () => {
  let dir = '';
  let child: ResultPromise | null = null;
  let ownerToken = '';
  let memberToken = '';
  let danaToken = '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'baton-proxied-'));
    await execa('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    await execa('git', ['config', 'user.email', 't@t.dev'], { cwd: dir });
    await execa('git', ['config', 'user.name', 't'], { cwd: dir });
    await execa('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });

    // First member is the owner, by construction (members.ts).
    ownerToken = tokenFrom((await execa('node', [DIST_CLI, 'member', 'add', 'Priya'], { cwd: dir })).stdout);
    memberToken = tokenFrom((await execa('node', [DIST_CLI, 'member', 'add', 'Sam'], { cwd: dir })).stdout);
    danaToken = tokenFrom((await execa('node', [DIST_CLI, 'member', 'add', 'Dana'], { cwd: dir })).stdout);

    child = execa('node', [DIST_CLI, 'serve', '--write', '--behind-proxy', '--port', String(PORT)], { cwd: dir, reject: false });
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        // /api/meta needs a token here too — reaching ANY status means it is up.
        const res = await fetch(`${BASE}/api/meta`, { signal: AbortSignal.timeout(1000) });
        if (res.status) break;
      } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error('daemon did not start');
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 40_000);

  afterAll(async () => {
    child?.kill('SIGTERM');
    await child?.catch(() => undefined);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('refuses an untokened request that would have been the owner without the flag', async () => {
    // The whole point: this exact request, on a daemon without --behind-proxy,
    // is indistinguishable from the operator and gets everything.
    const r = await api('/api/status');
    expect(r.status).toBe(401);
  });

  it('still serves static assets, so the page that asks for a token can load', async () => {
    const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(5000) });
    expect(res.status).toBe(200);
  });

  it('lets a plain member read the roster — knowing who is here is the point', async () => {
    const r = await api('/api/members', memberToken);
    expect(r.status).toBe(200);
    expect(r.body.members.map((m: any) => m.id)).toEqual(expect.arrayContaining(['priya', 'sam']));
    // ...and never hands out a token hash while doing it.
    expect(JSON.stringify(r.body)).not.toMatch(/tokenHash/);
  });

  it('tells a member they are not the owner, and the server agrees', async () => {
    const asMember = await api('/api/members', memberToken);
    expect(asMember.body.viewer).toMatchObject({ local: false, isOwner: false, memberId: 'sam' });
    const asOwner = await api('/api/members', ownerToken);
    expect(asOwner.body.viewer).toMatchObject({ local: false, isOwner: true, memberId: 'priya' });
  });

  it('refuses a member the owner controls, by the gate and not by a hidden button', async () => {
    for (const path of ['/api/members/sam/warn', '/api/members/sam/disconnect', '/api/members/sam/revoke']) {
      const r = await post(path, memberToken, { message: 'x' });
      expect(r.status, path).toBe(403);
      expect(r.body.error, path).toBe('owner only');
    }
  });

  it('refuses a member the PURGE — the endpoint that deletes everything', async () => {
    /*
     * This is the regression that had no end-to-end guard. Purge deletes
     * memory, history and reports and then reclaims git objects, and it was
     * gated on --write + a typed confirm phrase only. The phrase is not a
     * credential: GET /api/storage/purge hands it to whoever asks, so a member
     * could read it back and echo it.
     */
    const preview = await api('/api/storage/purge', memberToken);
    expect(preview.status).toBe(200);                    // reading the preview is fine
    const phrase = preview.body.confirmPhrase;
    expect(typeof phrase).toBe('string');

    const r = await post('/api/storage/purge', memberToken, { categories: ['memory'], confirm: phrase });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('owner only');
  });

  it('refuses a member a terminal and an agent launch, which are host capabilities', async () => {
    // Rule 2: an interactive shell and arbitrary process execution on the host
    // are never reachable except from this machine — no token buys them.
    const term = await post('/api/terminals', memberToken, { slug: 'x', agent: 'claude' });
    expect(term.status).toBe(403);
    expect(term.body.error).toMatch(/loopback-only/);

    const start = await post('/api/tasks/x/agent/start', memberToken, {});
    expect(start.status).toBe(403);
    expect(start.body.error).toMatch(/this machine only/);
  });

  it('refuses a member the daemon fleet — stopping a process is not a member action', async () => {
    for (const path of ['/api/shutdown', '/api/daemons/clean']) {
      const r = await post(path, memberToken);
      expect(r.status, path).toBe(403);
    }
    expect((await api('/api/daemons', memberToken)).status).toBe(403);
  });

  it('still lets the OWNER see the fleet — the flag must not lock the operator out', async () => {
    /*
     * The fleet routes gate on `access.local`, and --behind-proxy makes that
     * false for everyone by construction — so turning the flag on made
     * graceful shutdown unreachable by ANY caller, including the person at the
     * keyboard, and 403'd the dashboard's Daemons card. The flag's own premise
     * is that the owner token is the only remaining proof of operator
     * identity, so under it the owner stands in for loopback.
     *
     * `/api/shutdown` is deliberately not exercised here: it would work, and
     * it would end the daemon these tests are talking to.
     */
    const r = await api('/api/daemons', ownerToken);
    expect(r.status).toBe(200);
    expect(r.body.daemons.some((d: any) => d.self)).toBe(true);
    expect((await post('/api/daemons/clean', ownerToken)).status).toBe(200);
  });

  it('shows each member their own warnings and nobody else\'s', async () => {
    /*
     * A warning is owner↔member correspondence — "you're touching billing/
     * again, stop" names one person. It rode the roster to EVERY member, and
     * the `member.warned` SSE frame carried the text to every subscriber.
     *
     * The negative half needs a THIRD member: asserting that Sam cannot read
     * Priya's warnings proves nothing while Priya has none, which is how the
     * first draft of this test passed against the unfixed code.
     */
    // Each has to be present before a warning can be delivered to them.
    await post('/api/presence/heartbeat', memberToken, { device: 'sam-box', sessions: 1, claims: [] });
    await post('/api/presence/heartbeat', danaToken, { device: 'dana-box', sessions: 1, claims: [] });
    expect((await post('/api/members/sam/warn', ownerToken, { message: 'stay out of billing/' })).status).toBe(200);
    expect((await post('/api/members/dana/warn', ownerToken, { message: 'your contract ended friday' })).status).toBe(200);

    // The owner sees all of it — that is the moderation tool working.
    const asOwner = await api('/api/members', ownerToken);
    const byId = (b: any, id: string) => b.members.find((m: any) => m.id === id);
    expect(byId(asOwner.body, 'sam').warnings.map((w: any) => w.message)).toContain('stay out of billing/');
    expect(byId(asOwner.body, 'dana').warnings.map((w: any) => w.message)).toContain('your contract ended friday');

    const asSam = await api('/api/members', memberToken);
    // His own, which he must be able to read or the warning does not arrive.
    expect(byId(asSam.body, 'sam').warnings.map((w: any) => w.message)).toContain('stay out of billing/');
    // Dana's, which is none of his business — he still sees her ROW.
    expect(byId(asSam.body, 'dana')).toBeTruthy();
    expect(byId(asSam.body, 'dana').warnings).toEqual([]);
    expect(JSON.stringify(asSam.body)).not.toContain('your contract ended friday');
  });

  it('lets a member create a task — collaboration is the point, and --write is on', async () => {
    // The counterweight to the refusals above: the gates must not have turned
    // a collaboration hub into a read-only one.
    const r = await post('/api/tasks', memberToken, { task: 'a task from a proxied member' });
    expect(r.status).toBe(201);
    expect(r.body.slug).toBeTruthy();
  });
});
