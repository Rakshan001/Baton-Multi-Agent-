// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P15 — the `endpoints` block of `baton.config.json`.
 *
 * Same rule as the executor block: validated on its own, never able to reject
 * the file. The extra weight here is that this block is the only one that
 * touches a credential, so two of its refusals are security refusals rather
 * than typo handling — a literal key never loads, and a key that resolves to
 * nothing never leaves an endpoint looking usable.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENDPOINTS_CONFIG,
  endpointForModel,
  shadowedModels,
  validateEndpointsConfig,
} from '../src/endpoints/config.js';
import { endpointDoctorLines } from '../src/endpoints/doctor-report.js';
import { validateExecutorConfig } from '../src/executors/config.js';

const FLEET = {
  kind: 'anthropic-compatible',
  url: 'https://gw.corp.internal:4000',
  models: ['kimi-k2', 'qwen3-coder', 'glm-4.6'],
  health: '/health',
  keyRef: 'env:BATON_FLEET_KEY',
};

const withKey = { BATON_FLEET_KEY: 'sk-live-not-a-real-key' } as NodeJS.ProcessEnv;

describe('validateEndpointsConfig', () => {
  it('defaults to no endpoints when the file has no endpoints block', () => {
    const { config, errors } = validateEndpointsConfig({ routing: { mode: 'auto' } }, {});
    expect(config).toEqual(DEFAULT_ENDPOINTS_CONFIG);
    expect(errors).toEqual([]);
  });

  it('reads the documented block', () => {
    const { config, errors } = validateEndpointsConfig({ endpoints: { fleet: FLEET } }, withKey);
    expect(errors).toEqual([]);
    expect(config.endpoints).toEqual([{
      id: 'fleet',
      kind: 'anthropic-compatible',
      url: 'https://gw.corp.internal:4000',
      models: ['kimi-k2', 'qwen3-coder', 'glm-4.6'],
      health: '/health',
      keyRef: 'env:BATON_FLEET_KEY',
      authEnv: null,
      gateway: null,
      egress: null,
      usable: true,
      unusable: null,
    }]);
  });

  it('defaults health to /health and keyRef to none', () => {
    const { config } = validateEndpointsConfig(
      { endpoints: { local: { kind: 'ollama', url: 'http://127.0.0.1:11434', models: ['qwen3-coder'] } } },
      {},
    );
    // A local runtime with no credential is a normal, usable endpoint — the
    // absence of a key is only a problem when a keyRef was written and failed.
    expect(config.endpoints[0]).toMatchObject({ health: '/health', keyRef: null, usable: true });
  });

  // P15-E1
  it('ignores a malformed endpoints block without disarming routing or executor', () => {
    const file = { endpoints: 'https://gw', executor: { backend: 'orca' }, routing: { mode: 'auto' } };
    const { config, errors } = validateEndpointsConfig(file, {});
    expect(config.endpoints).toEqual([]);
    expect(errors[0]).toContain('endpoints:');
    // The point of validating separately, asserted rather than asserted about.
    expect(validateExecutorConfig(file).config.backend).toBe('orca');
  });

  it('drops one bad endpoint and keeps its siblings', () => {
    const { config, errors } = validateEndpointsConfig(
      { endpoints: { broken: { kind: 'ollama' }, fleet: FLEET } },
      withKey,
    );
    expect(config.endpoints.map((e) => e.id)).toEqual(['fleet']);
    expect(errors.some((e) => e.includes('broken'))).toBe(true);
  });

  // P15-E2 — the one that decides whether a gateway anyone can bill you on
  // gets called without a credential.
  it('marks an endpoint unusable, with the reason, when its keyRef resolves to nothing', () => {
    const { config, errors } = validateEndpointsConfig({ endpoints: { fleet: FLEET } }, {});
    expect(config.endpoints[0]).toMatchObject({ id: 'fleet', usable: false });
    expect(config.endpoints[0].unusable).toContain('BATON_FLEET_KEY');
    expect(errors.some((e) => e.includes('BATON_FLEET_KEY'))).toBe(true);
  });

  it('treats an empty env var as unset, never as a key', () => {
    const { config } = validateEndpointsConfig({ endpoints: { fleet: FLEET } }, { BATON_FLEET_KEY: '  ' });
    expect(config.endpoints[0].usable).toBe(false);
  });

  // P15-E3 — refuse to load, name the field, point at keyRef.
  it('refuses an endpoint carrying a literal key and never echoes the value', () => {
    const secret = 'sk-live-abcdef0123456789';
    const { config, errors } = validateEndpointsConfig(
      { endpoints: { fleet: { ...FLEET, key: secret } } },
      withKey,
    );
    expect(config.endpoints).toEqual([]);
    expect(errors.join('\n')).toContain('fleet.key');
    expect(errors.join('\n')).toContain('keyRef');
    expect(errors.join('\n')).not.toContain(secret);
  });

  it('refuses every spelling of a literal key field', () => {
    for (const field of ['key', 'apiKey', 'api_key', 'token', 'secret', 'password']) {
      const { config, errors } = validateEndpointsConfig(
        { endpoints: { fleet: { ...FLEET, [field]: 'literal' } } },
        withKey,
      );
      expect(config.endpoints, field).toEqual([]);
      expect(errors.join('\n'), field).toContain(`fleet.${field}`);
    }
  });

  it('refuses a credential smuggled into the url', () => {
    for (const url of [
      'https://user:pass@gw.corp.internal',
      'https://gw.corp.internal/v1?api_key=sk-live-abc',
      'https://gw.corp.internal/v1?access_token=abc',
    ]) {
      const { config, errors } = validateEndpointsConfig({ endpoints: { fleet: { ...FLEET, url } } }, withKey);
      expect(config.endpoints, url).toEqual([]);
      expect(errors.join('\n'), url).toContain('fleet.url');
      expect(errors.join('\n'), url).not.toContain('sk-live-abc');
    }
  });

  it('refuses a keyRef that is the key itself rather than a reference to one', () => {
    const { config, errors } = validateEndpointsConfig(
      { endpoints: { fleet: { ...FLEET, keyRef: 'sk-live-abcdef0123456789' } } },
      withKey,
    );
    expect(config.endpoints).toEqual([]);
    expect(errors.join('\n')).toContain('fleet.keyRef');
    expect(errors.join('\n')).not.toContain('sk-live-abcdef0123456789');
  });

  it('names keychain: as not supported yet rather than calling it a literal key', () => {
    const { config, errors } = validateEndpointsConfig(
      { endpoints: { fleet: { ...FLEET, keyRef: 'keychain:baton/fleet' } } },
      withKey,
    );
    // Kept and named, because doctor listing an unusable endpoint is more
    // useful than doctor being silent about one that was configured.
    expect(config.endpoints[0]).toMatchObject({ id: 'fleet', usable: false });
    expect(config.endpoints[0].unusable).toContain('env:');
    expect(errors.join('\n')).toContain('keychain');
  });

  it('refuses an authEnv that is a key rather than the name of one', () => {
    const { config, errors } = validateEndpointsConfig(
      { endpoints: { fleet: { ...FLEET, authEnv: 'sk-live-abcdef0123456789' } } },
      withKey,
    );
    expect(config.endpoints[0].authEnv).toBeNull();
    expect(errors.join('\n')).toContain('fleet.authEnv');
  });

  it('refuses an unknown kind rather than guessing the dialect', () => {
    const { config, errors } = validateEndpointsConfig(
      { endpoints: { fleet: { ...FLEET, kind: 'openai' } } },
      withKey,
    );
    expect(config.endpoints).toEqual([]);
    expect(errors.join('\n')).toContain('fleet.kind');
  });

  it('refuses a url that is not http(s)', () => {
    for (const url of ['file:///etc/passwd', 'ftp://gw', 'gw.corp.internal', '']) {
      const { config } = validateEndpointsConfig({ endpoints: { fleet: { ...FLEET, url } } }, withKey);
      expect(config.endpoints, url).toEqual([]);
    }
  });

  it('keeps an endpoint whose models list is missing — P17 fills it from the gateway', () => {
    const { config, errors } = validateEndpointsConfig(
      { endpoints: { fleet: { kind: 'ollama', url: 'http://127.0.0.1:11434' } } },
      {},
    );
    expect(config.endpoints[0]).toMatchObject({ models: [], usable: true });
    expect(errors).toEqual([]);
  });

  it('reports a models list of the wrong type instead of silently serving it', () => {
    const { config, errors } = validateEndpointsConfig(
      { endpoints: { fleet: { ...FLEET, models: 'kimi-k2' } } },
      withKey,
    );
    expect(config.endpoints[0].models).toEqual([]);
    expect(errors.join('\n')).toContain('fleet.models');
  });

  it('refuses an integer-like id, whose declaration order JSON does not preserve', () => {
    const { config, errors } = validateEndpointsConfig(
      { endpoints: { '2': FLEET, fleet: FLEET } },
      withKey,
    );
    expect(config.endpoints.map((e) => e.id)).toEqual(['fleet']);
    expect(errors.join('\n')).toContain('order');
  });
});

