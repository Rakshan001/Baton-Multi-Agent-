// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P16 step 1 — pointing an agent at your own server, per launch.
 *
 * The rule this file exists to hold: **per-launch environment only.** The
 * reference implementation we read (`.refs/IDE`) writes `ANTHROPIC_BASE_URL`
 * into `~/.claude/settings.json`, which re-points every Claude Code session on
 * the machine — turn it on for one Baton task and someone's unrelated work
 * starts hitting the gateway too. Nothing here may touch a file at all.
 */
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateEndpointsConfig } from '../src/endpoints/config.js';
import { endpointLaunchEnv } from '../src/endpoints/launch-env.js';
import { registerRuntimeSecret } from '../src/memory.js';
import { endpointLaunchInjection, interactiveLaunchEnv } from '../src/endpoints/live-endpoints.js';
import { writeFile } from 'node:fs/promises';
import { redactLine } from '../src/spawn.js';

const one = (ep: Record<string, unknown>, env: NodeJS.ProcessEnv = {}) =>
  validateEndpointsConfig({ endpoints: { fleet: ep } }, env).config.endpoints[0];

const ANTHROPIC = {
  kind: 'anthropic-compatible',
  url: 'https://gw.corp.internal:4000',
  models: ['kimi-k2'],
  keyRef: 'env:FLEET_KEY',
};

describe('endpointLaunchEnv', () => {
  it('points Claude Code at the gateway, with the credential it needs', () => {
    const env = endpointLaunchEnv(one(ANTHROPIC, { FLEET_KEY: 'k' }), 'anthropic-base-url', { FLEET_KEY: 'k' });
    expect(env).toEqual({ ANTHROPIC_BASE_URL: 'https://gw.corp.internal:4000', ANTHROPIC_API_KEY: 'k' });
  });

  it('lets an endpoint name the variable its gateway actually reads', () => {
    const ep = one({ ...ANTHROPIC, authEnv: 'ANTHROPIC_AUTH_TOKEN' }, { FLEET_KEY: 'k' });
    expect(endpointLaunchEnv(ep, 'anthropic-base-url', { FLEET_KEY: 'k' })).toEqual({
      ANTHROPIC_BASE_URL: 'https://gw.corp.internal:4000',
      ANTHROPIC_AUTH_TOKEN: 'k',
    });
  });

  it('sets both OpenAI base-url spellings, because CLIs disagree about which', () => {
    const ep = one({ kind: 'openai-compatible', url: 'https://gw/v1', models: ['x'], keyRef: 'env:FLEET_KEY' }, { FLEET_KEY: 'k' });
    expect(endpointLaunchEnv(ep, 'openai-base-url', { FLEET_KEY: 'k' })).toEqual({
      OPENAI_BASE_URL: 'https://gw/v1',
      OPENAI_API_BASE: 'https://gw/v1',
      OPENAI_API_KEY: 'k',
    });
  });

  /**
   * The plan's table says `native-model-string` injects nothing, on the reading
   * that `ollama/qwen3-coder` already carries the endpoint. It carries the
   * PROVIDER, not the HOST — so an Ollama box on another machine would be
   * silently talked past in favour of localhost, which is the exact
   * wrong-server failure the rest of this phase exists to prevent.
   */
  it('still tells a native-model-string agent WHICH ollama host', () => {
    const ep = one({ kind: 'ollama', url: 'http://gpu.corp.internal:11434', models: ['qwen3-coder'] });
    expect(endpointLaunchEnv(ep, 'native-model-string', {})).toEqual({
      OLLAMA_API_BASE: 'http://gpu.corp.internal:11434',
    });
  });

  it('injects nothing at all for an agent whose vendor allows no endpoint', () => {
    expect(endpointLaunchEnv(one(ANTHROPIC, { FLEET_KEY: 'k' }), null, { FLEET_KEY: 'k' })).toEqual({});
  });

  it('injects nothing when the agent cannot speak this endpoint dialect', () => {
    expect(endpointLaunchEnv(one(ANTHROPIC, { FLEET_KEY: 'k' }), 'openai-base-url', { FLEET_KEY: 'k' })).toEqual({});
  });

  // 🔴 Half an injection is worse than none: a base URL with no credential is
  // a call to your gateway that anyone on the network could have made.
  it('injects nothing — not even the base URL — when the key did not resolve', () => {
    expect(endpointLaunchEnv(one(ANTHROPIC, {}), 'anthropic-base-url', {})).toEqual({});
  });

  it('sets no auth variable for an endpoint that needs no credential', () => {
    const ep = one({ kind: 'openai-compatible', url: 'http://127.0.0.1:8000/v1', models: ['x'] });
    expect(endpointLaunchEnv(ep, 'openai-base-url', {})).toEqual({
      OPENAI_BASE_URL: 'http://127.0.0.1:8000/v1',
      OPENAI_API_BASE: 'http://127.0.0.1:8000/v1',
    });
  });

  // P16's hardest rule, and the one a reader will be tempted to "improve".
  it('never writes a file — not ~/.claude/settings.json, not anything', async () => {
    const home = await mkdtemp(join(tmpdir(), 'baton-home-'));
    const before = process.env.HOME;
    process.env.HOME = home;
    try {
      endpointLaunchEnv(one(ANTHROPIC, { FLEET_KEY: 'k' }), 'anthropic-base-url', { FLEET_KEY: 'k' });
      expect(await readdir(home)).toEqual([]);
    } finally {
      process.env.HOME = before;
    }
  });
});

