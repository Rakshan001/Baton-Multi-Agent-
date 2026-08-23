// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P16 step 2 — the refusals.
 *
 * Same rule the executor already encodes: **refuse, never substitute.** An
 * agent that cannot reach the model the plan named must say so, because the
 * quiet alternative is running a different model than the plan asked for and
 * billing someone for it.
 *
 * Three codes, three different fixes, so they are three different codes:
 *   no-endpoint            an impossible pairing — the vendor allows no endpoint
 *   endpoint-unreachable   the gateway did not answer
 *   endpoint-unauthorized  it answered 401, or we have no credential to send
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { validateEndpointsConfig, type EndpointConfig } from '../src/endpoints/config.js';
import { clearEndpointHealthCache, probeEndpoint } from '../src/endpoints/health.js';
import { resolveLaunch, type AgentCapability } from '../src/executors/capability.js';
import { endpointViaFor } from '../src/endpoints/reach.js';

const cap = (agentId: string, over: Partial<AgentCapability> = {}): AgentCapability => ({
  agentId,
  nativeId: agentId,
  modes: ['interactive'],
  supportsModel: true,
  acceptsPromptAtLaunch: true,
  installed: true,
  endpointVia: endpointViaFor(agentId),
  ...over,
});

const caps = (...ids: string[]) => new Map(ids.map((id) => [id, cap(id)]));

const endpoint = (ep: Record<string, unknown>, env: NodeJS.ProcessEnv = {}): EndpointConfig =>
  validateEndpointsConfig({ endpoints: { fleet: ep } }, env).config.endpoints[0];

const FLEET = endpoint({ kind: 'anthropic-compatible', url: 'https://gw', models: ['kimi-k2'] });
const OLLAMA = endpoint({ kind: 'ollama', url: 'http://gpu:11434', models: ['qwen3-coder'] });

describe('no-endpoint — the impossible pairing', () => {
  it('refuses an agent whose vendor allows no self-hosted model', () => {
    const r = resolveLaunch({ agentId: 'antigravity', model: 'kimi-k2', want: 'any' }, caps('antigravity'), 'local', { endpoint: FLEET });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe('no-endpoint');
    // The remediation, not just the diagnosis.
    expect(r.ok === false && r.message).toContain('claude');
    expect(r.ok === false && r.message).toContain('kimi-k2');
  });

  it('names the agents that can reach THIS endpoint, not a fixed list', () => {
    const r = resolveLaunch({ agentId: 'antigravity', model: 'qwen3-coder', want: 'any' }, caps('antigravity'), 'local', { endpoint: OLLAMA });
    expect(r.ok === false && r.message).toContain('aider');
    expect(r.ok === false && r.message).toContain('opencode');
    expect(r.ok === false && r.message).not.toContain('claude');
  });

  it('refuses an agent that speaks the wrong dialect for this endpoint', () => {
    const r = resolveLaunch({ agentId: 'claude', model: 'qwen3-coder', want: 'any' }, caps('claude'), 'local', { endpoint: OLLAMA });
    expect(r.ok === false && r.code).toBe('no-endpoint');
    expect(r.ok === false && r.message).toContain('ollama');
  });

  // P16-E6 — the refusal is for an impossible PAIRING, not for using
  // Antigravity at all. No endpoint model in play, no refusal.
  it('launches a null-reach agent normally when no endpoint model is involved', () => {
    expect(resolveLaunch({ agentId: 'antigravity', want: 'any' }, caps('antigravity'), 'local', { endpoint: null }).ok).toBe(true);
    expect(resolveLaunch({ agentId: 'antigravity', want: 'any' }, caps('antigravity'), 'local').ok).toBe(true);
  });

  it('leaves every existing refusal exactly where it was', () => {
    const r = resolveLaunch({ agentId: 'nope', model: 'kimi-k2', want: 'any' }, caps('claude'), 'local', { endpoint: FLEET });
    expect(r.ok === false && r.code).toBe('unknown-agent');
  });
});

describe('endpoint-unauthorized — no credential, or one the gateway rejected', () => {
  it('refuses before launch when the declared key is not in the environment', () => {
    const ep = endpoint({ kind: 'anthropic-compatible', url: 'https://gw', models: ['kimi-k2'], keyRef: 'env:FLEET_KEY' }, {});
    const r = resolveLaunch({ agentId: 'claude', model: 'kimi-k2', want: 'any' }, caps('claude'), 'local', { endpoint: ep });
    expect(r.ok === false && r.code).toBe('endpoint-unauthorized');
    expect(r.ok === false && r.message).toContain('FLEET_KEY');
  });

  it('refuses on a live 401, with wording that is not the missing-key wording', () => {
    const r = resolveLaunch({ agentId: 'claude', model: 'kimi-k2', want: 'any' }, caps('claude'), 'local', { endpoint: FLEET, health: 'unauthorized' });
    expect(r.ok === false && r.code).toBe('endpoint-unauthorized');
    expect(r.ok === false && r.message).toContain('rejected');
  });
});