// P15-E4
describe('two endpoints serving the same model', () => {
  const both = {
    endpoints: {
      fleet: { kind: 'anthropic-compatible', url: 'https://a', models: ['kimi-k2', 'glm-4.6'] },
      spare: { kind: 'anthropic-compatible', url: 'https://b', models: ['kimi-k2'] },
    },
  };

  it('picks the first declaration, every time', () => {
    const { config } = validateEndpointsConfig(both, {});
    expect(endpointForModel(config, 'kimi-k2')?.id).toBe('fleet');
    expect(endpointForModel(config, 'glm-4.6')?.id).toBe('fleet');
    expect(endpointForModel(config, 'opus')).toBeNull();
  });

  it('reports the shadowing rather than picking silently', () => {
    const { config } = validateEndpointsConfig(both, {});
    expect(shadowedModels(config)).toEqual([{ model: 'kimi-k2', winner: 'fleet', shadowedBy: ['spare'] }]);
  });

  // Precedence is declaration order and nothing else. Reordering because a key
  // failed to resolve would make which server runs your code depend on the
  // shell the daemon happened to start in.
  it('does not promote a usable endpoint over an unusable one that was declared first', () => {
    const { config } = validateEndpointsConfig(
      {
        endpoints: {
          fleet: { ...both.endpoints.fleet, keyRef: 'env:MISSING_KEY' },
          spare: both.endpoints.spare,
        },
      },
      {},
    );
    expect(endpointForModel(config, 'kimi-k2')?.id).toBe('fleet');
    expect(endpointForModel(config, 'kimi-k2')?.usable).toBe(false);
  });
});

