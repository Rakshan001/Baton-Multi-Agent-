// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P18 — how ten laptops get pointed at the company's models without ten people
 * hand-typing a gateway URL and pasting a key.
 *
 * Baton already has this flow: `baton member add` mints a token, the developer
 * runs `baton join --token`, and it lands 0600. Enrollment is that flow carrying
 * one more payload, so the risky part is not the plumbing — it is what the
 * payload is allowed to contain.
 *
 * The rule the whole phase turns on (P18-E1): **the shared gateway key is never
 * in it.** Ship the company key to ten laptops and revoking one developer means
 * re-keying the company, which means nobody ever revokes anybody.
 */
import { mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEndpointsConfig, validateEndpointsConfig } from '../src/endpoints/config.js';
import { resolveEndpointKey } from '../src/endpoints/launch-env.js';
import {
  applyEnrollment,
  buildEnrollment,
  mergeManagedEndpoints,
  readEnrollmentPayload,
  type EnrollmentPayload,
} from '../src/endpoints/enrollment.js';
import {
  loadManagedCredentials,
  managedEnvName,
  saveManagedCredentials,
  managedCredentialsPath,
  withManagedEnv,
} from '../src/endpoints/managed-credentials.js';
import { loadIssuedKeys, recordIssuedKey, takeIssuedKeys } from '../src/endpoints/issued-keys.js';

const SHARED_KEY = 'sk-company-shared-9f3a2b7c1d';
const MEMBER_KEY = 'sk-member-priya-4e8d0a6b2f';

const HOST_CONFIG = {
  endpoints: {
    fleet: {
      kind: 'openai-compatible',
      url: 'https://gw.corp.internal/v1',
      models: ['qwen3-coder', 'gpt-4o'],
      keyRef: 'env:GW_KEY',
      gateway: 'omniroute',
      egress: 'local',
    },
    workstation: {
      kind: 'ollama',
      url: 'http://192.168.1.9:11434',
      models: ['devstral'],
    },
  },
};

const hostConfig = () => validateEndpointsConfig(HOST_CONFIG, { GW_KEY: SHARED_KEY }).config;

const mintsFor = (endpointId: string) =>
  async (id: string) =>
    id === endpointId ? { value: MEMBER_KEY, expiresAt: '2026-09-23T00:00:00.000Z' } : null;

const mintsNothing = async () => null;

const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), 'baton-enroll-'));

describe('buildEnrollment', () => {
  // 🔴 P18-E1 — the finding that matters more than every other line here.
  it('never carries the company key, in any field', async () => {
    const payload = await buildEnrollment(hostConfig(), 'priya', mintsFor('fleet'));
    const wire = JSON.stringify(payload);
    expect(wire).not.toContain(SHARED_KEY);
    // Not the name of the host's variable either: it is the host's private
    // arrangement, and publishing it tells ten laptops what to go looking for.
    expect(wire).not.toContain('GW_KEY');
    expect(wire).toContain(MEMBER_KEY); // the member's OWN credential, which is the point
  });

  it('marks every published endpoint managed, so refresh knows what it owns', async () => {
    const payload = await buildEnrollment(hostConfig(), 'priya', mintsFor('fleet'));
    expect(payload.endpoints).toHaveLength(2);
    expect(payload.endpoints.every((e) => e.managed === true)).toBe(true);
    expect(payload.endpoints.map((e) => e.id)).toEqual(['fleet', 'workstation']);
  });

  it('points a managed endpoint at the variable Baton fills from its own store', async () => {
    const payload = await buildEnrollment(hostConfig(), 'priya', mintsFor('fleet'));
    const fleet = payload.endpoints.find((e) => e.id === 'fleet')!;
    expect(fleet.keyRef).toBe(`env:${managedEnvName('fleet')}`);
    // Ollama needs no credential, so it is not handed a reference to one.
    expect(payload.endpoints.find((e) => e.id === 'workstation')!.keyRef).toBeNull();
  });

  /*
   * 🔴 The tempting bug: the gateway cannot mint per-member keys, so fall back
   * to the shared one "just this once". That is exactly P18-E1, and it would
   * arrive wearing a reasonable-sounding justification.
   */
  it('says the endpoint needs a key rather than falling back to the shared one', async () => {
    const payload = await buildEnrollment(hostConfig(), 'priya', mintsNothing);
    expect(JSON.stringify(payload)).not.toContain(SHARED_KEY);
    const fleet = payload.endpoints.find((e) => e.id === 'fleet')!;
    expect(fleet.keyRef).toBe(`env:${managedEnvName('fleet')}`);
    expect(payload.credentials).toEqual([]);
    // And it must SAY so, because an endpoint that silently does not work is
    // the support ticket this phase exists to avoid.
    expect(payload.notes.join(' ')).toMatch(/could not issue a credential/i);
    expect(payload.notes.join(' ')).toContain('fleet');
  });

  it('does not try to mint against a runtime with no admin surface (GW-E7)', async () => {
    const asked: string[] = [];
    await buildEnrollment(hostConfig(), 'priya', async (id) => {
      asked.push(id);
      return null;
    });
    // `workstation` declares no gateway, so there is nobody to ask for a key.
    expect(asked).toEqual(['fleet']);
  });
});

