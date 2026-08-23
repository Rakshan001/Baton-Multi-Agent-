// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * D4's adapter boundary.
 *
 * Both gateways speak OpenAI-compatible HTTP over P15's `url` + `keyRef`, so
 * *routing* needs no per-gateway code at all. They differ only in
 * administration — issuing keys, reading usage, reading a key's model policy —
 * and that, exactly that, is what an adapter is for.
 *
 * The rule that keeps the second gateway nearly free: **nothing outside an
 * adapter may name a gateway.** The moment routing, the picker or the dashboard
 * branches on "if omniroute", every LiteLLM customer needs a second
 * implementation of that feature, and the migration stops being a config change.
 * The last test in this file is what enforces it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateEndpointsConfig } from '../src/endpoints/config.js';
import { GATEWAY_ADAPTERS, gatewayAdapterFor, registeredGatewayIds } from '../src/endpoints/gateways/registry.js';

const endpoint = (extra: Record<string, unknown> = {}) =>
  validateEndpointsConfig(
    { endpoints: { e: { kind: 'openai-compatible', url: 'https://gw.corp.internal/v1', models: ['m'], ...extra } } },
    {},
  ).config.endpoints[0];

describe('the adapter registry', () => {
  it('registers every adapter under its own declared id', () => {
    for (const [id, adapter] of Object.entries(GATEWAY_ADAPTERS)) {
      expect(adapter.id, id).toBe(id);
    }
    expect(registeredGatewayIds().length).toBeGreaterThan(0);
  });

  it('gives every adapter the same shape, so callers never special-case one', () => {
    for (const adapter of Object.values(GATEWAY_ADAPTERS)) {
      expect(typeof adapter.id).toBe('string');
      expect(typeof adapter.catalog).toBe('function');
    }
  });

  // D4: LiteLLM ships dark. Not greyed out, not "coming soon" — absent.
  it('does not register litellm, so a hand-edited config cannot select it', () => {
    expect(registeredGatewayIds()).not.toContain('litellm');
    const chosen = gatewayAdapterFor(endpoint({ gateway: 'litellm' }));
    expect(chosen.adapter.id).not.toBe('litellm');
    // And it says so, rather than silently using something else.
    expect(chosen.warning).toContain('litellm');
  });

  it('falls back to the default adapter, named, for any unknown gateway', () => {
    const chosen = gatewayAdapterFor(endpoint({ gateway: 'not-a-gateway' }));
    expect(chosen.adapter.id).toBe(registeredGatewayIds()[0]);
    expect(chosen.warning).toContain('not-a-gateway');
  });

  it('uses the direct adapter for a runtime with no gateway in front of it', () => {
    // GW-E7: Ollama on its own is a supported deployment. The picker works;
    // per-person grants do not, because there is no admin surface to ask.
    const direct = gatewayAdapterFor(
      validateEndpointsConfig(
        { endpoints: { e: { kind: 'ollama', url: 'http://127.0.0.1:11434', models: ['qwen3-coder'] } } },
        {},
      ).config.endpoints[0],
    );
    expect(direct.adapter.id).toBe('direct');
    expect(direct.warning).toBeNull();
  });
});

/**
 * 🔴 The boundary test. A quoted gateway name outside its own adapter is a
 * branch on which gateway is in use, and that is the thing that turns a
 * config change back into a rewrite.
 *
 * Prose in a comment is fine and often useful — this looks for the string
 * LITERAL, which is what a code path would need.
 */