describe('allowPaidFallback', () => {
  it('is off unless it was written down', () => {
    expect(validateEndpointsConfig({ endpoints: { fleet: FLEET } }, withKey).config.allowPaidFallback).toBe(false);
    expect(validateEndpointsConfig({}, {}).config.allowPaidFallback).toBe(false);
  });

  it('reads true, and is not mistaken for an endpoint', () => {
    const { config, errors } = validateEndpointsConfig(
      { endpoints: { allowPaidFallback: true, fleet: FLEET } },
      withKey,
    );
    expect(config.allowPaidFallback).toBe(true);
    expect(config.endpoints.map((e) => e.id)).toEqual(['fleet']);
    expect(errors).toEqual([]);
  });

  // The default is the cost-safety default. A non-boolean must not read as on.
  it('stays off when it is not a boolean, and says so', () => {
    const { config, errors } = validateEndpointsConfig({ endpoints: { allowPaidFallback: 'yes' } }, {});
    expect(config.allowPaidFallback).toBe(false);
    expect(errors.join('\n')).toContain('allowPaidFallback');
  });
});

// P15 step 3 — what `baton doctor` prints. This is the command someone runs
// when it does not work, so the lines are tested rather than eyeballed.
describe('endpointDoctorLines', () => {
  const lines = (raw: unknown, env: NodeJS.ProcessEnv = {}): string => {
    const { config, errors } = validateEndpointsConfig(raw, env);
    return endpointDoctorLines(config, errors).join('\n');
  };

  it('says nothing at all when no endpoints are configured', () => {
    expect(endpointDoctorLines(DEFAULT_ENDPOINTS_CONFIG, [])).toEqual([]);
  });

  it('answers the whole question in one section', () => {
    const out = lines({ endpoints: { fleet: FLEET } }, withKey);
    expect(out).toContain('fleet');
    expect(out).toContain('anthropic-compatible');
    expect(out).toContain('https://gw.corp.internal:4000');
    expect(out).toContain('kimi-k2');
    expect(out).toContain('env:BATON_FLEET_KEY');
    expect(out).toContain('claude');
  });

  // 🔴 The report names the reference, never what it resolved to.
  it('never prints the key it resolved', () => {
    expect(lines({ endpoints: { fleet: FLEET } }, withKey)).not.toContain('sk-live-not-a-real-key');
  });

  it('names an unusable endpoint as unusable, with the reason and the fix', () => {
    const out = lines({ endpoints: { fleet: FLEET } }, {});
    expect(out).toContain('BATON_FLEET_KEY is not set');
    expect(out).toContain('unusable');
  });

  // The unusable state is already rendered under the endpoint. Repeating it
  // as a bare error makes a two-endpoint report look like four problems.
  it('does not say the same thing twice about an endpoint it already marked', () => {
    const out = lines({ endpoints: { fleet: FLEET } }, {});
    expect(out.match(/BATON_FLEET_KEY is not set/g)).toHaveLength(1);
  });

  it('reports shadowing rather than leaving the pick invisible', () => {
    const out = lines({
      endpoints: {
        fleet: { kind: 'ollama', url: 'http://a', models: ['qwen3-coder'] },
        spare: { kind: 'ollama', url: 'http://b', models: ['qwen3-coder'] },
      },
    });
    expect(out).toContain('qwen3-coder');
    expect(out).toContain('spare');
  });

  it('surfaces the config errors here too — this is where someone is looking', () => {
    expect(lines({ endpoints: { fleet: { ...FLEET, kind: 'openai' } } }, withKey)).toContain('fleet.kind');
  });

  // The second question, answered before it is asked.
  it('says which agents stay on their vendors, so a mixed fleet is not a surprise', () => {
    const out = lines({ endpoints: { fleet: FLEET } }, withKey);
    for (const agent of ['cursor', 'antigravity', 'gemini']) expect(out, agent).toContain(agent);
  });
});