// P16-E5 — the key reaches a child's environment, and an agent that echoes its
// own environment publishes onto the event bus, into the ring buffer, and out
// through GET /api/agents/running. Pattern matching cannot catch an arbitrary
// gateway key, so the value itself is registered at launch.
describe('the resolved key never survives into agent output', () => {
  it('redacts the exact value, whatever shape it has', () => {
    registerRuntimeSecret('h7Kq-corp-gateway-3f9a');
    expect(redactLine('curl -H "x-api-key: h7Kq-corp-gateway-3f9a" https://gw')).toContain('[redacted');
    expect(redactLine('nothing to see here')).toBe('nothing to see here');
  });

  it('ignores a value too short to be a credential, which would redact prose', () => {
    registerRuntimeSecret('a');
    expect(redactLine('a plain sentence')).toBe('a plain sentence');
  });
});

describe('endpointLaunchInjection — what a launcher actually receives', () => {
  const repo = async (endpoints: unknown): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'baton-inject-'));
    await writeFile(join(dir, 'baton.config.json'), JSON.stringify({ endpoints }), 'utf-8');
    return dir;
  };

  it('injects for a model one of your endpoints serves', async () => {
    const root = await repo({ fleet: { kind: 'anthropic-compatible', url: 'https://gw', models: ['kimi-k2'], keyRef: 'env:K' } });
    const out = await endpointLaunchInjection(root, 'claude', 'kimi-k2', { K: 'gw-key-abcdefgh' });
    expect(out.env.ANTHROPIC_BASE_URL).toBe('https://gw');
    expect(out.secret).toBe('gw-key-abcdefgh');
    expect(out.endpointId).toBe('fleet');
  });

  it('injects nothing for a vendor model, which is the ordinary case', async () => {
    const root = await repo({ fleet: { kind: 'anthropic-compatible', url: 'https://gw', models: ['kimi-k2'] } });
    expect((await endpointLaunchInjection(root, 'claude', 'opus', {})).env).toEqual({});
    expect((await endpointLaunchInjection(root, 'claude', undefined, {})).env).toEqual({});
  });

  it('reports no secret when the endpoint needs none', async () => {
    const root = await repo({ box: { kind: 'ollama', url: 'http://gpu:11434', models: ['qwen3-coder'] } });
    const out = await endpointLaunchInjection(root, 'aider', 'qwen3-coder', {});
    expect(out.env).toEqual({ OLLAMA_API_BASE: 'http://gpu:11434' });
    expect(out.secret).toBeNull();
  });
});

describe('interactiveLaunchEnv', () => {
  it('passes a base URL through — a terminal may carry that', () => {
    const out = interactiveLaunchEnv({ env: { OLLAMA_API_BASE: 'http://gpu:11434' }, secret: null, endpointId: 'box' }, 'aider');
    expect('env' in out && out.env).toEqual({ OLLAMA_API_BASE: 'http://gpu:11434' });
  });

  // 🔴 tmux turns every variable into a shell prefix on the agent's own command
  // line, and `ps` is readable by everyone on the machine.
  it('refuses to put a credential on a command line', () => {
    const out = interactiveLaunchEnv({ env: { OPENAI_API_KEY: 'k' }, secret: 'k', endpointId: 'fleet' }, 'aider');
    expect('refuse' in out && out.refuse).toContain('command line');
    expect('refuse' in out && out.refuse).toContain('fleet');
  });
});
