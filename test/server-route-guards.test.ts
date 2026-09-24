// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Three guards that belong to the daemon rather than to any one feature, and
 * that only a real request can reach.
 *
 *   A malformed percent-escape in a path is a BAD REQUEST. Every route that
 *   names a resource decodes its own segment, and `decodeURIComponent` throws
 *   on `%E0%A4%A` — which the catch around the request handler turned into a
 *   500 carrying an internal error string. One answer, decided before routing.
 *
 *   `--write` means what it says. A read-only daemon that writes a settings
 *   file is a read-only daemon in name only, and the flag is what an operator
 *   relies on when they expose a dashboard they do not fully trust.
 *
 *   An operation that cannot apply to a resource is refused, not performed.
 *   Releasing a bundled skill consumed one of a bounded number of release
 *   slots for a skill that is never held for review in the first place.
 *
 * Two daemons, one with `--write` and one without, over a HOME of their own —
 * the skill quarantine lives in `~/.baton`, and these must not touch the real
 * one.
 *
 * Gated on dist/cli.js being built (run `npm run build` first).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa, type ResultPromise } from 'execa';
import { MAX_RELEASES, QUARANTINE_VERSION } from '../src/skills/quarantine.js';
import { freePort } from './helpers/free-port.js';
import { DAEMON_START_MS } from './helpers/daemon-start.js';

const DIST_CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const hasDist = existsSync(DIST_CLI);
// Ports come from the kernel at spawn time — see test/helpers/free-port.ts.
let PORT_RW = 0;
let PORT_RO = 0;

async function api(port: number, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(20_000), ...init });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

