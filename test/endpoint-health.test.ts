// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P17-E1 — an unanswered question is not a "no", and it is certainly not a
 * "yes".
 *
 * Three answers a probe can honestly give, and the difference between the last
 * two is the whole point of this file:
 *
 *   ok            it answered
 *   unreachable   it definitively did not — the socket was refused, the name
 *                 does not resolve. Something is wrong and we know what.
 *   unknown       it did not answer IN TIME. That is indeterminate, and
 *                 reporting it as either "up" or "down" invents a fact.
 *
 * Same rule as withholding a stale memory: silence is not evidence.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { validateEndpointsConfig, type EndpointConfig } from '../src/endpoints/config.js';
import { clearEndpointHealthCache, probeEndpoint } from '../src/endpoints/health.js';

const servers: Server[] = [];
afterEach(async () => {
  clearEndpointHealthCache();
  while (servers.length) await new Promise<void>((r) => servers.pop()!.close(() => r()));
});

const at = (url: string): EndpointConfig =>
  validateEndpointsConfig(
    { endpoints: { fleet: { kind: 'openai-compatible', url, models: ['m'] } } },
    {},
  ).config.endpoints[0];

/** A server that accepts the connection and then says nothing at all — the
 *  shape of an overloaded gateway, and the one that must not read as healthy. */
async function silentServer(): Promise<string> {
  const server = createServer(() => { /* deliberately never responds */ });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('probeEndpoint', () => {
  it('answers unknown when the check times out — never ok, never a flat "down"', async () => {
    const probe = await probeEndpoint(at(await silentServer()), {}, { timeoutMs: 150 });
    expect(probe.state).toBe('unknown');
    expect(probe.detail).toMatch(/did not answer/i);
  });

  it('still calls a refused connection unreachable, because that one IS definite', async () => {
    const probe = await probeEndpoint(at('http://127.0.0.1:1'), {}, { timeoutMs: 1000 });
    expect(probe.state).toBe('unreachable');
  });

  // P17-E5 — the most common support ticket is "the URL is internal and I am
  // off the VPN". Naming the host answers it in the error.
  it('names the host, so an off-VPN developer sees why', async () => {
    const probe = await probeEndpoint(at('https://gw.corp.internal:4000'), {}, { timeoutMs: 400 });
    expect(probe.detail).toContain('gw.corp.internal');
  });

  // P17-E4: twenty queued tasks asking at once must produce one probe. A
  // result-only cache lets them all through, because none has resolved yet.
  it('asks once when several callers arrive together', async () => {
    let asked = 0;
    const server = createServer((_req, res) => {
      asked += 1;
      res.writeHead(200).end('{}');
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const ep = at(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await Promise.all([probeEndpoint(ep, {}), probeEndpoint(ep, {}), probeEndpoint(ep, {})]);
    expect(asked).toBe(1);
  });

  it('caches an unknown like any other answer, so a slow gateway is asked once', async () => {
    const url = await silentServer();
    const ep = at(url);
    const first = await probeEndpoint(ep, {}, { timeoutMs: 150 });
    const second = await probeEndpoint(ep, {}, { timeoutMs: 150 });
    expect(first.state).toBe('unknown');
    expect(second).toEqual(first);
  });
});
