// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P18 — who may run a model that leaves the network.
 *
 * The rule the product is sold on, in one line: **local models are open to
 * everyone, and anything that leaves the network is denied until an admin says
 * otherwise, by name.** An admin turning Opus on for five senior engineers is
 * the intended flow; an admin turning it on for the whole company by accident,
 * silently, is what this default exists to prevent.
 *
 * What this is NOT: a copy of the gateway's `allowed_models`. The gateway
 * decides which models a key can reach at all, and Baton never mirrors that —
 * two systems disagreeing about what an employee may run is the failure mode.
 * Baton decides one thing the gateway has no concept of: whether this person is
 * allowed to send code OFF the customer's network.
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addMember } from '../src/members.js';
import { validateEndpointsConfig, type EndpointConfig } from '../src/endpoints/config.js';
import {
  cleanGrantRegistry,
  decideModelGrant,
  grantEnforcement,
  grantModel,
  grantableModels,
  revokeModelGrant,
  loadGrants,
  saveGrants,
  withGrants,
  grantsPath,
  EMPTY_GRANTS,
  type GrantRegistry,
} from '../src/endpoints/grants.js';

const endpointAt = (url: string, over: Record<string, unknown> = {}): EndpointConfig =>
  validateEndpointsConfig(
    { endpoints: { fleet: { kind: 'openai-compatible', url, models: ['m'], ...over } } },
    {},
  ).config.endpoints[0];

const WORKSTATION = endpointAt('http://192.168.1.9:11434');
const VENDOR = endpointAt('https://api.vendor.example/v1', { gateway: 'omniroute' });
const MYSTERY = endpointAt('https://gw/v1');

/** A registry with one live member, so the "somebody administers this" branch
 *  is the one under test rather than the solo-laptop shortcut. */
const administered = (): GrantRegistry => ({ ...EMPTY_GRANTS(), administered: true });

describe('decideModelGrant', () => {
  it('lets anyone run a model on hardware the company owns', () => {
    const d = decideModelGrant(administered(), 'priya', WORKSTATION, 'qwen3-coder');
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('local');
  });

  // 🔴 The default the whole product rests on.
  it('denies a model that leaves the network until someone is named', () => {
    const d = decideModelGrant(administered(), 'priya', VENDOR, 'gpt-4o');
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('not-granted');
    // The denial has to be actionable — a developer reading it must know who to
    // ask and what to ask for.
    expect(d.detail).toContain('gpt-4o');
    expect(d.detail).toMatch(/leaves your network/i);
  });

  // GW-E5 — never guess `local`. Unverified is treated exactly like external.
  it('treats an unverified endpoint as leaving the network', () => {
    const d = decideModelGrant(administered(), 'priya', MYSTERY, 'mystery-7b');
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('not-granted');
  });

  it('allows it once an admin grants that person that model', () => {
    const reg = grantModel(administered(), {
      memberId: 'priya',
      endpointId: VENDOR.id,
      model: 'gpt-4o',
      grantedBy: 'ravi',
      at: '2026-08-23T10:00:00.000Z',
    });
    expect(decideModelGrant(reg, 'priya', VENDOR, 'gpt-4o').allowed).toBe(true);
    // Granted to a person, not to the company.
    expect(decideModelGrant(reg, 'sam', VENDOR, 'gpt-4o').allowed).toBe(false);
    // And for one model, not for the endpoint.
    expect(decideModelGrant(reg, 'priya', VENDOR, 'o3').allowed).toBe(false);
  });

  // GW-E4 — two endpoints can serve the same model name, and a grant on the
  // company gateway must not silently authorise someone's personal proxy.
  it('does not let a grant on one endpoint carry to another', () => {
    const other = endpointAt('https://api.other.example/v1');
    const reg = grantModel(administered(), {
      memberId: 'priya',
      endpointId: VENDOR.id,
      model: 'gpt-4o',
      grantedBy: 'ravi',
      at: '2026-08-23T10:00:00.000Z',
    });
    // Same id from the same fixture helper, so only the URL differs; the grant
    // is keyed on the endpoint identity the admin actually named.
    expect(decideModelGrant(reg, 'priya', { ...other, id: 'personal' }, 'gpt-4o').allowed).toBe(false);
  });

  it('stops allowing it the moment the grant is revoked', () => {
    const granted = grantModel(administered(), {
      memberId: 'priya',
      endpointId: VENDOR.id,
      model: 'gpt-4o',
      grantedBy: 'ravi',
      at: '2026-08-23T10:00:00.000Z',
    });
    const revoked = revokeModelGrant(granted, 'priya', VENDOR.id, 'gpt-4o', '2026-08-23T11:00:00.000Z');
    expect(decideModelGrant(revoked, 'priya', VENDOR, 'gpt-4o').allowed).toBe(false);
    // The revoked row survives, because "who was allowed to send code to a
    // vendor, and when" is exactly the question an audit asks later.
    expect(revoked.grants).toHaveLength(1);
    expect(revoked.grants[0].revokedAt).toBe('2026-08-23T11:00:00.000Z');
  });

  /*
   * 🔴 The single-developer case, and the reason this is not just "deny by
   * default". Nobody administers a laptop with no members: the person at the
   * keyboard IS the admin, and locking them out of their own paid API key would
   * make the feature a bug for every solo install.
   *
   * Same shape as `decideAccess` rule 1 — a machine with no member registry is
   * governed by whoever is sitting at it.
   */
  it('does not gate a laptop nobody administers', () => {
    const solo = EMPTY_GRANTS(); // administered: false
    const d = decideModelGrant(solo, 'me', VENDOR, 'gpt-4o');
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('unadministered');
  });
});

