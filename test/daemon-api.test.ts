/**
 * The fleet over HTTP, end to end against real daemons (phase 2 of the
 * daemon-fleet plan).
 *
 * Two daemons share one hermetic registry (BATON_DAEMONS_DIR), and daemon A is
 * asked about — and then to stop — daemon B. What is pinned here:
 *
 * - the fleet answers with a `self` marker, so a UI can tell "this dashboard"
 *   from the rest without comparing ports itself;
 * - stopping another daemon is graceful now that /api/shutdown exists, and the
 *   response SAYS which path ran;
 * - the self-port refusal: stopping the daemon you are talking to has its own
 *   route, so a mixed-up port cannot read as a routine stop;
 * - a stale record is cleaned, never signalled;
 * - a read-only daemon refuses the whole control surface.
 *
 * The `access.local` refusal (a --host member must not see the fleet) is a
 * one-line guard on each route; its behavior over a real network interface is
 * exercised by the member-controls suite's guard pattern, not re-built here.
 *
 * Gated on dist/cli.js being built (run `npm run build` first).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa, type ResultPromise } from 'execa';
import { type DaemonRecord, pidAlive, recordPath, writeDaemonRecord } from '../src/daemons.js';

const DIST_CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const hasDist = existsSync(DIST_CLI);
const PORT_A = 7411;
const PORT_B = 7412;
const PORT_RO = 7413;

async function api(port: number, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(8000), ...init });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

async function makeRepo(base: string, name: string): Promise<string> {
  const dir = join(base, name);
  await execa('git', ['init', '-q', '-b', 'main', dir]);
  await execa('git', ['config', 'user.email', 't@t.dev'], { cwd: dir });
  await execa('git', ['config', 'user.name', 't'], { cwd: dir });
  // A machine-global core.hooksPath (e.g. a post-commit hook that backgrounds a
  // rebuild) must not fire in a throwaway repo: its child inherits git's pipes
  // and execa then waits on a stream that never closes.
  await execa('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: dir });
  await execa('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  return dir;
}

async function waitUp(port: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/meta`, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`daemon on ${port} did not start`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe.runIf(hasDist)('fleet endpoints', () => {
  let base = '';
  let registry = '';
  let repoB = '';
  const children: ResultPromise[] = [];

  /** A crash leftover: a record whose pid is beyond pid_max, so it is dead by
   *  construction and can only ever verify as stale. */
  const corpse = (port: number, root: string): DaemonRecord => ({
    pid: 2 ** 24, port, root, startedAt: new Date().toISOString(),
    version: '0.0.1', writeEnabled: true, host: false,
  });

  // Returns void ON PURPOSE. An execa child is a thenable, and an async
  // function that returns one hands it to the caller's `await` — which then
  // waits for the daemon to EXIT, not to start. (Cost: a 90s hook timeout and
  // an evening.) The children array is the only handle anyone needs.
  const spawnDaemon = async (cwd: string, port: number, write: boolean): Promise<void> => {
    const child = execa('node', [DIST_CLI, 'serve', ...(write ? ['--write'] : []), '--port', String(port)], {
      cwd, reject: false, env: { ...process.env, BATON_DAEMONS_DIR: registry },
    });
    children.push(child);
    await waitUp(port);
  };

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'baton-fleetapi-'));
    registry = join(base, 'registry');
    // Every repo BEFORE any daemon: a running daemon watches its tree, and a
    // git hook firing under that gaze is one variable this suite is not about.
    const [a, b, ro] = await Promise.all([
      makeRepo(base, 'repo-a'), makeRepo(base, 'repo-b'), makeRepo(base, 'repo-ro'),
    ]);
    repoB = b;
    await spawnDaemon(a, PORT_A, true);
    await spawnDaemon(b, PORT_B, true);
    await spawnDaemon(ro, PORT_RO, false);
  }, 90_000);

  afterAll(async () => {
    for (const c of children) c.kill('SIGTERM');
    await Promise.all(children.map((c) => c.catch(() => undefined)));
    if (base) await rm(base, { recursive: true, force: true });
  });

  it('lists the fleet with a self marker', async () => {
    const { status, body } = await api(PORT_A, '/api/daemons');
    expect(status).toBe(200);
    const ports = body.daemons.map((d: any) => d.port).sort();
    expect(ports).toEqual([PORT_A, PORT_B, PORT_RO]);
    // `self` is A's own view — B is somebody else from where A stands.
    expect(body.daemons.find((d: any) => d.port === PORT_A).self).toBe(true);
    expect(body.daemons.find((d: any) => d.port === PORT_B).self).toBe(false);
    expect(body.daemons.every((d: any) => d.status === 'live')).toBe(true);
    // /api/meta names the answering process — the identity verifyDaemon needs
    // to tell "that daemon" from "a new daemon in the same repo on its port".
    expect((await api(PORT_A, '/api/meta')).body.pid).toBe(body.daemons.find((d: any) => d.self).pid);
  });

  it('refuses to stop the daemon you are talking to via the proxy route', async () => {
    const { status, body } = await api(PORT_A, `/api/daemons/${PORT_A}/stop`, { method: 'POST' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/this daemon/);
  });

  it('404s a port the registry has never heard of', async () => {
    expect((await api(PORT_A, '/api/daemons/7999/stop', { method: 'POST' })).status).toBe(404);
  });

  it('a read-only daemon refuses shutdown and the stop proxy', async () => {
    expect((await api(PORT_RO, '/api/shutdown', { method: 'POST' })).status).toBe(403);
    expect((await api(PORT_RO, `/api/daemons/${PORT_B}/stop`, { method: 'POST' })).status).toBe(403);
    // ...but may still LOOK: listing is a read.
    expect((await api(PORT_RO, '/api/daemons')).status).toBe(200);
  });

  it('a pid-targeted stop cleans ONLY the corpse sharing a live daemon\'s port', async () => {
    // The regression this pins: a crash leftover and a live daemon both claim
    // PORT_B. Cleaning the corpse must not read as (or worse, become)
    // stopping the daemon; the pid in the body says which record is meant.
    await writeDaemonRecord(corpse(PORT_B, repoB), registry);
    const { status, body } = await api(PORT_A, `/api/daemons/${PORT_B}/stop`, {
      method: 'POST', body: JSON.stringify({ pid: 2 ** 24 }),
    });
    expect(status).toBe(200);
    expect(body.outcome).toBe('cleaned');
    // B never noticed.
    expect((await api(PORT_B, '/api/meta')).status).toBe(200);
    const fleet = (await api(PORT_A, '/api/daemons')).body.daemons.filter((d: any) => d.port === PORT_B);
    expect(fleet.length).toBe(1);
    expect(fleet[0].status).toBe('live');
  });

  it('a pid-targeted clean of a leftover on the daemon\'s OWN port is not mistaken for self-shutdown', async () => {
    // Restart-after-crash: a corpse claims the very port this daemon now
    // holds. Without the pid the route must still refuse (that is
    // /api/shutdown's job); with the corpse's pid it is just a cleanup.
    await writeDaemonRecord(corpse(PORT_A, repoB), registry);
    expect((await api(PORT_A, `/api/daemons/${PORT_A}/stop`, { method: 'POST' })).status).toBe(400);
    const { status, body } = await api(PORT_A, `/api/daemons/${PORT_A}/stop`, {
      method: 'POST', body: JSON.stringify({ pid: 2 ** 24 }),
    });
    expect(status).toBe(200);
    expect(body.outcome).toBe('cleaned');
    // A is alive, and its own record still stands.
    const self = (await api(PORT_A, '/api/daemons')).body.daemons.filter((d: any) => d.port === PORT_A);
    expect(self.length).toBe(1);
    expect(self[0].self).toBe(true);
  });

  it('a forged record naming this daemon\'s own pid is unmasked by the pid check and swept — no daemon touched', async () => {
    // Daemons only ever write their own pid, so this record exists by hand:
    // A's pid on B's port, with B's root exactly as B reports it (realpath'd
    // on macOS, where tmpdir is a symlink). Before /api/meta carried `pid`,
    // this forgery verified LIVE (pid alive + root match) and only a 409 in
    // the route kept it from being acted on. Now B answers with B's own pid,
    // the record's claim fails identity verification, and the false record is
    // deleted as the corpse it is — a file removal, never a signal. (The 409
    // stays in the route as the guard for legacy daemons whose meta has no
    // pid, where such a record still verifies live.)
    const aPid = (await api(PORT_A, '/api/daemons')).body.daemons.find((d: any) => d.self).pid;
    const bRoot = (await api(PORT_B, '/api/meta')).body.repo;
    await writeDaemonRecord({ ...corpse(PORT_B, bRoot), pid: aPid }, registry);
    try {
      const { status, body } = await api(PORT_A, `/api/daemons/${PORT_B}/stop`, {
        method: 'POST', body: JSON.stringify({ pid: aPid }),
      });
      expect(status).toBe(200);
      expect(body.outcome).toBe('cleaned');
      // Neither daemon noticed: B still answers, and A (whose pid the forgery
      // named) is obviously still here to be asked.
      expect((await api(PORT_B, '/api/meta')).status).toBe(200);
      expect((await api(PORT_A, '/api/daemons')).body.daemons.filter((d: any) => d.port === PORT_B).length).toBe(1);
    } finally {
      // force: a failed assertion above must surface, not an ENOENT from here.
      await rm(recordPath(aPid, PORT_B, registry), { force: true });
    }
  });

  it('a garbage body is refused, not guessed at', async () => {
    expect((await api(PORT_A, `/api/daemons/${PORT_B}/stop`, { method: 'POST', body: '{ not json' })).status).toBe(400);
    expect((await api(PORT_A, `/api/daemons/${PORT_B}/stop`, { method: 'POST', body: JSON.stringify({ pid: -4 }) })).status).toBe(400);
  });

  it('expect:"stale" acts only on what the caller\'s screen showed — never a surprise stop', async () => {
    // A Clean-up click whose row flipped live since the last poll (probe
    // timeout flap, or the daemon came back): the dialog promised a file
    // deletion, so stopping a healthy daemon here is a broken promise.
    const bPid = (await api(PORT_A, '/api/daemons')).body.daemons
      .find((d: any) => d.port === PORT_B && d.status === 'live').pid;
    const refused = await api(PORT_A, `/api/daemons/${PORT_B}/stop`, {
      method: 'POST', body: JSON.stringify({ pid: bPid, expect: 'stale' }),
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/not a leftover/);
    expect((await api(PORT_B, '/api/meta')).status).toBe(200); // B untouched

    // A genuine corpse under expect:"stale" is exactly the promised cleanup.
    await writeDaemonRecord(corpse(PORT_B, repoB), registry);
    const cleaned = await api(PORT_A, `/api/daemons/${PORT_B}/stop`, {
      method: 'POST', body: JSON.stringify({ pid: 2 ** 24, expect: 'stale' }),
    });
    expect(cleaned.status).toBe(200);
    expect(cleaned.body.outcome).toBe('cleaned');

    // A nonsense expectation is refused, not guessed at.
    expect((await api(PORT_A, `/api/daemons/${PORT_B}/stop`, {
      method: 'POST', body: JSON.stringify({ expect: 'maybe' }),
    })).status).toBe(400);
  });

  it('daemon A stops daemon B gracefully, and says so — corpse on the same port notwithstanding', async () => {
    // An un-narrowed stop with BOTH a live daemon and a stale record on the
    // port must pick the living one — record-file sort order decided this
    // before the fix, and could silently "clean" while B kept running.
    await writeDaemonRecord(corpse(PORT_B, repoB), registry);
    const bPid = (await api(PORT_A, '/api/daemons')).body.daemons
      .find((d: any) => d.port === PORT_B && d.status === 'live').pid;
    const { status, body } = await api(PORT_A, `/api/daemons/${PORT_B}/stop`, { method: 'POST' });
    expect(status).toBe(200);
    expect(body.outcome).toBe('graceful');
    expect(body.root).toMatch(/repo-b/);
    // B is genuinely gone — process dead, record removed.
    const deadline = Date.now() + 5000;
    while (pidAlive(bPid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(pidAlive(bPid)).toBe(false);
    // The corpse is all that is left on PORT_B; a second un-narrowed stop now
    // matches only stale records and cleans them all.
    const again = await api(PORT_A, `/api/daemons/${PORT_B}/stop`, { method: 'POST' });
    expect(again.status).toBe(200);
    expect(again.body.outcome).toBe('cleaned');
    const after = await api(PORT_A, '/api/daemons');
    expect(after.body.daemons.map((d: any) => d.port).sort()).toEqual([PORT_A, PORT_RO]);
  });

  it('POST /api/shutdown answers 200 BEFORE dying, then dies', async () => {
    // The read-only daemon can't be shut down over HTTP, so sacrifice A —
    // this is the last test that needs it.
    const aPid = (await api(PORT_A, '/api/daemons')).body.daemons.find((d: any) => d.self).pid;
    const { status, body } = await api(PORT_A, '/api/shutdown', { method: 'POST' });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    const deadline = Date.now() + 5000;
    while (pidAlive(aPid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(pidAlive(aPid)).toBe(false);
    // Its record went with it — the survivor's fleet no longer lists A.
    const { body: fleet } = await api(PORT_RO, '/api/daemons');
    expect(fleet.daemons.map((d: any) => d.port)).toEqual([PORT_RO]);
  });
});
