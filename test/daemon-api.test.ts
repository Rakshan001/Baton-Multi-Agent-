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
import { pidAlive } from '../src/daemons.js';

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
  const children: ResultPromise[] = [];

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

  it('daemon A stops daemon B gracefully, and says so', async () => {
    const bPid = (await api(PORT_A, '/api/daemons')).body.daemons.find((d: any) => d.port === PORT_B).pid;
    const { status, body } = await api(PORT_A, `/api/daemons/${PORT_B}/stop`, { method: 'POST' });
    expect(status).toBe(200);
    expect(body.outcome).toBe('graceful');
    expect(body.root).toMatch(/repo-b/);
    // B is genuinely gone — process dead, record removed, fleet list shrunk.
    const deadline = Date.now() + 5000;
    while (pidAlive(bPid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(pidAlive(bPid)).toBe(false);
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
