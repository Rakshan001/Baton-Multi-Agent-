/**
 * E2E test for POST /api/memory/repair — the dashboard trigger for the M3
 * stale-repair queue. Spawns `node dist/cli.js serve` against a temp git repo.
 * Gated on dist/cli.js being built (run `npm run build` first).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { execa } from 'execa';
import { saveMemory } from '../src/memory.js';

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

describe.runIf(hasDist)('POST /api/memory/repair', () => {
  let child: ChildProcess | null = null;
  let root = '';
  const port = 7300 + Math.floor(Math.random() * 500);

  afterEach(async () => {
    if (child) {
      child.kill('SIGTERM');
      await new Promise((r) => child!.once('exit', r));
      child = null;
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function setupRepo(): Promise<void> {
    root = await mkdtemp(join(tmpdir(), 'baton-repair-route-'));
    const g = (args: string[]) => execa('git', args, { cwd: root });
    await g(['init', '-q']);
    await g(['config', 'user.email', 't@t.t']);
    await g(['config', 'user.name', 'T']);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'server.ts'), 'export const ORIGIN_GUARD = true;\n');
    await writeFile(join(root, 'src', 'gone.ts'), 'export const DOOMED = 1;\n');
    await g(['add', '.']);
    await g(['commit', '-qm', 'init']);
  }

  it('re-anchors mechanically repairable facts and queues the rest for review', async () => {
    await setupRepo();
    const repairable = await saveMemory(root, {
      fact: 'The `ORIGIN_GUARD` constant gates every mutating endpoint in src/server.ts.',
      type: 'convention', files: ['src/server.ts'],
    });
    const doomed = await saveMemory(root, {
      fact: 'The `DOOMED` flag in src/gone.ts controls the legacy path.',
      type: 'gotcha', files: ['src/gone.ts'],
    });
    child = spawn('node', [DIST_CLI, 'serve', '-p', String(port), '--write'], { cwd: root, stdio: 'ignore' });
    await waitForDaemon(port);

    // Go stale AFTER boot so the daemon's startup repair sweep (M7) can't win
    // the race — this test exercises the on-demand endpoint.
    // Repairable: file changed but the term survived. Doomed: anchor deleted.
    await writeFile(join(root, 'src', 'server.ts'), '// hardened\nexport const ORIGIN_GUARD = true;\n');
    await unlink(join(root, 'src', 'gone.ts'));

    const r = await fetch(`http://127.0.0.1:${port}/api/memory/repair`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(200);
    const body = await r.json() as { reanchored: string[]; needsReview: string[] };
    expect(body.reanchored).toContain(repairable.id);
    expect(body.needsReview).toContain(doomed.id);

    // The re-anchored fact is served fresh again.
    const mem = await fetch(`http://127.0.0.1:${port}/api/memory`);
    const { facts } = await mem.json() as { facts: { id: string; freshness: string }[] };
    expect(facts.find((f) => f.id === repairable.id)?.freshness).not.toBe('stale');
  }, 40_000);

  it('is write-gated like every other mutating memory endpoint', async () => {
    await setupRepo();
    child = spawn('node', [DIST_CLI, 'serve', '-p', String(port)], { cwd: root, stdio: 'ignore' });
    await waitForDaemon(port);
    const r = await fetch(`http://127.0.0.1:${port}/api/memory/repair`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(403);
  }, 40_000);
});