/*
 * GW-E2 — an admin revoking a model must not kill a run that is mid-edit.
 *
 * The mechanism is that a decision is a VALUE taken once at launch, never a
 * live query re-asked while the agent works. So the test is: take the decision,
 * revoke underneath it, and show the taken decision is unchanged. Revocation
 * lands on the next launch, which the previous test already pins.
 */
describe('a decision already taken', () => {
  it('survives a revocation mid-task, because the run holds the answer', () => {
    let reg = grantModel(administered(), {
      memberId: 'priya',
      endpointId: VENDOR.id,
      model: 'gpt-4o',
      grantedBy: 'ravi',
      at: '2026-08-23T10:00:00.000Z',
    });
    const atLaunch = decideModelGrant(reg, 'priya', VENDOR, 'gpt-4o');
    expect(atLaunch.allowed).toBe(true);

    reg = revokeModelGrant(reg, 'priya', VENDOR.id, 'gpt-4o', '2026-08-23T11:00:00.000Z');

    expect(atLaunch.allowed).toBe(true); // the running agent keeps its model
    expect(decideModelGrant(reg, 'priya', VENDOR, 'gpt-4o').allowed).toBe(false); // the next one does not
  });
});

/*
 * GW-E3 — the picker shows what this person may actually run, filtered by
 * grant rather than by catalog. A model listed but unusable is indistinguishable
 * from a bug, and it is the support ticket this avoids.
 */
describe('grantableModels', () => {
  const rows = [
    { endpoint: WORKSTATION, models: ['qwen3-coder', 'devstral'] },
    { endpoint: VENDOR, models: ['gpt-4o', 'o3'] },
  ];

  it('offers every local model and no ungranted external one', () => {
    const offered = grantableModels(administered(), 'priya', rows);
    expect(offered.map((m) => m.model)).toEqual(['qwen3-coder', 'devstral']);
  });

  it('adds the external model the admin granted, and only that one', () => {
    const reg = grantModel(administered(), {
      memberId: 'priya',
      endpointId: VENDOR.id,
      model: 'o3',
      grantedBy: 'ravi',
      at: '2026-08-23T10:00:00.000Z',
    });
    const offered = grantableModels(reg, 'priya', rows);
    expect(offered.map((m) => m.model)).toEqual(['qwen3-coder', 'devstral', 'o3']);
    // Qualified by endpoint, because two endpoints can serve one name (GW-E4).
    expect(offered.find((m) => m.model === 'o3')?.endpointId).toBe(VENDOR.id);
  });

  it('carries the egress badge on every row it offers', () => {
    const offered = grantableModels(administered(), 'priya', rows);
    expect(offered.every((m) => m.egress === 'local')).toBe(true);
  });
});

