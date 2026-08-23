// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * 🔴 Found by review, confirmed by running it: the probe built its request as
 * `url + health`, and a `health` of `"@evil.example/v1"` turns
 * `https://gw.corp.internal:4000@evil.example/v1` into a request to
 * **evil.example**, with the gateway host demoted to userinfo — carrying the
 * key in `x-api-key`.
 *
 * Two controls this file's fix restores:
 *
 *   1. `checkUrl` refuses credentials in the URL, but never saw the CONCATENATED
 *      string, so the refusal was bypassable by moving the payload one field
 *      across.
 *   2. `classifyEgress` reads `url`, so the pane badged the endpoint "On your
 *      network" while the keyed request left it. A wrong badge here is the one
 *      failure the whole product is sold against.
 *
 * `baton.config.json` is committed, so this is reachable by anyone who can land
 * a config change in a customer's repo.
 */
import { describe, expect, it } from 'vitest';
import { validateEndpointsConfig } from '../src/endpoints/config.js';
import { probeUrlFor } from '../src/endpoints/health.js';

const endpoint = (extra: Record<string, unknown>) =>
  validateEndpointsConfig(
    { endpoints: { fleet: { kind: 'openai-compatible', url: 'https://gw.corp.internal:4000', models: ['m'], ...extra } } },
    {},
  );

describe('the health path cannot move the request to another host', () => {
  it('refuses a health path that would change the origin', () => {
    const { config, errors } = endpoint({ health: '@evil.example/v1' });
    expect(config.endpoints[0].health).toBe('/health');
    expect(errors.join('\n')).toContain('fleet.health');
  });

  it('refuses every shape that is not a plain absolute path', () => {
    for (const health of ['@evil.example/v1', 'https://evil.example', '//evil.example/x', 'health', '']) {
      const { config } = endpoint({ health });
      expect(config.endpoints[0].health, JSON.stringify(health)).toBe('/health');
    }
  });

  it('keeps an ordinary path', () => {
    expect(endpoint({ health: '/v1/health' }).config.endpoints[0].health).toBe('/v1/health');
  });

  // Defence at the sink as well as at the door: even a stored value that got
  // past validation must not be able to redirect the keyed request.
  it('builds a probe URL that cannot leave the endpoint origin', () => {
    const ep = endpoint({ health: '/health' }).config.endpoints[0];
    expect(probeUrlFor(ep)).toBe('https://gw.corp.internal:4000/health');

    // Resolved as a relative path, this stays on the gateway. Concatenated, it
    // used to become a request to evil.example — that is the whole bug.
    const relative = probeUrlFor({ ...ep, health: '@evil.example/v1' });
    expect(relative).not.toBeNull();
    expect(new URL(relative!).origin).toBe('https://gw.corp.internal:4000');
    expect(`https://gw.corp.internal:4000` + '@evil.example/v1').not.toBe(relative);

    // An absolute URL genuinely escapes, and must be refused outright.
    expect(probeUrlFor({ ...ep, health: 'https://evil.example/x' })).toBeNull();
  });
});

describe('a credential anywhere in the URL refuses the endpoint', () => {
  // The old check looked at userinfo and query params only, so a key parked in
  // a PATH segment loaded — and this phase then published `url` to the pane and
  // the phone.
  it('refuses a key in a path segment', () => {
    const { config, errors } = validateEndpointsConfig(
      { endpoints: { fleet: { kind: 'openai-compatible', url: 'https://gw.corp.internal/proxy/sk-ant-api03-abcdefghijklmnopqrstuvwx/v1', models: ['m'] } } },
      {},
    );
    expect(config.endpoints).toEqual([]);
    expect(errors.join('\n')).toContain('fleet.url');
    expect(errors.join('\n')).not.toContain('sk-ant-api03');
  });

  it('still accepts an ordinary URL with path segments', () => {
    const { config } = validateEndpointsConfig(
      { endpoints: { fleet: { kind: 'openai-compatible', url: 'https://gw.corp.internal/openai/v1', models: ['m'] } } },
      {},
    );
    expect(config.endpoints).toHaveLength(1);
  });
});
