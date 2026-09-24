// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The graphify MCP URLs `baton kb mcp` / `kb init` / `setup` write must name the
 * port the daemon for THIS repo actually answers on. They used to hard-code
 * 7077, so the second project on a machine (whose serve moved to 7078) got
 * wired to the first project's daemon.
 *
 * Hermetic: a throwaway registry (BATON_DAEMONS_DIR), HOME and repo, and a
 * stand-in daemon that answers /api/meta for the temp repo. BATON_ROOT is
 * cleared so a run inside a Baton-spawned terminal cannot point at a real repo.
 */
import { createServer, type Server } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execa } from 'execa';
import { kbMcpCmd, mcpPortFor } from '../src/commands/kb.js';
import { saveKb } from '../src/kb/state.js';
import { writeDaemonRecord } from '../src/daemons.js';

async function fakeDaemon(repo: string): Promise<{ port: number; close: () => Promise<void> }> {
  const srv: Server = createServer((req, res) => {
    if (req.url === '/api/meta') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ repo, version: 'test', pid: process.pid }));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  return { port, close: () => new Promise((r) => srv.close(() => r())) };
}

describe('MCP URLs embed the live daemon port', () => {
  let base = '';
  let repo = '';
  let daemon: { port: number; close: () => Promise<void> } | null = null;
  const cwd0 = process.cwd();

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'baton-kb-port-')));
    vi.stubEnv('BATON_DAEMONS_DIR', join(base, 'registry'));
    vi.stubEnv('HOME', join(base, 'home'));
    vi.stubEnv('BATON_ROOT', '');
    repo = join(base, 'repo');
    await execa('git', ['init', '-q', '-b', 'main', repo]);
    await execa('git', ['config', 'user.email', 't@t.dev'], { cwd: repo });
    await execa('git', ['config', 'user.name', 't'], { cwd: repo });
    await execa('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: repo });
    await execa('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
    await saveKb(repo, {
      root: repo,
      projects: [{ id: 'repo', name: 'repo', path: repo, graphPath: join(repo, 'graph.json') }],
      mergedGraphPath: null,
      lastBuiltAt: null,
      share: false,
    } as Parameters<typeof saveKb>[1]);
    daemon = await fakeDaemon(repo);
    await writeDaemonRecord({
      pid: process.pid, port: daemon.port, root: repo, startedAt: new Date().toISOString(),
      version: 'test', writeEnabled: false, host: false,
    });
  });

  afterEach(async () => {
    process.chdir(cwd0);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await daemon?.close();
    daemon = null;
    await rm(base, { recursive: true, force: true });
  });

  function captureLog(): () => string {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    return () => lines.join('\n');
  }

  it("kb mcp embeds the live daemon's port, not 7077", async () => {
    process.chdir(repo);
    const out = captureLog();
    await kbMcpCmd({});
    expect(out()).toContain(`http://127.0.0.1:${daemon!.port}/mcp/g/`);
  });

  it('--port still wins', async () => {
    process.chdir(repo);
    const out = captureLog();
    await kbMcpCmd({ port: '9123' });
    expect(out()).toContain('http://127.0.0.1:9123/mcp/g/');
    expect(out()).not.toContain(`:${daemon!.port}/`);
  });

  it('a linked worktree maps to the main repo daemon', async () => {
    const wt = join(base, 'wt');
    await execa('git', ['worktree', 'add', '-q', '-b', 'side', wt], { cwd: repo });
    expect(await mcpPortFor(wt)).toBe(daemon!.port);
  });

  it('with no daemon for the root, predicts the port serve would take', async () => {
    await daemon!.close();
    daemon = null;
    const used = new Set<number>();
    const first = await mcpPortFor(repo, undefined, used);
    expect(first).toBeGreaterThanOrEqual(7077);
    expect(used.has(first)).toBe(true);
    // A shared `used` set keeps two repos from being promised one port.
    expect(await mcpPortFor(repo, undefined, used)).not.toBe(first);
  });

  it('many repos sharing one used set each get a distinct port, past the scan cap', async () => {
    await daemon!.close();
    daemon = null;
    const used = new Set<number>();
    const ports: number[] = [];
    for (let i = 0; i < 24; i++) ports.push(await mcpPortFor(repo, undefined, used));
    expect(new Set(ports).size).toBe(24);
    for (const p of ports) expect(used.has(p)).toBe(true);
  }, 60_000);
});
