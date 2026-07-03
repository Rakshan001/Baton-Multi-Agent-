/**
 * End-to-end integration test for the daemon's graphify proxy route.
 * Spawns `node dist/cli.js serve` against a temp hub root whose .baton/kb.json
 * points at the FAT_FOX merged graph, then:
 *   1. POSTs tools/list to /mcp/g/<token>/merged and asserts query_graph is present.
 *   2. POSTs with a wrong token and asserts 403.
 *
 * Gated on: uv installed AND dist/cli.js built AND the FAT_FOX merged graph exists.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { probeBinary } from '../src/util/exec.js';

const DIST_CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const MERGED = '/Users/rakshanshetty/Desktop/Developer/work/FAT_FOX/.baton/kb/merged-graph.json';
const hasUv = await probeBinary('uv', ['--version']);
const hasDist = existsSync(DIST_CLI);
const hasMerged = existsSync(MERGED);
const canRun = hasUv && hasDist && hasMerged;

console.log(`[graphify-proxy.test] hasUv=${hasUv} hasDist=${hasDist} hasMerged=${hasMerged} canRun=${canRun}`);

/** Poll /api/meta until the daemon is ready or timeout. */
async function waitForDaemon(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/meta`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`daemon on :${port} did not become ready within ${timeoutMs}ms`);
}

/** Kill the child and wait for it to exit. */
async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return; // already exited
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); }, 3000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

/** Find a free loopback port. */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

describe.runIf(canRun)('graphify proxy route (e2e)', () => {
  let child: ChildProcess | null = null;
  let root: string | null = null;

  afterEach(async () => {
    if (child) { await killChild(child); child = null; }
    if (root) { await rm(root, { recursive: true, force: true }); root = null; }
    // Verify no stray graphify processes remain.
    // (The daemon's pool.shutdown() kills them via SIGTERM on SIGTERM.)
  });

  it('POST /mcp/g/<token>/merged → query_graph in tools; wrong token → 403', async () => {
    const port = await freePort();
    root = await mkdtemp(join(tmpdir(), 'baton-proxy-e2e-'));
    const batonDir = join(root, '.baton');
    const kbDir = join(batonDir, 'kb');
    await mkdir(kbDir, { recursive: true });

    // Write a minimal kb.json pointing merged graph at FAT_FOX.
    const kb = {
      root,
      projects: [],
      mergedGraphPath: MERGED,
      lastBuiltAt: new Date().toISOString(),
    };
    await writeFile(join(batonDir, 'kb.json'), JSON.stringify(kb, null, 2));

    // Pre-create the token file so we know it before the daemon starts.
    // getMcpToken reads this and returns it; daemon will reuse it on the first /mcp/g/ request.
    const { getMcpToken } = await import('../src/kb/mcp-token.js');
    const token = getMcpToken(root);
    expect(token).toMatch(/^[0-9a-f]{32}$/);

    // Spawn daemon on the temp root — we must cd into it so resolveBatonRoot() finds .baton/.
    child = spawn('node', [DIST_CLI, 'serve', '--port', String(port)], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    child.stderr?.on('data', () => undefined);
    child.stdout?.on('data', () => undefined);

    await waitForDaemon(port);

    // 1. tools/list → query_graph present
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const res = await fetch(`http://127.0.0.1:${port}/mcp/g/${token}/merged`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { result?: { tools?: { name: string }[] } };
    const toolNames = json.result?.tools?.map((t) => t.name) ?? [];
    expect(toolNames).toContain('query_graph');

    // 2. Wrong token → 403
    const badToken = 'a'.repeat(32);
    const res2 = await fetch(`http://127.0.0.1:${port}/mcp/g/${badToken}/merged`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(5_000),
    });
    expect(res2.status).toBe(403);
  }, 60_000);
});