/*
 * GW-E7 — a customer with no gateway at all. Fully supported, and the honest
 * thing is to say what does and does not work rather than to look broken.
 *
 * Without a gateway there is one shared credential and no admin surface, so a
 * grant is a record of intent, not something the network enforces. Baton says
 * that plainly instead of implying a control it does not have.
 */
describe('grantEnforcement', () => {
  it('is enforced by the gateway when there is one', () => {
    expect(grantEnforcement(VENDOR)).toBe('gateway');
  });

  it('is advisory against a runtime reached directly', () => {
    expect(grantEnforcement(endpointAt('https://api.other.example/v1'))).toBe('advisory');
  });
});

describe('cleanGrantRegistry', () => {
  it('reads a file that is not a grant registry as no grants', () => {
    expect(cleanGrantRegistry(null).grants).toEqual([]);
    expect(cleanGrantRegistry({ version: 99, grants: [{}] }).grants).toEqual([]);
  });

  it('drops a row missing any of the three things a grant names', () => {
    const reg = cleanGrantRegistry({
      version: 1,
      administered: true,
      grants: [
        { memberId: 'priya', endpointId: 'vendor', model: 'gpt-4o', grantedBy: 'ravi', grantedAt: 'x' },
        { memberId: 'priya', endpointId: 'vendor', grantedBy: 'ravi', grantedAt: 'x' },
        { endpointId: 'vendor', model: 'gpt-4o', grantedBy: 'ravi', grantedAt: 'x' },
      ],
    });
    expect(reg.grants).toHaveLength(1);
  });

  /*
   * A file that fails to parse must not read as "everything is allowed". The
   * two mistakes are not symmetric: a corrupt file that denies costs an admin a
   * re-grant, one that allows sends code to a vendor nobody approved.
   */
  it('keeps the fleet administered when the grant list is unreadable', () => {
    const reg = cleanGrantRegistry({ version: 1, administered: true, grants: 'not-an-array' });
    expect(reg.administered).toBe(true);
    expect(reg.grants).toEqual([]);
    expect(decideModelGrant(reg, 'priya', VENDOR, 'gpt-4o').allowed).toBe(false);
  });
});

/*
 * Storage. The one thing worth a test here is that `administered` is DERIVED —
 * a registry written before the first member was added must not keep saying
 * "nobody administers this" once somebody does, because that stale flag opens
 * every external model to everyone.
 */
describe('loadGrants', () => {
  const tempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), 'baton-grants-'));

  it('reads a laptop with no members as unadministered', async () => {
    const reg = await loadGrants(await tempRoot());
    expect(reg.administered).toBe(false);
    expect(decideModelGrant(reg, 'me', VENDOR, 'gpt-4o').allowed).toBe(true);
  });

  it('becomes administered the moment a member exists, with no rewrite', async () => {
    const root = await tempRoot();
    await saveGrants(root, EMPTY_GRANTS()); // written while nobody administered it
    await addMember(root, 'Ravi', 'owner');

    const reg = await loadGrants(root);
    expect(reg.administered).toBe(true);
    expect(decideModelGrant(reg, 'priya', VENDOR, 'gpt-4o').allowed).toBe(false);
  });

  it('never writes a credential, because it holds none', async () => {
    const root = await tempRoot();
    await saveGrants(root, grantModel({ ...EMPTY_GRANTS(), administered: true }, {
      memberId: 'priya', endpointId: 'fleet', model: 'gpt-4o', grantedBy: 'ravi', at: '2026-08-23T10:00:00.000Z',
    }));
    const text = await readFile(grantsPath(root), 'utf-8');
    expect(text).toContain('gpt-4o');
    expect(text).not.toMatch(/sk-|baton_/);
  });

  it('round-trips a grant through the file', async () => {
    const root = await tempRoot();
    await addMember(root, 'Ravi', 'owner');
    await withGrants(root, (reg) => grantModel(reg, {
      memberId: 'priya', endpointId: 'fleet', model: 'gpt-4o', grantedBy: 'ravi', at: '2026-08-23T10:00:00.000Z',
    }));
    const reloaded = await loadGrants(root);
    expect(reloaded.grants.map((g) => g.model)).toEqual(['gpt-4o']);
  });
});
