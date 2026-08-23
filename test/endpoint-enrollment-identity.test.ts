// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * 🔴 Whose enrollment is this?
 *
 * Found by running the route, not by reading it. `decideAccess` rule 1 lets a
 * loopback peer through with no credential at all, so the daemon hands the
 * handler `member: null` even when a perfectly good member token was presented
 * — and the enrollment route filed the minted credential under `local`.
 *
 * That is not cosmetic. The ledger is what `baton member revoke` reads to kill a
 * leaver's gateway credential (P18-E2). File it under `local` and the revoke
 * finds nothing, reports success, and the person who left keeps a working key.
 * Two members over loopback would also collide on one identity, so one
 * developer's refresh would revoke the other's credential.
 *
 * Loopback is the NORMAL path here, not an exotic one: the Orca desktop app,
 * an SSH tunnel and `curl` on the host all arrive that way.
 *
 * Gated on dist/cli.js being built (run `npm run build` first).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execa, type ResultPromise } from 'execa';

const DIST_CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const hasDist = existsSync(DIST_CLI);
const PORT = 7451;

describe.runIf(hasDist)('enrollment identity over loopback', () => {
  let base = '';
  let repo = '';
  let token = '';
  let gateway: Server | null = null;
  const children: ResultPromise[] = [];

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'baton-enroll-id-'));
    repo = join(base, 'repo');
    await execa('git', ['init', '-q', '-b', 'main', repo]);
    await execa('git', ['config', 'user.email', 't@t.dev'], { cwd: repo });
    await execa('git', ['config', 'user.name', 't'], { cwd: repo });
    await execa('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: repo });
    await execa('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });

    // A gateway that issues a key for whoever is named in the request.
    let issued = 0;
    gateway = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/api/v1/registered-keys') {
          issued += 1;
          res.writeHead(201, { 'content-type': 'application/json' })
            .end(JSON.stringify({ key: `sk-issued-${issued}`, keyId: `k${issued}`, expiresAt: null }));
          return;
        }
        res.writeHead(404).end('{}');
      });
    });
    await new Promise<void>((r) => gateway!.listen(0, '127.0.0.1', () => r()));
    const gwPort = (gateway.address() as AddressInfo).port;

    await writeFile(
      join(repo, 'baton.config.json'),
      JSON.stringify({
        endpoints: {
          vendor: {
            kind: 'openai-compatible',
            url: `http://127.0.0.1:${gwPort}/v1`,
            models: ['gpt-4o'],
            gateway: 'omniroute',
            keyRef: 'env:GW_ADMIN',
            egress: 'external',
          },
        },
      }, null, 2),
    );

    // An owner first: the FIRST member added becomes the owner, and the only
    // owner cannot be revoked — so Priya has to be the second one for the
    // revocation case below to be about revocation rather than about that rule.
    await execa('node', [DIST_CLI, 'member', 'add', 'Ravi', '--role', 'owner'], { cwd: repo, reject: false });
    const added = await execa('node', [DIST_CLI, 'member', 'add', 'Priya'], { cwd: repo, reject: false });
    token = /baton_[0-9a-f]{64}/.exec(`${added.stdout}\n${added.stderr}`)?.[0] ?? '';

    const child = execa('node', [DIST_CLI, 'serve', '--port', String(PORT)], {
      cwd: repo,
      reject: false,
      env: { ...process.env, GW_ADMIN: 'sk-admin-secret', BATON_DAEMONS_DIR: join(base, 'registry') },
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
  }, 60_000);

  afterAll(async () => {
    for (const c of children) c.kill('SIGTERM');
    await new Promise<void>((r) => (gateway ? gateway.close(() => r()) : r()));
    if (base) await rm(base, { recursive: true, force: true });
  });

  it('mints the token holder a credential, filed under their own name', async () => {
    expect(token).toMatch(/^baton_[0-9a-f]{64}$/);
    const res = await fetch(`http://127.0.0.1:${PORT}/api/endpoints/enrollment`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { credentials: Array<{ value: string }> };
    expect(body.credentials).toHaveLength(1);

    // 🔴 The assertion the bug failed: filed under `priya`, so
    // `baton member revoke priya` has something to find.
    const ledger = JSON.parse(await readFile(join(repo, '.baton', 'issued-keys.json'), 'utf-8')) as Array<{ memberId: string }>;
    expect(ledger.map((k) => k.memberId)).toEqual(['priya']);
  }, 40_000);

  it('names a caller with no token at all as the host itself', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/endpoints/enrollment`, { signal: AbortSignal.timeout(20_000) });
    expect(res.status).toBe(200);
    const ledger = JSON.parse(await readFile(join(repo, '.baton', 'issued-keys.json'), 'utf-8')) as Array<{ memberId: string }>;
    // Both rows survive: one identity per holder, so neither revoke clobbers
    // the other's credential.
    expect(ledger.map((k) => k.memberId).sort()).toEqual(['local', 'priya']);
  }, 40_000);

  it('gives a revoked member nothing, even from loopback', async () => {
    await execa('node', [DIST_CLI, 'member', 'revoke', 'priya'], { cwd: repo, reject: false });
    const res = await fetch(`http://127.0.0.1:${PORT}/api/endpoints/enrollment`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    // Loopback still lets them read — that is rule 1, and it is not this route's
    // job to override it — but they are no longer PRIYA, so they cannot obtain
    // or replace a credential in her name.
    const ledger = JSON.parse(await readFile(join(repo, '.baton', 'issued-keys.json'), 'utf-8')) as Array<{ memberId: string }>;
    expect(res.status).toBe(200);
    expect(ledger.filter((k) => k.memberId === 'priya')).toEqual([]);
  }, 40_000);
});
