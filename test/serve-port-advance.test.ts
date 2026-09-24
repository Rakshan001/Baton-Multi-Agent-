// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Default `baton serve` must move off a busy port when the holder is a
 * different project (or not a Baton daemon). Explicit `--port` and a
 * same-root duplicate still fail — those are "I asked for this number"
 * and "this repo is already served".
 *
 * The listen branch lives in `serve()`, so the non-explicit cases call
 * that function with `portExplicit: false` and a chosen port rather than
 * competing for the machine-global 7077.
 */
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
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

async function makeRepo(base: string, name: string): Promise<string> {
  const dir = join(base, name);
  await execa('git', ['init', '-q', '-b', 'main', dir]);
  await execa('git', ['config', 'user.email', 't@t.dev'], { cwd: dir });
  await execa('git', ['config', 'user.name', 't'], { cwd: dir });
  await execa('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: dir });
  await execa('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  return dir;
}

async function occupy(port: number): Promise<{ close: () => Promise<void> }> {
  const s = createServer();
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => resolve());
  });
  return {
    close: () => new Promise<void>((res) => s.close(() => res())),
  };
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

/** Collect stderr/stdout until the child exits or `until` matches. */
function collect(child: ResultPromise): { stdout: string; stderr: string } {
  const buf = { stdout: '', stderr: '' };
  child.stdout?.on('data', (d: Buffer) => { buf.stdout += d.toString(); });
  child.stderr?.on('data', (d: Buffer) => { buf.stderr += d.toString(); });
  return buf;
}

function spawnCliServe(cwd: string, args: string[], env: NodeJS.ProcessEnv): ResultPromise {
  return execa('node', [DIST_CLI, 'serve', ...args], {
    cwd, reject: false, env: { ...process.env, ...env },
  });
}

function spawnServeCall(
  cwd: string,
  port: number,
  portExplicit: boolean,
  env: NodeJS.ProcessEnv,
): ResultPromise {
  const href = pathToFileURL(DIST_SERVER).href;
  const src = `import { serve } from ${JSON.stringify(href)}; await serve({ port: ${port}, portExplicit: ${portExplicit} });`;
  return execa(process.execPath, ['--input-type=module', '-e', src], {
    cwd, reject: false, env: { ...process.env, ...env },
  });
}

describe.runIf(hasDist)('serve port clash', () => {
  const children: ResultPromise[] = [];
  let base = '';
  const holders: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const c of children) c.kill('SIGTERM');
    await Promise.all(children.map((c) => c.catch(() => undefined)));
    children.length = 0;
    for (const h of holders) await h.close().catch(() => undefined);
    holders.length = 0;
    if (base) await rm(base, { recursive: true, force: true });
    base = '';
  }, 30_000);

  it('explicit --port still exits when the port is taken', async () => {
    base = await mkdtemp(join(tmpdir(), 'baton-port-explicit-'));
    const cwd = await makeRepo(base, 'repo');
    const port = await freePort();
    holders.push(await occupy(port));
    const child = spawnCliServe(cwd, ['--port', String(port)], {
      BATON_DAEMONS_DIR: join(base, 'registry'),
    });
    children.push(child);
    const buf = collect(child);
    const r = await child;
    expect(r.exitCode).toBe(1);
    expect(buf.stderr + r.stderr).toMatch(/already in use|already serving/);
  }, 90_000);

  it('default (non-explicit) port advances when the holder is unknown', async () => {
    base = await mkdtemp(join(tmpdir(), 'baton-port-unknown-'));
    const cwd = await makeRepo(base, 'repo');
    const registry = join(base, 'registry');
    const port = await freePort();
    holders.push(await occupy(port));
    const child = spawnServeCall(cwd, port, false, { BATON_DAEMONS_DIR: registry });
    children.push(child);
    const buf = collect(child);
    const deadline = Date.now() + DAEMON_START_MS;
    let next = 0;
    while (Date.now() < deadline) {
      const text = buf.stderr + buf.stdout;
      const m = text.match(/moving to (\d+)/);
      if (m) { next = Number(m[1]); break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(next).toBeGreaterThan(port);
    await waitUp(next);
    expect(buf.stderr).toMatch(/graphify MCP URLs embed the port/);
    expect(buf.stdout).toMatch(new RegExp(`http://localhost:${next}`));
  }, 90_000);

  it('default port advances when a different-root live daemon holds it', async () => {
    base = await mkdtemp(join(tmpdir(), 'baton-port-other-'));
    const registry = join(base, 'registry');
    const env = { BATON_DAEMONS_DIR: registry };
    const a = await makeRepo(base, 'repo-a');
    const b = await makeRepo(base, 'repo-b');
    const port = await freePort();
    const holder = spawnCliServe(a, ['--port', String(port)], env);
    children.push(holder);
    collect(holder);
    await waitUp(port);

    const child = spawnServeCall(b, port, false, env);
    children.push(child);
    const buf = collect(child);
    const deadline = Date.now() + DAEMON_START_MS;
    let next = 0;
    while (Date.now() < deadline) {
      const text = buf.stderr + buf.stdout;
      const m = text.match(/moving to (\d+)/);
      if (m) { next = Number(m[1]); break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(next).toBeGreaterThan(port);
    await waitUp(next);
    expect(buf.stdout).toMatch(new RegExp(`http://localhost:${next}`));
    const meta = await fetch(`http://127.0.0.1:${next}/api/meta`, { signal: AbortSignal.timeout(4000) });
    expect(meta.ok).toBe(true);
    const body = await meta.json() as { repo: string };
    expect(await realpath(body.repo)).toBe(await realpath(b));
  }, 90_000);

  it('same-root live holder still refuses even without --port', async () => {
    base = await mkdtemp(join(tmpdir(), 'baton-port-same-'));
    const registry = join(base, 'registry');
    const env = { BATON_DAEMONS_DIR: registry };
    const cwd = await makeRepo(base, 'repo');
    const port = await freePort();
    const holder = spawnCliServe(cwd, ['--port', String(port)], env);
    children.push(holder);
    collect(holder);
    await waitUp(port);

    const child = spawnServeCall(cwd, port, false, env);
    children.push(child);
    const buf = collect(child);
    const r = await child;
    expect(r.exitCode).toBe(1);
    expect(buf.stderr + r.stderr).toMatch(/already serving/);
    expect(buf.stderr + r.stderr).not.toMatch(/moving to/);
  }, 90_000);
});