describe('endpoint-unreachable — distinct from unauthorized, because the fix differs', () => {
  it('refuses when the gateway did not answer', () => {
    const r = resolveLaunch({ agentId: 'claude', model: 'kimi-k2', want: 'any' }, caps('claude'), 'local', { endpoint: FLEET, health: 'unreachable' });
    expect(r.ok === false && r.code).toBe('endpoint-unreachable');
    expect(r.ok === false && r.message).toContain('gw');
  });

  // P17-E1 reaching the launch path: a probe that timed out is not permission.
  it('refuses on an indeterminate probe, and says it may be slow rather than down', () => {
    const r = resolveLaunch({ agentId: 'claude', model: 'kimi-k2', want: 'any' }, caps('claude'), 'local', { endpoint: FLEET, health: 'unknown' });
    expect(r.ok === false && r.code).toBe('endpoint-unreachable');
    expect(r.ok === false && r.message).toMatch(/did not answer in time|may be slow/i);
  });

  it('launches when the gateway is healthy', () => {
    expect(resolveLaunch({ agentId: 'claude', model: 'kimi-k2', want: 'any' }, caps('claude'), 'local', { endpoint: FLEET, health: 'ok' }).ok).toBe(true);
  });

  // Not probing is not the same as probing and failing. A dispatcher that has
  // not asked must not refuse on an answer it never got.
  it('does not refuse when nothing was probed', () => {
    expect(resolveLaunch({ agentId: 'claude', model: 'kimi-k2', want: 'any' }, caps('claude'), 'local', { endpoint: FLEET }).ok).toBe(true);
  });
});

describe('probeEndpoint', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    clearEndpointHealthCache();
    while (servers.length) await new Promise<void>((r) => servers.pop()!.close(() => r()));
  });

  async function listen(handler: (req: { url: string; headers: Record<string, unknown> }) => number): Promise<{ url: string; seen: { url: string; headers: Record<string, unknown> }[] }> {
    const seen: { url: string; headers: Record<string, unknown> }[] = [];
    const server = createServer((req, res) => {
      const entry = { url: req.url ?? '', headers: req.headers as Record<string, unknown> };
      seen.push(entry);
      res.writeHead(handler(entry)).end('{}');
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
  }

  it('reads a healthy gateway as ok', async () => {
    const { url } = await listen(() => 200);
    expect((await probeEndpoint(endpoint({ kind: 'ollama', url, models: ['x'] }), {})).state).toBe('ok');
  });

  it('reads 401 and 403 as unauthorized', async () => {
    for (const status of [401, 403]) {
      clearEndpointHealthCache();
      const { url } = await listen(() => status);
      expect((await probeEndpoint(endpoint({ kind: 'ollama', url, models: ['x'] }), {})).state, String(status)).toBe('unauthorized');
    }
  });

  // A missing /health path is not a down gateway — something answered.
  it('reads 404 as reachable, not as down', async () => {
    const { url } = await listen(() => 404);
    expect((await probeEndpoint(endpoint({ kind: 'ollama', url, models: ['x'] }), {})).state).toBe('ok');
  });

  it('reads a refused connection as unreachable', async () => {
    const ep = endpoint({ kind: 'ollama', url: 'http://127.0.0.1:1', models: ['x'] });
    const out = await probeEndpoint(ep, {});
    expect(out.state).toBe('unreachable');
    expect(out.detail).toBeTruthy();
  });

  it('sends the credential in a header, never in the URL', async () => {
    const { url, seen } = await listen(() => 200);
    const ep = endpoint({ kind: 'anthropic-compatible', url, models: ['x'], keyRef: 'env:K' }, { K: 'sk-live-secret' });
    await probeEndpoint(ep, { K: 'sk-live-secret' });
    expect(seen[0].url).not.toContain('sk-live-secret');
    expect(seen[0].headers['x-api-key']).toBe('sk-live-secret');
  });

  it('asks once per endpoint, not once per queued task', async () => {
    const { url, seen } = await listen(() => 200);
    const ep = endpoint({ kind: 'ollama', url, models: ['x'] });
    await probeEndpoint(ep, {});
    await probeEndpoint(ep, {});
    expect(seen).toHaveLength(1);
  });
});
