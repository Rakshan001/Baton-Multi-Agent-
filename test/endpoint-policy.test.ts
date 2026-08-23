// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P27 — per-agent provider routing.
 *
 * Each agent is independently in one of three states: `vendor` (its own
 * subscription, untouched, the default), `gateway` (routed to your own models),
 * or `unavailable` (the vendor forbids it — stated as a fact, never rendered as
 * a broken toggle).
 *
 * Two things this file exists to hold down.
 *
 * **The refusal.** A `gateway`-mode agent whose gateway is unreachable REFUSES.
 * It never falls back to the vendor. P16's cost rule protects a bill; this one
 * protects the code itself — falling back would send a company's source to
 * Anthropic or OpenAI at the exact moment the developer believed it was staying
 * on their network. A silent data leak dressed up as resilience.
 *
 * **The precedence.** repo → user → default. A company can pin `gateway` for
 * its own repos, and that pin must not reach a developer's side project.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { endpointLaunchInjection } from '../src/endpoints/live-endpoints.js';
import { validateEndpointsConfig, type EndpointConfig } from '../src/endpoints/config.js';
import {
  providerLaunchRefusal,
  readProviderPolicy,
  resolveProviderMode,
  type ProviderPolicy,
} from '../src/endpoints/policy.js';

const GATEWAY: EndpointConfig = validateEndpointsConfig(
  { endpoints: { fleet: { kind: 'anthropic-compatible', url: 'https://gw.corp.internal/v1', models: ['kimi-k2'], egress: 'local' } } },
  {},
).config.endpoints[0];

const policy = (over: Partial<ProviderPolicy> = {}): ProviderPolicy => ({ repo: {}, user: {}, ...over });

describe('resolveProviderMode', () => {
  /*
   * P27-E1 — a developer with a Claude subscription loses money if we route
   * them silently. Routing is opt-in, never opt-out, and the default writes
   * nothing anywhere.
   */
  it('leaves an agent on its own vendor when nobody has said otherwise', () => {
    const d = resolveProviderMode('claude', policy(), {});
    expect(d.mode).toBe('vendor');
    expect(d.source).toBe('default');
  });

  it('honours a user setting over the default', () => {
    const d = resolveProviderMode('claude', policy({ user: { claude: 'gateway' } }), {});
    expect(d.mode).toBe('gateway');
    expect(d.source).toBe('user');
  });

  // P27-E6 — a company pins its own repos; it cannot reach a personal one,
  // because the repo policy travels in that repo's own config file.
  it('lets a repo policy win over a user setting', () => {
    const d = resolveProviderMode('claude', policy({ repo: { claude: 'gateway' }, user: { claude: 'vendor' } }), {});
    expect(d.mode).toBe('gateway');
    expect(d.source).toBe('repo');
  });

  it('decides each agent independently', () => {
    const p = policy({ repo: { claude: 'gateway' } });
    expect(resolveProviderMode('claude', p, {}).mode).toBe('gateway');
    expect(resolveProviderMode('codex', p, {}).mode).toBe('vendor');
  });

  /*
   * P27-E3 — Antigravity and Gemini cannot be pointed at a local model at all.
   * That is the vendors' decision, researched in reach.ts, and it outranks
   * anything anyone writes in a config: a repo that pins `gateway` for
   * Antigravity has asked for something impossible, and pretending to honour it
   * would produce a confusing agent error at launch instead of a clear answer
   * now.
   */
  it('reports an agent its vendor will not route as unavailable, with the reason', () => {
    const d = resolveProviderMode('antigravity', policy({ repo: { antigravity: 'gateway' } }), {});
    expect(d.mode).toBe('unavailable');
    expect(d.detail).toMatch(/antigravity/i);
    expect(d.detail.length).toBeGreaterThan(20); // a reason, not a shrug
  });

  it('treats an agent nobody has classified as unavailable rather than guessing', () => {
    expect(resolveProviderMode('some-custom-agent', policy({ user: { 'some-custom-agent': 'gateway' } }), {}).mode)
      .toBe('unavailable');
  });

  it('ignores a mode that is not one of the three', () => {
    const d = resolveProviderMode('claude', policy({ repo: { claude: 'sideways' as never } }), {});
    expect(d.mode).toBe('vendor');
    expect(d.source).toBe('default');
  });

  /*
   * P27-E4 — the developer already exports ANTHROPIC_BASE_URL in their shell.
   * That is an explicit act, and clobbering it would silently redirect an agent
   * they had deliberately pointed somewhere. Their env wins, and we say so.
   */
  it('does not clobber a base URL the developer exported themselves', () => {
    const d = resolveProviderMode('claude', policy({ repo: { claude: 'gateway' } }), {
      ANTHROPIC_BASE_URL: 'https://my-own-proxy.example',
    });
    expect(d.mode).toBe('vendor');
    expect(d.source).toBe('environment');
    expect(d.detail).toContain('ANTHROPIC_BASE_URL');
  });

  it('only yields to the variable that agent actually reads', () => {
    // codex reads the OpenAI pair; an exported ANTHROPIC_BASE_URL says nothing
    // about where codex is pointed.
    const d = resolveProviderMode('codex', policy({ repo: { codex: 'gateway' } }), {
      ANTHROPIC_BASE_URL: 'https://my-own-proxy.example',
    });
    expect(d.mode).toBe('gateway');
  });
});

/*
 * 🔴 The rule that must not be broken.
 */