describe('no code outside an adapter names a gateway', () => {
  const SRC = new URL('../src', import.meta.url).pathname;

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
    });

  it('keeps every gateway id inside src/endpoints/gateways/', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.includes(join('endpoints', 'gateways'))) continue;
      const text = readFileSync(file, 'utf-8');
      for (const id of [...registeredGatewayIds(), 'litellm', 'omniroute']) {
        if (id === 'direct') continue; // not a gateway — the absence of one
        if (text.includes(`'${id}'`) || text.includes(`"${id}"`)) {
          offenders.push(`${file.slice(SRC.length + 1)} names '${id}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/*
 * P18 — issuing a credential that belongs to ONE member.
 *
 * This is the second thing an adapter is for, and the reason enrollment can
 * refuse to ship the company key: if the gateway can mint per-member keys, a
 * developer who leaves is revoked by revoking one key, not by re-keying the
 * company. The request shape is OmniRoute's documented one
 * (`POST /api/v1/registered-keys`, raw key returned exactly once).
 */
describe('minting a per-member credential', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    while (servers.length) await new Promise<void>((r) => servers.pop()!.close(() => r()));
  });

  interface Seen { path: string; auth: string; body: unknown }

  async function gatewayThat(reply: (body: unknown) => { status: number; json: unknown }): Promise<{ url: string; seen: Seen[] }> {
    const seen: Seen[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : null;
        seen.push({ path: req.url ?? '', auth: String(req.headers.authorization ?? ''), body });
        const out = reply(body);
        res.writeHead(out.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(out.json));
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
  }

  const withKey = (url: string) =>
    validateEndpointsConfig(
      { endpoints: { fleet: { kind: 'openai-compatible', url, models: ['m'], keyRef: 'env:GW_ADMIN' } } },
      { GW_ADMIN: 'sk-admin-0000' },
    ).config.endpoints[0];

  it('returns the key the gateway issued, and names the member it is for', async () => {
    const gw = await gatewayThat(() => ({
      status: 201,
      json: { key: 'sk-issued-1234', keyId: 'k1', expiresAt: '2026-09-23T00:00:00.000Z' },
    }));
    const adapter = GATEWAY_ADAPTERS[registeredGatewayIds()[0]];
    const minted = await adapter.mintMemberKey!(withKey(gw.url), { GW_ADMIN: 'sk-admin-0000' }, {
      memberId: 'priya',
      expiresAt: '2026-09-23T00:00:00.000Z',
    });

    // The keyId matters as much as the key: without it the credential can only
    // ever be retired by expiry, and P18-E2's revoke has nothing to name.
    expect(minted).toEqual({ value: 'sk-issued-1234', expiresAt: '2026-09-23T00:00:00.000Z', keyId: 'k1' });
    // The admin credential travels as a header, never in the URL — a key in a
    // query string is a key in every proxy log between here and the gateway.
    expect(gw.seen[0].auth).toBe('Bearer sk-admin-0000');
    expect(gw.seen[0].path).not.toContain('sk-admin');
    // Named after the member, so the company can see whose key is whose when
    // it comes time to revoke one.
    expect(JSON.stringify(gw.seen[0].body)).toContain('priya');
  });

  /*
   * 🔴 A gateway that refuses must produce NO credential. The tempting failure
   * is to treat a non-201 as "fine, carry on" — and enrollment would then hand
   * out an endpoint with the company key still resolvable behind it.
   */
  it('returns null when the gateway refuses, rather than anything else', async () => {
    const gw = await gatewayThat(() => ({ status: 403, json: { error: 'nope' } }));
    const adapter = GATEWAY_ADAPTERS[registeredGatewayIds()[0]];
    expect(await adapter.mintMemberKey!(withKey(gw.url), { GW_ADMIN: 'sk-admin-0000' }, { memberId: 'priya', expiresAt: null })).toBeNull();
  });

  it('returns null when the gateway answers 201 with no key in it', async () => {
    const gw = await gatewayThat(() => ({ status: 201, json: { keyId: 'k1' } }));
    const adapter = GATEWAY_ADAPTERS[registeredGatewayIds()[0]];
    expect(await adapter.mintMemberKey!(withKey(gw.url), { GW_ADMIN: 'sk-admin-0000' }, { memberId: 'priya', expiresAt: null })).toBeNull();
  });

  // 🔴 Without an admin credential we are not an admin. Posting anyway would,
  // against a gateway with auth disabled, mint keys for anyone who can reach it.
  it('does not ask at all without an admin credential', async () => {
    const gw = await gatewayThat(() => ({ status: 201, json: { key: 'sk-should-not-happen' } }));
    const adapter = GATEWAY_ADAPTERS[registeredGatewayIds()[0]];
    const bare = validateEndpointsConfig(
      { endpoints: { fleet: { kind: 'openai-compatible', url: gw.url, models: ['m'] } } },
      {},
    ).config.endpoints[0];
    expect(await adapter.mintMemberKey!(bare, {}, { memberId: 'priya', expiresAt: null })).toBeNull();
    expect(gw.seen).toEqual([]);
  });

  // GW-E7 — a runtime reached directly has no admin surface, and the honest
  // shape for that is "this adapter cannot mint", not a function returning null.
  it('is absent on the direct adapter, so callers can see there is nobody to ask', () => {
    const direct = gatewayAdapterFor(
      validateEndpointsConfig({ endpoints: { o: { kind: 'ollama', url: 'http://127.0.0.1:11434' } } }, {}).config.endpoints[0],
    ).adapter;
    expect(direct.mintMemberKey).toBeUndefined();
  });
});

/*
 * P18-E2's other half — telling the gateway a credential is finished.
 *
 * Revoking the member stops them getting a new one; this is what kills the one
 * already on their laptop. Without it, "the gateway credential dies with them"
 * is a sentence in a doc rather than something that happens.
 */
describe('revoking a per-member credential', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    while (servers.length) await new Promise<void>((r) => servers.pop()!.close(() => r()));
  });

  async function gatewayThat(status: number): Promise<{ url: string; hits: string[] }> {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.writeHead(status, { 'Content-Type': 'application/json' }).end('{}');
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
  }

  const adminEndpoint = (url: string) =>
    validateEndpointsConfig(
      { endpoints: { fleet: { kind: 'openai-compatible', url: `${url}/v1`, models: ['m'], keyRef: 'env:GW_ADMIN' } } },
      { GW_ADMIN: 'sk-admin-0000' },
    ).config.endpoints[0];

  it('asks the gateway to revoke the key it was given', async () => {
    const gw = await gatewayThat(200);
    const adapter = GATEWAY_ADAPTERS[registeredGatewayIds()[0]];
    expect(await adapter.revokeMemberKey!(adminEndpoint(gw.url), { GW_ADMIN: 'sk-admin-0000' }, 'key-abc')).toBe(true);
    // The admin API is at the gateway ROOT, not under the OpenAI base path the
    // endpoint URL points at — appending to `/v1` would 404 every revoke.
    expect(gw.hits).toEqual(['POST /api/v1/registered-keys/key-abc/revoke']);
  });

  /*
   * A key the gateway has never heard of, or has already killed, is the state
   * we wanted. Reporting that as a failure would make a leaver's revoke look
   * unfinished and invite someone to "fix" it by re-issuing.
   */
  it('treats a key the gateway does not have as already gone', async () => {
    const gw = await gatewayThat(404);
    const adapter = GATEWAY_ADAPTERS[registeredGatewayIds()[0]];
    expect(await adapter.revokeMemberKey!(adminEndpoint(gw.url), { GW_ADMIN: 'sk-admin-0000' }, 'key-abc')).toBe(true);
  });

  // 🔴 A gateway that refused, or that we never reached, must read as FAILED —
  // so the caller can say the credential may still be live rather than
  // reporting a revocation that never happened.
  it('reports a refusal as a failure, never as success', async () => {
    const gw = await gatewayThat(500);
    const adapter = GATEWAY_ADAPTERS[registeredGatewayIds()[0]];
    expect(await adapter.revokeMemberKey!(adminEndpoint(gw.url), { GW_ADMIN: 'sk-admin-0000' }, 'key-abc')).toBe(false);
  });

  it('escapes an id rather than pasting it into the path', async () => {
    const gw = await gatewayThat(200);
    const adapter = GATEWAY_ADAPTERS[registeredGatewayIds()[0]];
    await adapter.revokeMemberKey!(adminEndpoint(gw.url), { GW_ADMIN: 'sk-admin-0000' }, '../../admin/settings');
    expect(gw.hits[0]).not.toContain('/admin/settings');
  });
});
