// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Conditional GETs on the two skill reads.
 *
 * The catalogue is the most-polled endpoint Baton has, and before the
 * metadata-first rewrite one poll shipped every bundled playbook — ~330 KB,
 * roughly 82k tokens. Summaries cut the payload; an ETag removes it entirely
 * for the common case, which is a client that already has the current
 * catalogue and only wants to know whether it is still current.
 *
 * What is pinned here, and why each matters:
 *
 * - a 304 carries ZERO bytes. Asserted on the bytes actually read off the
 *   socket, not on the status line: a body sent with a 304 is the bug this
 *   whole endpoint exists to avoid, and a status-code assertion would not see
 *   it.
 * - a tag that does not match still gets a normal 200 WITH a body. A cache
 *   that silently 304s a stale client would pin an old skill in place, and a
 *   skill is instructions an agent executes.
 * - the tag changes when the content changes. Same reason.
 * - weak comparison, `*`, and a comma-separated list, because those are the
 *   three If-None-Match forms a real client sends and each has its own way of
 *   being got wrong.
 *
 * Runs against a real daemon started WITHOUT --write: nothing here mutates.
 * Gated on dist/cli.js being built (run `npm run build` first).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa, type ResultPromise } from 'execa';
import { freePort } from './helpers/free-port.js';
import { DAEMON_START_MS } from './helpers/daemon-start.js';

const DIST_CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const hasDist = existsSync(DIST_CLI);
// Port comes from the kernel at spawn time — see test/helpers/free-port.ts.
let PORT = 0;

/** A user-owned skill, so `/file` has something it is allowed to hand back. */
const SKILL_ID = 'etag-demo';
const SKILL_V1 = `---
name: etag-demo
description: A throwaway skill that exists so this suite has a body to fetch.
---

# Etag demo

Original text.
`;
const SKILL_V2 = SKILL_V1.replace('Original text.', 'Edited text — the hash must move.');

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  /** Bytes actually received on the wire. A 304 must produce zero of them. */
  bytes: Buffer;
}

/**
 * Raw node:http rather than fetch: a 304 is exactly the case where fetch's
 * body handling hides what came over the socket, and "zero-length body" is the
 * claim under test.
 */
