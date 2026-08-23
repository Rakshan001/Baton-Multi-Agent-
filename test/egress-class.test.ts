// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Does a model run on hardware the customer owns, or does their code leave the
 * network to reach it?
 *
 * This is the load-bearing question of the whole product. If you sell "your code
 * never leaves your network" and some models do leave, a developer who cannot
 * tell which is which is the exact confusion the product exists to prevent.
 *
 * Two rules, and the second is what makes it honest:
 *
 *   1. The ENDPOINT decides, never the model's name. `gpt-4o` served by a
 *      customer's own vLLM is local; a model called `local-llama` behind
 *      someone's cloud proxy is external. A name is a string a vendor chose.
 *   2. Never guess `local`. Mislabelling external as local puts code on a third
 *      party's servers under a badge that says otherwise; mislabelling local as
 *      unknown costs an admin one line of config. The asymmetry is the design.
 */
import { describe, expect, it } from 'vitest';
import { validateEndpointsConfig } from '../src/endpoints/config.js';
import { classifyEgress } from '../src/endpoints/egress.js';

const at = (url: string, extra: Record<string, unknown> = {}) =>
  validateEndpointsConfig(
    { endpoints: { e: { kind: 'openai-compatible', url, models: ['m'], ...extra } } },
    {},
  ).config.endpoints[0];

describe('classifyEgress', () => {
  it('calls loopback local — the machine is the customer, definitionally', () => {
    for (const url of ['http://127.0.0.1:11434', 'http://localhost:4000', 'http://[::1]:8000']) {
      expect(classifyEgress(at(url)), url).toBe('local');
    }
  });

  it('calls a private-range address local', () => {
    for (const url of [
      'http://10.0.0.5:4000',
      'http://192.168.1.20:11434',
      'http://172.16.4.9/v1',
      'http://172.31.255.254/v1',
    ]) {
      expect(classifyEgress(at(url)), url).toBe('local');
    }
  });

  // 172.32 is outside the private block, and one octet is the whole difference.
  it('does not mistake a public address that merely looks private', () => {
    for (const url of ['http://172.32.0.1/v1', 'http://11.0.0.1/v1', 'http://192.169.1.1/v1']) {
      expect(classifyEgress(at(url)), url).toBe('external');
    }
  });

  it('calls an internal-only domain suffix local', () => {
    for (const url of [
      'https://gw.corp.internal:4000',
      'http://gpu.lan:11434',
      'https://router.home.arpa',
    ]) {
      expect(classifyEgress(at(url)), url).toBe('local');
    }
  });

  it('calls a public host external', () => {
    for (const url of ['https://api.openai.com/v1', 'https://gateway.example.com/v1']) {
      expect(classifyEgress(at(url)), url).toBe('external');
    }
  });

  // 🔴 A single-label host is probably internal DNS — and "probably" is exactly
  // what this classifier is not allowed to do.
  it('answers unknown for a bare hostname rather than assuming the intranet', () => {
    expect(classifyEgress(at('http://gpu:11434'))).toBe('unknown');
    expect(classifyEgress(at('http://gateway/v1'))).toBe('unknown');
  });

  it('lets an admin declare what inference cannot prove', () => {
    expect(classifyEgress(at('http://gpu:11434', { egress: 'local' }))).toBe('local');
    // And a declaration can go the other way: a private-looking address that is
    // really a tunnel to somewhere else.
    expect(classifyEgress(at('http://127.0.0.1:4000', { egress: 'external' }))).toBe('external');
  });

  it('ignores the model name entirely, in both directions', () => {
    const ownServer = validateEndpointsConfig(
      { endpoints: { e: { kind: 'openai-compatible', url: 'http://192.168.1.9/v1', models: ['gpt-4o', 'claude-opus-4'] } } },
      {},
    ).config.endpoints[0];
    expect(classifyEgress(ownServer)).toBe('local');

    const cloud = at('https://cheap-proxy.example.com/v1');
    expect(classifyEgress(cloud)).toBe('external');
  });
});