describe('readEnrollmentPayload', () => {
  it('reads a payload that is not one as nothing', () => {
    expect(readEnrollmentPayload(null)).toBeNull();
    expect(readEnrollmentPayload({ version: 99, endpoints: [] })).toBeNull();
    expect(readEnrollmentPayload({ version: 1, endpoints: 'no' })).toBeNull();
  });

  /*
   * This arrives over the network and is about to be written into a config file
   * that decides where the company's code is sent. It gets less trust, not
   * more — the same rule `fetchManifest` applies before a clone.
   */
  it('drops an endpoint whose URL is not one, rather than writing it', () => {
    const payload = readEnrollmentPayload({
      version: 1,
      endpoints: [
        { id: 'good', kind: 'openai-compatible', url: 'https://gw.corp.internal/v1', managed: true },
        { id: 'bad', kind: 'openai-compatible', url: 'file:///etc/passwd', managed: true },
        { id: 'worse', kind: 'nonsense', url: 'https://gw/v1', managed: true },
      ],
      credentials: [],
      notes: [],
    });
    expect(payload!.endpoints.map((e) => e.id)).toEqual(['good']);
  });

  it('refuses a payload that tries to smuggle a literal key into the block', () => {
    const payload = readEnrollmentPayload({
      version: 1,
      endpoints: [
        { id: 'fleet', kind: 'openai-compatible', url: 'https://gw/v1', managed: true, keyRef: 'sk-live-abc123def456' },
      ],
      credentials: [],
      notes: [],
    });
    // A keyRef is a reference; a value there would be written into a file that
    // gets committed.
    expect(payload!.endpoints[0]?.keyRef ?? null).toBeNull();
  });
});