function raw(path: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: PORT, path, method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          bytes: Buffer.concat(chunks),
        }));
      },
    );
    req.setTimeout(20_000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

const json = (r: RawResponse): any => JSON.parse(r.bytes.toString('utf-8'));

describe.runIf(hasDist)('conditional GET on the skill routes', () => {
  let base = '';
  let repo = '';
  const children: ResultPromise[] = [];

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'baton-skillsetag-'));
    repo = join(base, 'repo');
    await execa('git', ['init', '-q', '-b', 'main', repo]);
    await execa('git', ['config', 'user.email', 't@t.dev'], { cwd: repo });
    await execa('git', ['config', 'user.name', 't'], { cwd: repo });
    await execa('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: repo });
    await execa('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });

    // A project skill: `<repo>/.baton/skills/<id>.md` loads as source
    // 'imported', which is user-owned and therefore exportable. Bundled skills
    // are refused by /file on purpose, so the catalogue alone would not
    // exercise that route.
    await mkdir(join(repo, '.baton', 'skills'), { recursive: true });
    await writeFile(join(repo, '.baton', 'skills', `${SKILL_ID}.md`), SKILL_V1, 'utf-8');

    PORT = await freePort();
    const child = execa('node', [DIST_CLI, 'serve', '--port', String(PORT)], {
      cwd: repo,
      reject: false,
      // HOME is redirected for the same reason test/helpers/private-home.ts
      // exists: the daemon reads ~/.baton for the global skill library.
      env: { ...process.env, HOME: join(base, 'home'), BATON_DAEMONS_DIR: join(base, 'registry') },
    });
    children.push(child);
    const deadline = Date.now() + DAEMON_START_MS;
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

  describe('GET /api/skills', () => {
    it('sends a strong ETag alongside the usual payload', async () => {
      const r = await raw('/api/skills');
      expect(r.status).toBe(200);
      expect(r.headers.etag, 'no ETag on the catalogue').toMatch(/^"[0-9a-f]{64}"$/);
      const body = json(r);
      expect(Array.isArray(body.skills)).toBe(true);
      expect(body.skills.length).toBeGreaterThan(5);
      // endsWith, not equality: macOS resolves /var to /private/var, so the
      // daemon reports the realpath of the temp dir the test made.
      expect(String(body.root).endsWith('/repo')).toBe(true);
      expect(Array.isArray(body.agents)).toBe(true);
      expect(typeof body.excludesInstalls).toBe('boolean');
    });

    it('is stable, so a second poll can be conditional at all', async () => {
      const a = await raw('/api/skills');
      const b = await raw('/api/skills');
      expect(b.headers.etag).toBe(a.headers.etag);
    });

    it('answers a matching If-None-Match with 304 and zero bytes', async () => {
      const first = await raw('/api/skills');
      const etag = String(first.headers.etag);
      const second = await raw('/api/skills', { 'If-None-Match': etag });
      expect(second.status).toBe(304);
      // The point of the endpoint. Bytes, not status.
      expect(second.bytes.length, `304 carried ${second.bytes.length} bytes`).toBe(0);
      // RFC 9110 §15.4.5: a 304 repeats the tag, so the client can keep using it.
      expect(second.headers.etag).toBe(etag);
    });

    it('treats a weak tag as a match — it names the same content', async () => {
      const etag = String((await raw('/api/skills')).headers.etag);
      const weak = await raw('/api/skills', { 'If-None-Match': `W/${etag}` });
      expect(weak.status).toBe(304);
      expect(weak.bytes.length).toBe(0);
    });

    it('honours If-None-Match: * — the catalogue always exists', async () => {
      const r = await raw('/api/skills', { 'If-None-Match': '*' });
      expect(r.status).toBe(304);
      expect(r.bytes.length).toBe(0);
    });

    it('matches one tag out of a comma-separated list', async () => {
      const etag = String((await raw('/api/skills')).headers.etag);
      const r = await raw('/api/skills', {
        'If-None-Match': `"0000000000000000000000000000000000000000000000000000000000000000", ${etag}, W/"beef"`,
      });
      expect(r.status).toBe(304);
      expect(r.bytes.length).toBe(0);
    });

    it('serves the full body when the tag does not match', async () => {
      const r = await raw('/api/skills', {
        'If-None-Match': '"0000000000000000000000000000000000000000000000000000000000000000"',
      });
      expect(r.status).toBe(200);
      expect(r.bytes.length).toBeGreaterThan(0);
      expect(json(r).skills.length).toBeGreaterThan(5);
    });

    it('never lets a cache serve a skill without asking', async () => {
      // max-age would let a client run yesterday's instructions. no-store says
      // the revalidation is the client's own, explicit, every time.
      const r = await raw('/api/skills');
      expect(String(r.headers['cache-control'])).toContain('no-store');
      expect(String(r.headers['cache-control'])).not.toMatch(/max-age=[1-9]/);
    });

    it('changes the tag when a skill on disk changes', async () => {
      const before = String((await raw('/api/skills')).headers.etag);
      await writeFile(join(repo, '.baton', 'skills', `${SKILL_ID}.md`), SKILL_V2, 'utf-8');
      const after = await raw('/api/skills');
      expect(after.headers.etag).not.toBe(before);
      // And the stale tag no longer buys a 304 — this is the security half.
      const stale = await raw('/api/skills', { 'If-None-Match': before });
      expect(stale.status).toBe(200);
      expect(stale.bytes.length).toBeGreaterThan(0);
    });
  });

  describe('GET /api/skills/:id/file', () => {
    it('sends a per-skill ETag with the markdown', async () => {
      const r = await raw(`/api/skills/${SKILL_ID}/file`);
      expect(r.status).toBe(200);
      expect(r.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
      expect(r.bytes.toString('utf-8')).toContain('# Etag demo');
    });

    it('differs from the catalogue tag — they are different entities', async () => {
      const list = String((await raw('/api/skills')).headers.etag);
      const file = String((await raw(`/api/skills/${SKILL_ID}/file`)).headers.etag);
      expect(file).not.toBe(list);
    });

    it('answers a matching If-None-Match with 304 and zero bytes', async () => {
      const first = await raw(`/api/skills/${SKILL_ID}/file`);
      const etag = String(first.headers.etag);
      const second = await raw(`/api/skills/${SKILL_ID}/file`, { 'If-None-Match': etag });
      expect(second.status).toBe(304);
      expect(second.bytes.length, `304 carried ${second.bytes.length} bytes`).toBe(0);
      expect(second.headers.etag).toBe(etag);
    });

    it('accepts a weak tag and a list, same as the catalogue', async () => {
      const etag = String((await raw(`/api/skills/${SKILL_ID}/file`)).headers.etag);
      for (const header of [`W/${etag}`, '*', `W/"beef", ${etag}`]) {
        const r = await raw(`/api/skills/${SKILL_ID}/file`, { 'If-None-Match': header });
        expect(r.status, `If-None-Match: ${header}`).toBe(304);
        expect(r.bytes.length).toBe(0);
      }
    });

    it('serves the markdown when the tag does not match', async () => {
      const r = await raw(`/api/skills/${SKILL_ID}/file`, { 'If-None-Match': '"nope"' });
      expect(r.status).toBe(200);
      expect(r.bytes.length).toBeGreaterThan(0);
      expect(r.bytes.toString('utf-8')).toContain('# Etag demo');
    });

    it('moves the tag when the file is edited, and refuses the stale one', async () => {
      const before = String((await raw(`/api/skills/${SKILL_ID}/file`)).headers.etag);
      await writeFile(
        join(repo, '.baton', 'skills', `${SKILL_ID}.md`),
        SKILL_V2.replace('Edited text', 'Edited again'),
        'utf-8',
      );
      const after = await raw(`/api/skills/${SKILL_ID}/file`);
      expect(after.headers.etag).not.toBe(before);
      const stale = await raw(`/api/skills/${SKILL_ID}/file`, { 'If-None-Match': before });
      expect(stale.status).toBe(200);
      expect(stale.bytes.toString('utf-8')).toContain('Edited again');
    });

    it('still refuses a bundled skill rather than 304-ing it', async () => {
      // The refusal predates this change and must survive it: a conditional
      // request must not become a back door around a 403.
      const r = await raw('/api/skills/bug-fix/file', { 'If-None-Match': '*' });
      expect(r.status).toBe(403);
    });

    it('still 404s an unknown skill under If-None-Match: *', async () => {
      const r = await raw('/api/skills/no-such-skill-at-all/file', { 'If-None-Match': '*' });
      expect(r.status).toBe(404);
    });
  });
});