describe('providerLaunchRefusal', () => {
  const gatewayMode = resolveProviderMode('claude', policy({ repo: { claude: 'gateway' } }), {});

  it('lets a healthy gateway through', () => {
    expect(providerLaunchRefusal(gatewayMode, GATEWAY, 'ok')).toBeNull();
  });

  it('REFUSES when the gateway did not answer — it never falls back to the vendor', () => {
    const refusal = providerLaunchRefusal(gatewayMode, GATEWAY, 'unreachable');
    expect(refusal).not.toBeNull();
    expect(refusal).toMatch(/refus|not run|will not/i);
    // The refusal has to say WHY, because "it failed" invites someone to
    // helpfully turn the fallback back on.
    expect(refusal).toMatch(/vendor|leave your network|off your network/i);
  });

  /*
   * An indeterminate probe is not permission. It is the same asymmetry as
   * everywhere else in this codebase: "we could not tell" must never resolve to
   * the option that sends code to a third party.
   */
  it('refuses on an unknown health too, because silence is not consent', () => {
    expect(providerLaunchRefusal(gatewayMode, GATEWAY, 'unknown')).not.toBeNull();
  });

  it('refuses when the credential was rejected', () => {
    expect(providerLaunchRefusal(gatewayMode, GATEWAY, 'unauthorized')).not.toBeNull();
  });

  /*
   * The subtler half of the same rule. "Gateway mode, and no gateway
   * configured" is not a healthy vendor launch — it is a developer who believes
   * their code is staying on the network with nothing whatsoever making that
   * true.
   */
  it('refuses when gateway mode is set but no endpoint is configured at all', () => {
    const refusal = providerLaunchRefusal(gatewayMode, null, 'ok');
    expect(refusal).not.toBeNull();
    expect(refusal).toMatch(/no endpoint|not configured/i);
  });

  it('never refuses a vendor-mode agent — that is the untouched path', () => {
    const vendor = resolveProviderMode('claude', policy(), {});
    expect(providerLaunchRefusal(vendor, null, 'unreachable')).toBeNull();
  });

  it('never refuses an unavailable agent, which was never going to be routed', () => {
    const unavailable = resolveProviderMode('gemini', policy({ repo: { gemini: 'gateway' } }), {});
    expect(providerLaunchRefusal(unavailable, null, 'unreachable')).toBeNull();
  });
});

describe('readProviderPolicy', () => {
  it('reads a config block that is not one as no policy', () => {
    expect(readProviderPolicy(null)).toEqual({});
    expect(readProviderPolicy({ providers: 'gateway' })).toEqual({});
    expect(readProviderPolicy({ providers: { claude: 7 } })).toEqual({});
  });

  it('keeps only the modes that mean something', () => {
    expect(readProviderPolicy({ providers: { claude: 'gateway', codex: 'vendor', gemini: 'nonsense' } }))
      .toEqual({ claude: 'gateway', codex: 'vendor' });
  });

  /*
   * `unavailable` is an OBSERVATION, not a setting. Letting a config declare it
   * would let someone disable an agent for a whole team by editing a file that
   * is supposed to describe routing, and it would drift from reach.ts the first
   * time a vendor changed its mind.
   */
  it('refuses to let a config declare an agent unavailable', () => {
    expect(readProviderPolicy({ providers: { claude: 'unavailable' } })).toEqual({});
  });
});

/*
 * 🔴 The rule, at the place it actually has to hold.
 *
 * `providerLaunchRefusal` returning a string is worth nothing if the launch
 * path drops it. And the failure mode here is silent by nature: returning "no
 * environment to inject" from a down gateway looks like a healthy vendor launch
 * to every caller — which IS the fallback P27 forbids, arriving as an absence
 * rather than as a decision.
 */
describe('endpointLaunchInjection under a provider policy', () => {
  const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), 'baton-policy-'));

  const withConfig = async (endpoints: unknown, providers?: unknown): Promise<string> => {
    const root = await tempRoot();
    await writeFile(join(root, 'baton.config.json'), JSON.stringify({ endpoints, ...(providers ? { providers } : {}) }, null, 2));
    return root;
  };

  const DOWN = { fleet: { kind: 'anthropic-compatible', url: 'http://127.0.0.1:1/v1', models: ['kimi-k2'], egress: 'local' } };

  it('refuses instead of returning an empty environment when the gateway is down', async () => {
    const root = await withConfig(DOWN, { claude: 'gateway' });
    const injection = await endpointLaunchInjection(root, 'claude', 'kimi-k2');
    expect(injection.refusal).toBeTruthy();
    expect(injection.refusal).toMatch(/off your network/i);
    // And nothing to inject, so a caller that ignored the refusal still would
    // not accidentally half-route the launch.
    expect(injection.env).toEqual({});
  });

  it('says nothing at all for a vendor-mode agent — the untouched path', async () => {
    const root = await withConfig(DOWN);
    const injection = await endpointLaunchInjection(root, 'claude', 'kimi-k2');
    expect(injection.refusal).toBeNull()
  });

  it('never refuses an agent the vendor forbids routing anyway', async () => {
    const root = await withConfig(DOWN, { antigravity: 'gateway' });
    expect((await endpointLaunchInjection(root, 'antigravity', 'kimi-k2')).refusal).toBeNull();
  });

  it('does not refuse when nothing is configured and nobody asked for a gateway', async () => {
    const root = await tempRoot();
    const injection = await endpointLaunchInjection(root, 'claude', 'kimi-k2');
    expect(injection.refusal).toBeNull();
    expect(injection.env).toEqual({});
  });
})
