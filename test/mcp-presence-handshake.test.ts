// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Phase 7 / I3 — `baton mcp` registers its presence row AFTER the handshake
 * (so a slow `ps` never delays `initialize`), with the client's name logged,
 * and lazily on the first tool call for a client that never sends
 * `notifications/initialized`. Runs the BUILT server (like mcp-wire-budget).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from '../src/util/exec.js';
import { liveSessions } from '../src/signals.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'dist', 'cli.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let root: string;
let child: ChildProcessWithoutNullStreams | undefined;
afterEach(async () => {
  child?.kill();
  child = undefined;
  await rm(root, { recursive: true, force: true });
});

async function start(): Promise<{ call: (id: number, method: string, params: unknown) => Promise<unknown>; send: (o: unknown) => void; pid: number }> {
  if (!existsSync(CLI)) throw new Error(`no built server at ${CLI} — run \`npm run build\` first`);
  root = await mkdtemp(path.join(tmpdir(), 'baton-handshake-'));
  await git(['init', '-q'], root);
  const env: NodeJS.ProcessEnv = { ...process.env, BATON_ROOT: root, BATON_AGENT: 'codex' };
  delete env.BATON_SLUG;
  const c = spawn(process.execPath, [CLI, 'mcp'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env });
  child = c;
  const pending = new Map<number, (m: unknown) => void>();
  let buf = '';
  c.stdout.on('data', (b: Buffer) => {
    buf += b.toString('utf8');
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      try {
        const msg = JSON.parse(line) as { id?: number };
        if (typeof msg.id === 'number') pending.get(msg.id)?.(msg);
      } catch { /* not a JSON-RPC line */ }
    }
  });
  const send = (o: unknown) => c.stdin.write(`${JSON.stringify(o)}\n`);
  const call = (id: number, method: string, params: unknown) =>
    new Promise<unknown>((resolve) => { pending.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });
  return { call, send, pid: c.pid! };
}

const init = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'phase7-test', version: '1' } };
const rowFor = async (pid: number) => {
  for (let i = 0; i < 50; i++) {
    const r = liveSessions(root).find((s) => s.slug === `sess-p${pid}`);
    if (r) return r;
    await sleep(100);
  }
  return undefined;
};

describe('MCP presence registers after the handshake', () => {
  it('no row before initialize; after initialized: agent, source and client name', async () => {
    const { call, send, pid } = await start();
    await sleep(300);
    expect(liveSessions(root).some((s) => s.slug === `sess-p${pid}`)).toBe(false);
    await call(1, 'initialize', init);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(await rowFor(pid)).toMatchObject({ agent: 'codex', agentSource: 'env', clientName: 'phase7-test' });
  }, 20_000);

  it('a client that skips notifications/initialized is registered on its first tool call', async () => {
    const { call, pid } = await start();
    await call(1, 'initialize', init);
    await call(2, 'tools/call', { name: 'list_signals', arguments: {} });
    expect(await rowFor(pid)).toMatchObject({ agent: 'codex', agentSource: 'env' });
  }, 20_000);
});
