// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P17 step 1 — what the endpoint is ACTUALLY serving, which is not always what
 * config claims.
 *
 * Config's `models` list stops being the source of truth and becomes the
 * fallback for when the gateway cannot be asked — and a fallback list is
 * labelled `verified: false`, because a list nobody confirmed, rendered as if
 * somebody had, is the same class of lie as P28's "nobody is there".
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { validateEndpointsConfig, type EndpointConfig } from '../src/endpoints/config.js';
import { clearCatalogCache, endpointCatalog } from '../src/endpoints/catalog.js';

const servers: Server[] = [];
afterEach(async () => {
  clearCatalogCache();
  while (servers.length) await new Promise<void>((r) => servers.pop()!.close(() => r()));
});

async function listen(
  reply: (url: string) => { status: number; body: unknown },
): Promise<{ url: string; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    const { status, body } = reply(req.url ?? '');
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

const endpointAt = (url: string, extra: Record<string, unknown> = {}): EndpointConfig =>
  validateEndpointsConfig(
    { endpoints: { fleet: { kind: 'openai-compatible', url, models: ['from-config'], ...extra } } },
    {},
  ).config.endpoints[0];

const OPENAI_LIST = { object: 'list', data: [{ id: 'qwen3-coder' }, { id: 'kimi-k2' }] };

describe('the live catalog', () => {
  it('asks the gateway and returns what it is serving now', async () => {
    const { url, hits } = await listen(() => ({ status: 200, body: OPENAI_LIST }));
    const catalog = await endpointCatalog(endpointAt(url), {});

    expect(catalog.models.map((m) => m.id)).toEqual(['qwen3-coder', 'kimi-k2']);
    expect(catalog.verified).toBe(true);
    expect(hits[0]).toBe('/v1/models');
  });

  it('prefers the live list over the configured one — config can be stale', async () => {
    const { url } = await listen(() => ({ status: 200, body: OPENAI_LIST }));
    const catalog = await endpointCatalog(endpointAt(url), {});
    expect(catalog.models.map((m) => m.id)).not.toContain('from-config');
  });

  it('stamps every model with the ENDPOINT that serves it and its egress class', async () => {
    const { url } = await listen(() => ({ status: 200, body: OPENAI_LIST }));
    const catalog = await endpointCatalog(endpointAt(url), {});
    expect(catalog.models[0].endpointId).toBe('fleet');
    // 127.0.0.1 — the machine is the customer.
    expect(catalog.models[0].egress).toBe('local');
  });

  // P17-E2
  it('falls back to the configured list when the fetch fails, and says it is unverified', async () => {
    const catalog = await endpointCatalog(endpointAt('http://127.0.0.1:1'), {});
    expect(catalog.models.map((m) => m.id)).toEqual(['from-config']);
    expect(catalog.verified).toBe(false);
    expect(catalog.detail).toBeTruthy();
  });

  it('falls back on a refusal too, not only on a dead socket', async () => {
    const { url } = await listen(() => ({ status: 401, body: { error: 'no key' } }));
    const catalog = await endpointCatalog(endpointAt(url), {});
    expect(catalog.verified).toBe(false);
    expect(catalog.models.map((m) => m.id)).toEqual(['from-config']);
  });

  it('returns an honestly empty catalog when config lists nothing either', async () => {
    const bare = validateEndpointsConfig(
      { endpoints: { fleet: { kind: 'openai-compatible', url: 'http://127.0.0.1:1' } } },
      {},
    ).config.endpoints[0];
    const catalog = await endpointCatalog(bare, {});
    expect(catalog.models).toEqual([]);
    expect(catalog.verified).toBe(false);
  });

  // P17-E4 — one probe per endpoint per window, shared by every caller.
  it('asks once per cache window however many callers there are', async () => {
    const { url, hits } = await listen(() => ({ status: 200, body: OPENAI_LIST }));
    const ep = endpointAt(url);
    await Promise.all([endpointCatalog(ep, {}), endpointCatalog(ep, {}), endpointCatalog(ep, {})]);
    await endpointCatalog(ep, {});
    expect(hits).toHaveLength(1);
  });

  it('asks again once the window has passed', async () => {
    const { url, hits } = await listen(() => ({ status: 200, body: OPENAI_LIST }));
    const ep = endpointAt(url);
    await endpointCatalog(ep, {}, 0);
    await endpointCatalog(ep, {}, 60_000);
    expect(hits).toHaveLength(2);
  });

  it('carries the credential in a header, never in the URL', async () => {
    const { url, hits } = await listen(() => ({ status: 200, body: OPENAI_LIST }));
    await endpointCatalog(endpointAt(url, { keyRef: 'env:K' }), { K: 'sk-live-catalog' });
    expect(hits).toHaveLength(1);
    expect(hits[0]).not.toContain('sk-live-catalog');
  });

  it('reads an Ollama runtime through its own dialect', async () => {
    const { url, hits } = await listen((path) =>
      path === '/api/tags'
        ? { status: 200, body: { models: [{ name: 'qwen3-coder:7b' }] } }
        : { status: 404, body: {} },
    );
    const ollama = validateEndpointsConfig(
      { endpoints: { box: { kind: 'ollama', url, models: [] } } },
      {},
    ).config.endpoints[0];
    const catalog = await endpointCatalog(ollama, {});
    expect(hits[0]).toBe('/api/tags');
    expect(catalog.models.map((m) => m.id)).toEqual(['qwen3-coder:7b']);
    expect(catalog.verified).toBe(true);
  });

  // A base of `https://gw/v1` is the ordinary OpenAI convention, and appending
  // `/v1/models` to it asked for `/v1/v1/models`.
  it('does not double the /v1 when the base URL already carries it', async () => {
    const { url, hits } = await listen(() => ({ status: 200, body: OPENAI_LIST }));
    await endpointCatalog(endpointAt(`${url}/v1`), {});
    expect(hits[0]).toBe('/v1/models');
  });

  it('refuses a stranger on the port rather than rendering junk as a catalog', async () => {
    const { url } = await listen(() => ({ status: 200, body: { hello: 'vite' } }));
    const catalog = await endpointCatalog(endpointAt(url), {});
    expect(catalog.verified).toBe(false);
    expect(catalog.models.map((m) => m.id)).toEqual(['from-config']);
  });
});