describe('mergeManagedEndpoints', () => {
  // P18-E3 — a developer may have their own endpoint and the company's.
  it('leaves a personal endpoint completely alone', () => {
    const local = {
      mine: { kind: 'ollama', url: 'http://127.0.0.1:11434', models: ['llama3'] },
      fleet: { kind: 'openai-compatible', url: 'http://stale.example/v1', managed: true },
      allowPaidFallback: true,
    };
    const merged = mergeManagedEndpoints(local, [
      { id: 'fleet', kind: 'openai-compatible', url: 'https://gw.corp.internal/v1', models: ['gpt-4o'], health: '/health', keyRef: null, authEnv: null, gateway: 'omniroute', egress: 'local', managed: true },
    ]);
    expect(merged.mine).toEqual(local.mine);
    expect(merged.allowPaidFallback).toBe(true);
    expect((merged.fleet as { url: string }).url).toBe('https://gw.corp.internal/v1');
  });

  it('removes a managed endpoint the company stopped publishing', () => {
    const local = {
      retired: { kind: 'openai-compatible', url: 'https://old/v1', managed: true },
      mine: { kind: 'ollama', url: 'http://127.0.0.1:11434' },
    };
    const merged = mergeManagedEndpoints(local, []);
    expect(merged.retired).toBeUndefined();
    expect(merged.mine).toBeDefined();
  });

  /*
   * The other half of E3: "not editable locally" cannot mean a file the user
   * cannot write — it is their disk. It means refresh is authoritative, so a
   * local edit to a managed entry is replaced rather than merged. Saying that
   * plainly beats pretending we can lock a JSON file.
   */
  it('replaces a locally edited managed entry instead of merging into it', () => {
    const local = {
      fleet: { kind: 'openai-compatible', url: 'https://gw/v1', managed: true, egress: 'local', models: ['sneaky'] },
    };
    const merged = mergeManagedEndpoints(local, [
      { id: 'fleet', kind: 'openai-compatible', url: 'https://gw/v1', models: ['gpt-4o'], health: '/health', keyRef: null, authEnv: null, gateway: 'omniroute', egress: null, managed: true },
    ]);
    const fleet = merged.fleet as Record<string, unknown>;
    expect(fleet.models).toEqual(['gpt-4o']);
    // The local `egress: "local"` claim is gone: an employee must not be able
    // to re-badge a company endpoint as "on your network".
    expect(fleet.egress).toBeUndefined();
  });
});

describe('applyEnrollment', () => {
  const payload = (over: Partial<EnrollmentPayload> = {}): EnrollmentPayload => ({
    version: 1,
    endpoints: [
      { id: 'fleet', kind: 'openai-compatible', url: 'https://gw.corp.internal/v1', models: ['gpt-4o'], health: '/health', keyRef: `env:${managedEnvName('fleet')}`, authEnv: null, gateway: 'omniroute', egress: 'local', managed: true },
    ],
    credentials: [{ endpointId: 'fleet', value: MEMBER_KEY, expiresAt: '2026-09-23T00:00:00.000Z' }],
    notes: [],
    ...over,
  });

  it('writes an endpoints block the loader can actually use', async () => {
    const root = await tempRoot();
    await applyEnrollment(root, payload());

    const written = JSON.parse(await readFile(join(root, 'baton.config.json'), 'utf-8'));
    const creds = await loadManagedCredentials(root);
    const { config, errors } = validateEndpointsConfig(written, { ...creds });
    expect(errors).toEqual([]);
    expect(config.endpoints[0].usable).toBe(true);
    expect(config.endpoints[0].url).toBe('https://gw.corp.internal/v1');
  });

  // 🔴 The credential must not land in the file that gets committed.
  it('keeps the credential out of baton.config.json, at 0600 in its own store', async () => {
    const root = await tempRoot();
    await applyEnrollment(root, payload());

    const configText = await readFile(join(root, 'baton.config.json'), 'utf-8');
    expect(configText).not.toContain(MEMBER_KEY);
    expect(await loadManagedCredentials(root)).toEqual({ [managedEnvName('fleet')]: MEMBER_KEY });
    const mode = (await stat(managedCredentialsPath(root))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('keeps a personal endpoint through a refresh', async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, 'baton.config.json'),
      JSON.stringify({ endpoints: { mine: { kind: 'ollama', url: 'http://127.0.0.1:11434' } } }, null, 2),
    );
    await applyEnrollment(root, payload());

    const written = JSON.parse(await readFile(join(root, 'baton.config.json'), 'utf-8'));
    expect(written.endpoints.mine).toBeDefined();
    expect(written.endpoints.fleet).toBeDefined();
  });

  it('does not disturb the rest of baton.config.json', async () => {
    const root = await tempRoot();
    await writeFile(
      join(root, 'baton.config.json'),
      JSON.stringify({ routing: { tiers: { local: [{ agent: 'aider' }] } }, endpoints: {} }, null, 2),
    );
    await applyEnrollment(root, payload());
    const written = JSON.parse(await readFile(join(root, 'baton.config.json'), 'utf-8'));
    expect(written.routing).toEqual({ tiers: { local: [{ agent: 'aider' }] } });
  });

  /*
   * P18-E6 — the host was offline, or answered something that is not an
   * enrollment. A half-written endpoints block is worse than none: it points a
   * developer at a gateway with no credential and reads as a broken install
   * rather than a failed join.
   */
  it('writes nothing at all when there is no usable payload', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'baton.config.json'), JSON.stringify({ endpoints: { mine: { kind: 'ollama', url: 'http://127.0.0.1:11434' } } }));
    const before = await readFile(join(root, 'baton.config.json'), 'utf-8');

    await expect(applyEnrollment(root, readEnrollmentPayload({ version: 99 }))).rejects.toThrow();

    expect(await readFile(join(root, 'baton.config.json'), 'utf-8')).toBe(before);
    await expect(stat(managedCredentialsPath(root))).rejects.toThrow();
  });
});

