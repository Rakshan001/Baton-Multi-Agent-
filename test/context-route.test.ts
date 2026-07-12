/**
 * E2E test for GET /api/kb/context. Spawns `node dist/cli.js serve` against a
 * temp root with a .baton dir (no KB, no git — exercises the degraded path).
 * Gated on dist/cli.js being built (run `npm run build` first).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

const DIST_CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const hasDist = existsSync(DIST_CLI);

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

describe.runIf(hasDist)('GET /api/kb/context', () => {
  let child: ChildProcess | null = null;
  let dir = '';
  const port = 7300 + Math.floor(Math.random() * 500);

  afterEach(async () => {
    if (child) {
      child.kill('SIGTERM');
      await new Promise((r) => child!.once('exit', r));
      child = null;
    }
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('serves markdown, json, and 404 for unknown projects', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ctx-route-'));
    await mkdir(join(dir, '.baton'), { recursive: true });
    await writeFile(join(dir, 'README.md'), 'Route test project.\n');
    child = spawn('node', [DIST_CLI, 'serve', '-p', String(port)], { cwd: dir, stdio: 'ignore' });
    await waitForDaemon(port);

    const md = await fetch(`http://127.0.0.1:${port}/api/kb/context`);
    expect(md.status).toBe(200);
    expect(md.headers.get('content-type')).toContain('text/markdown');
    const body = await md.text();
    expect(body).toContain('— project context pack');
    expect(body).toContain('Route test project.');

    const json = await fetch(`http://127.0.0.1:${port}/api/kb/context?format=json`);
    expect(json.status).toBe(200);
    const pack = await json.json() as { markdown: string; tokens: number; fits: unknown[] };
    expect(pack.markdown).toContain('— project context pack');
    expect(pack.tokens).toBeGreaterThan(0);
    expect(pack.fits).toHaveLength(3);

    const missing = await fetch(`http://127.0.0.1:${port}/api/kb/context?project=nope`);
    expect(missing.status).toBe(404);
    const err = await missing.json() as { projects: string[] };
    expect(Array.isArray(err.projects)).toBe(true);
  }, 30_000);
});
