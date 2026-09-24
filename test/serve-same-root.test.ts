// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One root, one daemon. `serve` used to check for a same-root twin only when
 * its OWN port was taken by that twin — so a second `serve` whose requested
 * port was held by something else advanced past it and started a duplicate,
 * and `serve` from a sibling worktree resolved the worktree's empty shadow
 * store and served that instead of refusing.
 *
 * Hermetic: every daemon here runs on a temp repo with a temp registry
 * (BATON_DAEMONS_DIR) and a temp HOME.
 */
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { execa, type ResultPromise } from 'execa';
import { freePort } from './helpers/free-port.js';
import { DAEMON_START_MS } from './helpers/daemon-start.js';

const DIST_CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const DIST_SERVER = new URL('../dist/server.js', import.meta.url).pathname;
const hasDist = existsSync(DIST_CLI) && existsSync(DIST_SERVER);

const hasIpv6 = await new Promise<boolean>((res) => {
  const s = createServer();
  s.once('error', () => res(false));
  s.listen(0, '::1', () => s.close(() => res(true)));
});

async function makeRepo(base: string, name: string): Promise<string> {
  const dir = join(base, name);
  await execa('git', ['init', '-q', '-b', 'main', dir]);
  await execa('git', ['config', 'user.email', 't@t.dev'], { cwd: dir });
  await execa('git', ['config', 'user.name', 't'], { cwd: dir });
  await execa('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: dir });
  await execa('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  return dir;
}

async function occupy(port: number, host = '127.0.0.1'): Promise<{ close: () => Promise<void> }> {
  const s = createServer();
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject);
    s.listen(port, host, () => resolve());
  });
  return { close: () => new Promise<void>((res) => s.close(() => res())) };
}

async function waitUp(port: number): Promise<void> {
  const deadline = Date.now() + DAEMON_START_MS;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/meta`, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`daemon on ${port} did not start`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function collect(child: ResultPromise): { stdout: string; stderr: string } {
  const buf = { stdout: '', stderr: '' };
  child.stdout?.on('data', (d: Buffer) => { buf.stdout += d.toString(); });
  child.stderr?.on('data', (d: Buffer) => { buf.stderr += d.toString(); });
  return buf;
}

describe.runIf(hasDist)('serve: one daemon per root', () => {
  const children: ResultPromise[] = [];
  const holders: Array<{ close: () => Promise<void> }> = [];
  let base = '';
  let env: NodeJS.ProcessEnv = {};

  async function setup(label: string): Promise<string> {
    base = await realpath(await mkdtemp(join(tmpdir(), label)));
    await mkdir(join(base, 'home'));
    env = { BATON_DAEMONS_DIR: join(base, 'registry'), HOME: join(base, 'home'), BATON_ROOT: '' };
    return makeRepo(base, 'repo');
  }

  function cliServe(cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}): ResultPromise {
    const c = execa('node', [DIST_CLI, 'serve', ...args], {
      cwd, reject: false, env: { ...process.env, ...env, ...extra },
    });
    children.push(c);
    return c;
  }

  function serveCall(cwd: string, port: number, portExplicit: boolean): ResultPromise {
    const href = pathToFileURL(DIST_SERVER).href;
    const src = `import { serve } from ${JSON.stringify(href)}; await serve({ port: ${port}, portExplicit: ${portExplicit} });`;
    const c = execa(process.execPath, ['--input-type=module', '-e', src], {
      cwd, reject: false, env: { ...process.env, ...env },
    });
    children.push(c);
    return c;
  }

  afterEach(async () => {
    for (const c of children) c.kill('SIGTERM');
    await Promise.all(children.map((c) => c.catch(() => undefined)));
    children.length = 0;
    for (const h of holders) await h.close().catch(() => undefined);
    holders.length = 0;
    if (base) await rm(base, { recursive: true, force: true });
    base = '';
  }, 30_000);

  it('refuses a second daemon for one root when another process holds the requested port', async () => {
    const repo = await setup('baton-same-root-');
    const first = await freePort();
    collect(cliServe(repo, ['--port', String(first)]));
    await waitUp(first);

    const busy = await freePort();
    holders.push(await occupy(busy));
    const child = serveCall(repo, busy, false);
    const buf = collect(child);
    const r = await child;
    expect(r.exitCode).toBe(1);
    expect(buf.stderr).toMatch(new RegExp(`port ${first} is already serving`));
    expect(buf.stderr).not.toMatch(/moving to/);
  }, 90_000);

  it('refuses serve from a sibling worktree while main is served', async () => {
    const repo = await setup('baton-same-root-wt-');
    const wt = join(base, 'wt');
    await execa('git', ['worktree', 'add', '-q', '-b', 'side', wt], { cwd: repo });
    const first = await freePort();
    collect(cliServe(repo, ['--port', String(first)]));
    await waitUp(first);

    const child = cliServe(wt, ['--port', String(await freePort())]);
    const buf = collect(child);
    const r = await child;
    expect(r.exitCode).toBe(1);
    expect(buf.stderr).toMatch(/already serving/);
  }, 90_000);

  it('serves the cwd repo even when BATON_ROOT points elsewhere', async () => {
    const repo = await setup('baton-same-root-env-');
    const elsewhere = await makeRepo(base, 'elsewhere');
    const port = await freePort();
    collect(cliServe(repo, ['--port', String(port)], { BATON_ROOT: elsewhere }));
    await waitUp(port);
    const meta = await (await fetch(`http://127.0.0.1:${port}/api/meta`)).json() as { repo: string };
    expect(await realpath(meta.repo)).toBe(repo);
  }, 90_000);

  it('a non-git hub inside an outer repo is served as the hub, not the outer repo', async () => {
    const mono = await setup('baton-same-root-hub-');
    const hub = join(mono, 'hub');
    await mkdir(join(hub, '.baton'), { recursive: true });
    await makeRepo(hub, 'a');
    await makeRepo(hub, 'b');
    const port = await freePort();
    collect(cliServe(hub, ['--port', String(port)]));
    await waitUp(port);
    const meta = await (await fetch(`http://127.0.0.1:${port}/api/meta`)).json() as { repo: string };
    expect(await realpath(meta.repo)).toBe(hub);
  }, 90_000);

  // `localhost` resolves to ::1 first on macOS, so a holder on ::1 alone owns
  // the dashboard URL even though 127.0.0.1 is bindable. The default port must
  // move BEFORE the first listen, or serve lands where `kb mcp` said it would not.
  it.runIf(hasIpv6)('default port moves off a port held on ::1 only', async () => {
    const repo = await setup('baton-same-root-v6-');
    const port = await freePort();
    holders.push(await occupy(port, '::1'));
    const child = serveCall(repo, port, false);
    const buf = collect(child);
    const deadline = Date.now() + DAEMON_START_MS;
    let next = 0;
    while (Date.now() < deadline && !next) {
      const m = (buf.stderr + buf.stdout).match(/moving to (\d+)/);
      if (m) next = Number(m[1]);
      else await new Promise((r) => setTimeout(r, 100));
    }
    expect(next).toBeGreaterThan(port);
    await waitUp(next);
  }, 90_000);
});