/*
 * P18-E2 / P18-E4 — a developer leaves, or the company rotates the key.
 *
 * There is no remote wipe and this must never imply one. What actually happens
 * is that the cached config on their laptop stops resolving to a live
 * credential, and an endpoint with an unresolvable keyRef is already UNUSABLE
 * rather than falling through to an unauthenticated call (P15-E2). The only new
 * thing P18 owes is that the reason names the fix.
 */
describe('a credential that is gone', () => {
  it('leaves the endpoint unusable rather than calling the gateway without a key', async () => {
    const root = await tempRoot();
    await applyEnrollment(root, {
      version: 1,
      endpoints: [
        { id: 'fleet', kind: 'openai-compatible', url: 'https://gw.corp.internal/v1', models: ['gpt-4o'], health: '/health', keyRef: `env:${managedEnvName('fleet')}`, authEnv: null, gateway: 'omniroute', egress: 'local', managed: true },
      ],
      credentials: [],
      notes: [],
    });
    const written = JSON.parse(await readFile(join(root, 'baton.config.json'), 'utf-8'));
    const { config } = validateEndpointsConfig(written, {});
    expect(config.endpoints[0].usable).toBe(false);
    expect(config.endpoints[0].unusable).toBeTruthy();
  });

  it('stores a rotated credential over the old one', async () => {
    const root = await tempRoot();
    await saveManagedCredentials(root, { [managedEnvName('fleet')]: 'sk-old-1111' });
    await saveManagedCredentials(root, { [managedEnvName('fleet')]: 'sk-new-2222' });
    expect(await loadManagedCredentials(root)).toEqual({ [managedEnvName('fleet')]: 'sk-new-2222' });
  });

  it('reads a missing store as no credentials, not as an error', async () => {
    expect(await loadManagedCredentials(await tempRoot())).toEqual({});
  });
});

/*
 * The join between the two halves: a managed endpoint names an environment
 * variable, and nothing sets that variable except this loader. Both halves were
 * green in isolation while the endpoint was still unusable in real life, which
 * is exactly the seam an integration test is for.
 */