const post = (port: number, path: string, body: unknown) =>
  api(port, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/**
 * POST `body` as two TCP writes, split at byte `cut`.
 *
 * `fetch` will not do this — it hands the whole buffer to the kernel and the
 * split is then a matter of luck and MTU. The daemon's body reader has to
 * survive a chunk boundary landing anywhere, so the test puts one exactly
 * where it hurts rather than hoping for it.
 */
function postSplit(port: number, path: string, body: Buffer, cut: number): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const head = Buffer.from(
      `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\n`
      + `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
      'latin1',
    );
    const sock = createConnection(port, '127.0.0.1', () => {
      sock.write(Buffer.concat([head, body.subarray(0, cut)]));
      // Long enough that the daemon's socket really does deliver two 'data'
      // events; the bug only shows when the reader sees the halves separately.
      setTimeout(() => sock.write(body.subarray(cut)), 60);
    });
    const chunks: Buffer[] = [];
    sock.setTimeout(20_000, () => { sock.destroy(); reject(new Error('split POST timed out')); });
    sock.on('data', (d) => chunks.push(d));
    sock.on('error', reject);
    sock.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const status = Number(raw.slice(9, 12));
      // The reply is chunked; the JSON is one chunk, so first `{` to last `}`
      // is exactly the body without reimplementing chunked decoding here.
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      let parsed: unknown = null;
      if (start >= 0 && end > start) { try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { /* non-JSON */ } }
      resolve({ status, body: parsed });
    });
  });
}

describe.runIf(hasDist)('daemon route guards', () => {
  let base = '';
  let rw = '';
  let ro = '';
  const children: ResultPromise[] = [];

  const makeRepo = async (name: string): Promise<string> => {
    const dir = join(base, name);
    await execa('git', ['init', '-q', '-b', 'main', dir]);
    await execa('git', ['config', 'user.email', 't@t.dev'], { cwd: dir });
    await execa('git', ['config', 'user.name', 't'], { cwd: dir });
    await execa('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: dir });
    await execa('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
    return dir;
  };

  const spawnDaemon = async (cwd: string, port: number, write: boolean): Promise<void> => {
    const child = execa('node', [DIST_CLI, 'serve', ...(write ? ['--write'] : []), '--port', String(port)], {
      cwd,
      reject: false,
      // The skill quarantine and the global skill library live in ~/.baton.
      env: { ...process.env, HOME: join(base, 'home'), BATON_DAEMONS_DIR: join(base, 'registry') },
    });
    children.push(child);
    const deadline = Date.now() + DAEMON_START_MS;
    for (;;) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/meta`, { signal: AbortSignal.timeout(1000) })).ok) return;
      } catch { /* not yet */ }
      if (Date.now() > deadline) throw new Error(`daemon on ${port} did not start`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'baton-guards-'));
    [rw, ro] = await Promise.all([makeRepo('repo-rw'), makeRepo('repo-ro')]);
    PORT_RW = await freePort();
    await spawnDaemon(rw, PORT_RW, true);
    PORT_RO = await freePort();
    await spawnDaemon(ro, PORT_RO, false);
  }, 90_000);

  afterAll(async () => {
    for (const c of children) c.kill('SIGTERM');
    await Promise.allSettled(children.map((c) => c.catch(() => undefined)));
    await rm(base, { recursive: true, force: true });
  });

  describe('a malformed percent-escape', () => {
    it('is a bad request, not a server error', async () => {
      // `%E0%A4%A` is a truncated escape. Every route that names a resource
      // calls decodeURIComponent on its own segment, so this used to reach the
      // catch around the handler and answer 500 with "URI malformed".
      for (const path of [
        '/api/reports/%E0%A4%A',
        '/api/tasks/%E0%A4%A',
        '/api/skills/%E0%A4%A/file',
        '/api/pipeline/plans/%E0%A4%A',
        '/api/worktrees/%E0%A4%A/progress',
        '/api/worktrees/%/progress',
        '/api/worktrees/%zz/progress',
        '/api/worktrees/%E0%A4%A/diff',
      ]) {
        const r = await api(PORT_RW, path);
        expect(r.status, path).toBe(400);
      }
    });

    it('still serves a legitimately encoded name', async () => {
      // The guard must not reject `%20` and friends — it is about escapes that
      // cannot be decoded at all, not about escapes.
      const r = await api(PORT_RW, '/api/tasks/no%20such%20task');
      expect(r.status).toBe(404);
    });
  });

  describe('read-only means read-only', () => {
    it('refuses to write the per-machine provider setting', async () => {
      const r = await post(PORT_RO, '/api/endpoints/providers', { agent: 'claude', mode: 'gateway' });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('read-only');
      // And nothing was written: the refusal is the point, not the status code.
      expect(await stat(join(ro, '.baton', 'providers.json')).catch(() => null)).toBeNull();
    });

    it('still answers the read half of the same route', async () => {
      expect((await api(PORT_RO, '/api/endpoints/providers')).status).toBe(200);
    });

    it('writes it when the daemon may write', async () => {
      const r = await post(PORT_RW, '/api/endpoints/providers', { agent: 'claude', mode: 'gateway' });
      expect(r.status).toBe(200);
    });
  });

  describe('POST /api/skills/:id/release', () => {
    it('refuses a skill that is never held for review', async () => {
      // Bundled skills ship inside the package and skip review entirely, so a
      // release for one records nothing a human needed to say — while still
      // consuming one of MAX_RELEASES slots, behind which is a hard cliff: a
      // library at the cap silently stops recording new releases, with a 200
      // and `released: true` for every one of them.
      const catalog = await api(PORT_RW, '/api/skills');
      const bundled = catalog.body.skills.find((s: any) => s.source === 'bundled');
      expect(bundled, 'no bundled skill in the catalogue to test with').toBeTruthy();

      const r = await post(PORT_RW, `/api/skills/${encodeURIComponent(bundled.id)}/release`, {
        hash: 'a1'.repeat(32), by: 'test',
      });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('not-held');
      expect(r.body.error).toMatch(/review/i);
    });

    it('still 404s a skill that does not exist', async () => {
      const r = await post(PORT_RW, '/api/skills/no-such-skill/release', { hash: 'a1'.repeat(32) });
      expect(r.status).toBe(404);
    });
  });

  /*
   * A body that could not be read is not a setting.
   *
   * Both of these routes are a FULL REPLACEMENT of stored configuration, and
   * both used to reach for `?? {}` when the parse failed — so a truncated or
   * garbled body arrived as `{}`, which on these two routes is the definite
   * statement "turn all of this off". The daemon then wrote that over whatever
   * the operator had configured and answered 200.
   *
   * It is the null-vs-zero rule this codebase keeps re-learning: "I could not
   * understand you" is not a value, and reading it as one silently loses
   * configuration nobody asked to change.
   *
   * The ABSENT body is deliberately left alone — see the tests that pin it.
   */
  describe('an unparseable body on a route that stores configuration', () => {
    const raw = (path: string, body: string) =>
      api(PORT_RW, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });

    it('does not wipe the retention policy', async () => {
      const set = await post(PORT_RW, '/api/memory/retention', { maxAgeDays: 30, dropStale: true });
      expect(set.status).toBe(200);
      expect(set.body.policy).toMatchObject({ maxAgeDays: 30, dropStale: true });

      const r = await raw('/api/memory/retention', '{not json');
      expect(r.status).toBe(400);

      // The assertion that matters: the stored policy, not the status code.
      const still = await api(PORT_RW, '/api/memory/retention');
      expect(still.body).toMatchObject({ maxAgeDays: 30, dropStale: true });
    });

    it('does not switch off agent-assisted consolidation', async () => {
      const on = await post(PORT_RW, '/api/memory/consolidation', { enabled: true });
      expect(on.status).toBe(200);
      expect(on.body.delegate.config.enabled).toBe(true);

      const r = await raw('/api/memory/consolidation', '{"enabled": tru');
      expect(r.status).toBe(400);

      const still = await api(PORT_RW, '/api/memory/consolidation');
      expect(still.body.delegate.config.enabled).toBe(true);
    });

    it('still reads a well-formed body that means "off"', async () => {
      // The fix must not turn strictness about `enabled` into a refusal:
      // truthy-but-not-`true` is a body we understood, and it means OFF.
      const r = await post(PORT_RW, '/api/memory/consolidation', { enabled: 'yes' });
      expect(r.status).toBe(200);
      expect(r.body.delegate.config.enabled).toBe(false);
    });

    it('still treats an ABSENT body as the defaults, on both routes', async () => {
      // Not the bug, and not changed. Every POST on this daemon reads an empty
      // body as `{}` (readJsonBody), so singling these two out would make them
      // the odd pair — and on a full-replacement route `{}` is how you clear a
      // setting in the first place.
      const cons = await api(PORT_RW, '/api/memory/consolidation', { method: 'POST' });
      expect(cons.status).toBe(200);
      expect(cons.body.delegate.config.enabled).toBe(false);

      const ret = await api(PORT_RW, '/api/memory/retention', { method: 'POST' });
      expect(ret.status).toBe(200);
      expect(ret.body.policy).toMatchObject({ dropStale: false, dropAging: false });
      expect(ret.body.policy.maxAgeDays).toBeUndefined();
    });

    it('is still refused outright by a read-only daemon', async () => {
      // The write gate outranks the parse: a daemon that may not write must not
      // start answering 400 (a body opinion) where it used to answer 403.
      const r = await api(PORT_RO, '/api/memory/retention', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json',
      });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('read-only');
    });
  });

  describe('a request body split mid-character', () => {
    it('is decoded as UTF-8 across the chunk boundary, not one chunk at a time', async () => {
      // The reader used to build the body with `data += chunk`, which decodes
      // EACH chunk as UTF-8 on its own. A multi-byte character straddling the
      // boundary therefore became two runs of U+FFFD — silently, because the
      // surrounding JSON is pure ASCII and still parses. The corrupted value
      // was then written to disk: a task title here, a skill's own markdown on
      // /api/skills/upload, an MCP tool argument on the graphify proxy.
      const title = 'ship the 🚀 launcher';
      const body = Buffer.from(JSON.stringify({ task: title }), 'utf8');
      const lead = body.indexOf(0xf0);          // the emoji's 4-byte lead
      expect(lead).toBeGreaterThan(0);
      const r = await postSplit(PORT_RW, '/api/tasks', body, lead + 2);
      expect(r.status).toBe(201);
      expect(r.body.task).toBe(title);
    });
  });

  describe('POST /api/tasks/:slug/handoff', () => {
    it('404s a task that does not exist', async () => {
      // The route already had `if (!result) return 404` — but `passTask`
      // THROWS for a slug it cannot resolve rather than returning null, so
      // that line was unreachable and a typo'd slug answered 500. A caller
      // cannot tell "no such task" from "the daemon is broken" apart, and the
      // 500 carried an internal string back to a browser.
      const r = await post(PORT_RW, '/api/tasks/no-such-task-here/handoff', {});
      expect(r.status).toBe(404);
    });

    it('keeps the operator\'s disk out of a failure', async () => {
      const created = await post(PORT_RW, '/api/tasks', { task: 'handoff failure probe' });
      expect(created.status).toBe(201);
      // The brief is written INTO the worktree; without it the write fails for
      // real. That failure is honest — but its message is an ENOENT naming the
      // absolute path, and this route answers a browser and, through Orca's
      // relay, a phone. Same rule the plan routes already keep.
      await rm(created.body.worktreePath, { recursive: true, force: true });
      const r = await post(PORT_RW, `/api/tasks/${created.body.slug}/handoff`, {});
      expect(r.status).toBeGreaterThanOrEqual(400);
      const meta = await api(PORT_RW, '/api/meta');
      expect(JSON.stringify(r.body)).not.toContain(meta.body.repo);
    });
  });

  describe('POST /api/skills/:id/release when the release store is full', () => {
    it('does not report a release that was never recorded', async () => {
      // `recordRelease` stops writing at MAX_RELEASES — deliberately, and it is
      // tested as an invariant in skill-quarantine.test.ts. It returns void
      // either way, and this route answered `200 {released: true}` regardless.
      // So a human read a skill, clicked "I take responsibility", was told it
      // worked, and the skill stayed held with nothing recorded anywhere.
      const src = join(base, 'capped-skill.md');
      await writeFile(
        src,
        '---\nname: capped-skill\ndescription: An imported skill, for the release-cap test.\n---\n\nDo a thing.\n',
        'utf-8',
      );
      const imported = await post(PORT_RW, '/api/skills/import', { source: src, replace: true });
      expect(imported.status).toBe(201);

      const qpath = join(base, 'home', '.baton', 'skill-quarantine.json');
      const before = await readFile(qpath, 'utf-8').catch(() => null);
      const released: Record<string, unknown> = {};
      for (let i = 0; i < MAX_RELEASES; i++) {
        released[`filler-${i}`] = { hash: 'h', by: 'seed', at: '2026-01-01T00:00:00.000Z' };
      }
      await mkdir(dirname(qpath), { recursive: true });
      await writeFile(qpath, JSON.stringify({ version: QUARANTINE_VERSION, released }), 'utf-8');

      try {
        const q = await api(PORT_RW, '/api/skills/quarantine');
        const held = q.body.held.find((h: any) => h.id === 'capped-skill');
        expect(held, 'an imported skill should be held for review').toBeTruthy();

        const r = await post(PORT_RW, '/api/skills/capped-skill/release', { hash: held.hash, by: 'test' });
        expect(r.status).not.toBe(200);
        expect(r.body.released).not.toBe(true);

        // And the answer agrees with the store: it is still waiting on a human.
        const after = await api(PORT_RW, '/api/skills/quarantine');
        expect(after.body.held.some((h: any) => h.id === 'capped-skill')).toBe(true);
      } finally {
        if (before === null) await rm(qpath, { force: true });
        else await writeFile(qpath, before, 'utf-8');
      }
    });
  });
});
