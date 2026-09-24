// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Phase 5 §4 (C2): `GET /api/worktrees/:id/diff` for a worktree with no task
 * concept of "base" — main checkout, external worktree.
 *
 * `/api/tasks/:slug/diff` (existing, keyed by task slug) is left exactly as
 * is; this is a second, broader route resolved through the SAME read-model
 * `/api/worktrees` serves, never a client-supplied path. The malformed-`%` id
 * case is folded into `server-route-guards.test.ts`'s existing central-guard
 * list rather than re-spinning a daemon here for one status code.
 *
 * Gated on dist/cli.js being built (run `npm run build` first).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa, type ResultPromise } from 'execa';
import { freePort } from './helpers/free-port.js';
import { DAEMON_START_MS } from './helpers/daemon-start.js';

const DIST_CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const hasDist = existsSync(DIST_CLI);

async function api(port: number, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(20_000) });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

describe.runIf(hasDist)('GET /api/worktrees/:id/diff', () => {
  let base = '';
  let root = '';
  let externalPath = '';
  let port = 0;
  let child: ResultPromise | undefined;

  beforeAll(async () => {
    base = realpathSync(await mkdtemp(join(tmpdir(), 'baton-wdiff-')));
    root = join(base, 'repo');
    await execa('git', ['init', '-q', '-b', 'main', root]);
    await execa('git', ['config', 'user.email', 't@t.dev'], { cwd: root });
    await execa('git', ['config', 'user.name', 't'], { cwd: root });
    await execa('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: root });
    // The daemon writes its own state under .baton/ as soon as it serves this
    // repo (history db, memory files) — gitignored so "clean main checkout"
    // means what the test says, not "clean except for baton's own footprint".
    await writeFile(join(root, '.gitignore'), '.baton/\n', 'utf-8');
    await writeFile(join(root, 'seed.txt'), 'seed\n', 'utf-8');
    await execa('git', ['add', '-A'], { cwd: root });
    await execa('git', ['commit', '-qm', 'init'], { cwd: root });

    // A plain `git worktree add`, dirtied by an uncommitted edit — an
    // "external" worktree, per collectWorktrees' own classification.
    externalPath = join(base, 'plain');
    await execa('git', ['worktree', 'add', '-q', '-b', 'feature', externalPath], { cwd: root });
    await writeFile(join(externalPath, 'seed.txt'), 'seed\nchanged in the external worktree\n', 'utf-8');

    port = await freePort();
    child = execa('node', [DIST_CLI, 'serve', '--port', String(port)], {
      cwd: root,
      reject: false,
      env: { ...process.env, HOME: join(base, 'home'), BATON_DAEMONS_DIR: join(base, 'registry') },
    });
    const deadline = Date.now() + DAEMON_START_MS;
    for (;;) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/meta`, { signal: AbortSignal.timeout(1000) })).ok) break;
      } catch { /* not yet */ }
      if (Date.now() > deadline) throw new Error(`daemon on ${port} did not start`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 60_000);

  afterAll(async () => {
    if (child) {
      child.kill('SIGTERM');
      await child.catch(() => undefined);
    }
    await rm(base, { recursive: true, force: true });
  });

  it('reports {files:[],truncated:false} for a clean main checkout', async () => {
    const rows = await api(port, '/api/worktrees');
    const main = rows.body.find((r: any) => r.worktreePath === root);
    expect(main, 'no main row in /api/worktrees').toBeTruthy();
    expect(main.kind).toBe('main');

    const r = await api(port, `/api/worktrees/${encodeURIComponent(main.slug)}/diff`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ files: [], truncated: false });
  });

  it('reports the uncommitted files for a dirty external worktree', async () => {
    const rows = await api(port, '/api/worktrees');
    const ext = rows.body.find((r: any) => r.worktreePath === externalPath);
    expect(ext, 'no external row in /api/worktrees').toBeTruthy();
    expect(ext.kind).toBe('external');

    const r = await api(port, `/api/worktrees/${encodeURIComponent(ext.slug)}/diff`);
    expect(r.status).toBe(200);
    expect(r.body.truncated).toBe(false);
    expect(r.body.files.map((f: any) => f.path)).toEqual(['seed.txt']);
  });

  it('404s an id no worktree carries', async () => {
    const r = await api(port, '/api/worktrees/no-such-worktree~0000000000/diff');
    expect(r.status).toBe(404);
  });
});
