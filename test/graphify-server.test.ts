import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { freePort, GraphifyPool } from '../src/kb/graphify-server.js';
import { probeBinary } from '../src/util/exec.js';

const MERGED = '/Users/rakshanshetty/Desktop/Developer/work/FAT_FOX/.baton/kb/merged-graph.json';
const hasUv = await probeBinary('uv', ['--version']);
const canRun = hasUv && existsSync(MERGED);
console.log(`[graphify-server.test] hasUv=${hasUv} existsMerged=${existsSync(MERGED)} canRun=${canRun}`);

let pool: GraphifyPool | null = null;
afterEach(async () => { await pool?.shutdown(); pool = null; });

describe('freePort', () => {
  it('returns a bindable loopback port', async () => {
    const p = await freePort();
    expect(p).toBeGreaterThan(1024); expect(p).toBeLessThan(65536);
  });
});

describe.runIf(canRun)('GraphifyPool', () => {
  it('lazily starts a backend and answers tools/list, then reaps on idle', async () => {
    pool = new GraphifyPool(() => MERGED, { idleMs: 50 });
    const port = await pool.ensure('merged');
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const body = await res.json() as { result?: { tools?: { name: string }[] } };
    expect(body.result?.tools?.map((t) => t.name)).toContain('query_graph');
    expect(pool.ports().length).toBe(1);
    // idle reap (idleMs=50): after a pause, lastAccess is old → reaped
    await new Promise((r) => setTimeout(r, 80));
    const reaped = await pool.reapIdle();
    expect(reaped).toContain('merged');
    expect(pool.ports().length).toBe(0);
  }, 30_000);

  it('ensure() on an already-running backend returns the same port (no respawn)', async () => {
    pool = new GraphifyPool(() => MERGED, { idleMs: 60_000 });
    const a = await pool.ensure('merged');
    const b = await pool.ensure('merged');
    expect(a).toBe(b);
    expect(pool.ports().length).toBe(1);
  }, 30_000);
});
