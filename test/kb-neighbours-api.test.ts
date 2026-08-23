// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The neighbours query over HTTP.
 *
 * `/api/kb/graph` streams the whole graph — 144 MB for the Orcabaton repo,
 * against an 8 MB client cap — so the Orca knowledge panel refuses it and
 * prints the size. This is the route that lets the panel browse instead, and
 * the thing worth testing over the wire is that each refusal keeps its own
 * status: a graph that was never built, a symbol that does not exist and a
 * query that named nothing are three different problems with three fixes.
 *
 * Gated on dist/cli.js being built (run `npm run build` first).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa, type ResultPromise } from 'execa';

const DIST_CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const hasDist = existsSync(DIST_CLI);
const PORT = 7443;

const NODES = [
  { id: 'a', label: 'alpha()', file_type: 'code', source_file: 'src/a.ts', source_location: 'L1' },
  { id: 'b', label: 'beta()', file_type: 'code', source_file: 'src/b.ts', source_location: 'L9' },
  { id: 'c', label: 'gamma()', file_type: 'code', source_file: 'src/b.ts', source_location: 'L20' },
];
const GRAPH = { nodes: NODES, links: [{ source: 'a', target: 'b', relation: 'calls' }] };

async function api(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { signal: AbortSignal.timeout(20_000) });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

describe.runIf(hasDist)('GET /api/kb/neighbours', () => {
  let base = '';
  let repo = '';
  const children: ResultPromise[] = [];

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'baton-nbapi-'));
    repo = join(base, 'repo');
    await execa('git', ['init', '-q', '-b', 'main', repo]);
    await execa('git', ['config', 'user.email', 't@t.dev'], { cwd: repo });
    await execa('git', ['config', 'user.name', 't'], { cwd: repo });
    await execa('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: repo });
    await execa('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });

    await mkdir(join(repo, 'graphify-out'), { recursive: true });
    await writeFile(join(repo, 'graphify-out', 'graph.json'), JSON.stringify(GRAPH));
    await mkdir(join(repo, '.baton'), { recursive: true });
    await writeFile(join(repo, '.baton', 'kb.json'), JSON.stringify({
      root: repo,
      projects: [{ id: 'repo', name: 'repo', path: repo, graphPath: join(repo, 'graphify-out', 'graph.json') }],
      mergedGraphPath: null,
      lastBuiltAt: new Date().toISOString(),
    }));

    const child = execa('node', [DIST_CLI, 'serve', '--port', String(PORT)], {
      cwd: repo, reject: false, env: { ...process.env, BATON_DAEMONS_DIR: join(base, 'registry') },
    });
    children.push(child);
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/api/meta`, { signal: AbortSignal.timeout(1000) })).ok) break;
      } catch { /* not yet */ }
      if (Date.now() > deadline) throw new Error('daemon did not start');
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 90_000);

  afterAll(async () => {
    for (const c of children) c.kill('SIGTERM');
    await Promise.allSettled(children.map((c) => c.catch(() => undefined)));
    await rm(base, { recursive: true, force: true });
  });

  it('answers a symbol with its neighbours and their direction', async () => {
    const { status, body } = await api('/api/kb/neighbours?node=a');
    expect(status).toBe(200);
    expect(body.kind).toBe('node');
    expect(body.node.label).toBe('alpha()');
    expect(body.neighbours).toEqual([
      { id: 'b', label: 'beta()', fileType: 'code', sourceFile: 'src/b.ts', sourceLocation: 'L9', relation: 'calls', direction: 'out' },
    ]);
    expect(body.withheld).toBe(0);
  });

  it('lists the symbols in a file', async () => {
    const { status, body } = await api('/api/kb/neighbours?file=src/b.ts');
    expect(status).toBe(200);
    expect(body.kind).toBe('file');
    expect(body.nodes.map((n: { id: string }) => n.id)).toEqual(['b', 'c']);
  });

  it('reports the cap it applied rather than truncating quietly', async () => {
    const { body } = await api('/api/kb/neighbours?file=src/b.ts&limit=1');
    expect(body.nodes).toHaveLength(1);
    expect(body.total).toBe(2);
    expect(body.withheld).toBe(1);
  });

  it('404s an unknown symbol, and says so in the body', async () => {
    const { status, body } = await api('/api/kb/neighbours?node=nope');
    expect(status).toBe(404);
    expect(body.code).toBe('unknown-node');
  });

  it('400s a query that selects nothing', async () => {
    const { status, body } = await api('/api/kb/neighbours');
    expect(status).toBe(400);
    expect(body.code).toBe('needs-selector');
  });

  it('404s a project it does not have', async () => {
    const { status } = await api('/api/kb/neighbours?node=a&project=ghost');
    expect(status).toBe(404);
  });

  // The route is a read. A read-only daemon must serve it.
  it('is served by a daemon started without --write', async () => {
    expect((await api('/api/kb/neighbours?node=a')).status).toBe(200);
  });
});