describe('loadEndpointsConfig, after enrollment', () => {
  it('resolves a managed credential without it ever being in the environment', async () => {
    const root = await tempRoot();
    await applyEnrollment(root, {
      version: 1,
      endpoints: [
        { id: 'fleet', kind: 'openai-compatible', url: 'https://gw.corp.internal/v1', models: ['gpt-4o'], health: '/health', keyRef: `env:${managedEnvName('fleet')}`, authEnv: null, gateway: 'omniroute', egress: 'local', managed: true },
      ],
      credentials: [{ endpointId: 'fleet', value: MEMBER_KEY, expiresAt: null }],
      notes: [],
    });

    const { config, errors } = await loadEndpointsConfig(root, {});
    expect(errors).toEqual([]);
    expect(config.endpoints[0].usable).toBe(true);
    expect(resolveEndpointKey(config.endpoints[0], await withManagedEnv(root, {}))).toBe(MEMBER_KEY);
  });

  /*
   * 🔴 The store must not be able to set anything a launch reads. A tampered
   * `managed-keys.json` naming PATH or ANTHROPIC_API_KEY would otherwise reach
   * the environment of every agent this machine starts.
   */
  it('cannot be used to set a variable outside its own namespace', async () => {
    const root = await tempRoot();
    await mkdir(join(root, '.baton'), { recursive: true });
    await writeFile(
      managedCredentialsPath(root),
      JSON.stringify({ PATH: '/tmp/evil', ANTHROPIC_API_KEY: 'sk-stolen', [managedEnvName('fleet')]: MEMBER_KEY }),
      { mode: 0o600 },
    );
    const merged = await withManagedEnv(root, {});
    expect(merged.PATH).toBeUndefined();
    expect(merged.ANTHROPIC_API_KEY).toBeUndefined();
    expect(merged[managedEnvName('fleet')]).toBe(MEMBER_KEY);
  });

  /*
   * A real environment variable wins. The store exists to supply what the
   * environment does not have, and silently overriding an operator's own export
   * would make a machine behave differently from what its shell says.
   */
  it('does not override a variable the environment already sets', async () => {
    const root = await tempRoot();
    await saveManagedCredentials(root, { [managedEnvName('fleet')]: 'sk-from-store' });
    const merged = await withManagedEnv(root, { [managedEnvName('fleet')]: 'sk-from-shell' });
    expect(merged[managedEnvName('fleet')]).toBe('sk-from-shell');
  });
});

/*
 * P18-E2 — a developer leaves.
 *
 * "Revoke the member; the gateway credential dies with it" is only true if
 * something actually tells the gateway. Revoking the member stops them getting
 * a NEW credential, but the one already on their laptop keeps working until the
 * gateway is told otherwise — so the host has to remember what it issued for
 * whom. `keyId` is an identifier, not a key: the raw value was shown once and
 * was never ours to keep.
 *
 * The other half of E2 stays true and must not be overstated: nothing here is a
 * remote wipe. The cached config on their laptop survives; it is simply inert.
 */
describe('the ledger of what was issued', () => {
  it('remembers one key per member per endpoint, replacing the last', async () => {
    const root = await tempRoot();
    await recordIssuedKey(root, { memberId: 'priya', endpointId: 'fleet', keyId: 'k1', issuedAt: 'x' });
    await recordIssuedKey(root, { memberId: 'priya', endpointId: 'fleet', keyId: 'k2', issuedAt: 'y' });
    await recordIssuedKey(root, { memberId: 'sam', endpointId: 'fleet', keyId: 'k3', issuedAt: 'z' });

    const all = await loadIssuedKeys(root);
    expect(all.map((k) => k.keyId).sort()).toEqual(['k2', 'k3']);
  });

  it('hands back one member\'s keys and forgets them, so a revoke cannot run twice', async () => {
    const root = await tempRoot();
    await recordIssuedKey(root, { memberId: 'priya', endpointId: 'fleet', keyId: 'k1', issuedAt: 'x' });
    await recordIssuedKey(root, { memberId: 'sam', endpointId: 'fleet', keyId: 'k2', issuedAt: 'y' });

    expect((await takeIssuedKeys(root, 'priya')).map((k) => k.keyId)).toEqual(['k1']);
    expect(await takeIssuedKeys(root, 'priya')).toEqual([]);
    // Everyone else's stays.
    expect((await loadIssuedKeys(root)).map((k) => k.keyId)).toEqual(['k2']);
  });

  it('holds no key material, only identifiers', async () => {
    const root = await tempRoot();
    await recordIssuedKey(root, { memberId: 'priya', endpointId: 'fleet', keyId: 'k1', issuedAt: 'x' });
    const text = await readFile(join(root, '.baton', 'issued-keys.json'), 'utf-8');
    expect(text).not.toContain(MEMBER_KEY);
    expect(text).not.toContain('sk-');
  });

  it('reads a ledger that is not one as empty', async () => {
    const root = await tempRoot();
    await mkdir(join(root, '.baton'), { recursive: true });
    await writeFile(join(root, '.baton', 'issued-keys.json'), 'not json');
    expect(await loadIssuedKeys(root)).toEqual([]);
  });
});
