// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Company fleet enrollment — pointing ten laptops at the company's models
 * without ten people hand-typing a gateway URL and pasting a key.
 *
 * This is not a new subsystem. `baton member add` already mints a token, and
 * `baton join --token` already lands it 0600; enrollment is that same flow
 * carrying one more payload. So the interesting part is not the plumbing, it is
 * what the payload may contain:
 *
 *   P18-E1  Never the shared gateway key. Ship the company credential to ten
 *           laptops and revoking one developer means re-keying the company —
 *           which means, in practice, that nobody ever revokes anybody. Each
 *           member gets their own, minted by the gateway, or none at all.
 *   P18-E3  `managed: true` marks what the company owns. A developer's personal
 *           endpoints sit in the same file and are never touched.
 *   P18-E6  A failed join writes nothing. A half-written endpoints block points
 *           someone at a gateway with no credential, and reads as a broken
 *           install rather than a failed join.
 *
 * The payload arrives over the network and is about to be written into the file
 * that decides where the customer's code is sent, so it is re-validated by
 * `validateEndpointsConfig` — the same gate a hand-written config passes, which
 * is how it inherits every refusal already written there (a credential in the
 * URL, an unsafe health path, a literal key) without restating one of them.
 */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEndpointsConfig, validateEndpointsConfig, type EndpointKind, type EndpointsConfig } from './config.js';
import { gatewayAdapterFor } from './gateways/registry.js';
import { loadIssuedKeys, recordIssuedKey, takeIssuedKeys } from './issued-keys.js';
import { grantEnforcement } from './grants.js';
import { managedEnvName } from './managed-credentials.js';
import { saveManagedCredentials } from './managed-credentials.js';

export const ENROLLMENT_VERSION = 1;

export interface EnrolledEndpoint {
  id: string;
  kind: EndpointKind;
  url: string;
  models: string[];
  health: string;
  /** Always `env:BATON_MANAGED_*` or null — never the host's own variable name,
   *  which is the host's private arrangement and not ten laptops' business. */
  keyRef: string | null;
  authEnv: string | null;
  gateway: string | null;
  egress: 'local' | 'external' | null;
  managed: true;
}

export interface EnrollmentPayload {
  version: number;
  endpoints: EnrolledEndpoint[];
  /** Minted for the member who asked, and shown once — exactly like a member
   *  token. Empty is a valid answer, and a much better one than the shared key. */
  credentials: Array<{ endpointId: string; value: string; expiresAt: string | null }>;
  /** Things the member has to know: an endpoint that arrived without a
   *  credential is not broken, it is un-issued, and those need different fixes. */
  notes: string[];
}

/** Ask the gateway for a credential belonging to this one member. `null` when
 *  it has no admin surface, or refused — never a reason to send the shared one. */
export type MintMemberKey = (endpointId: string) => Promise<{ value: string; expiresAt: string | null } | null>;

const CONFIG_FILE = 'baton.config.json';
const MANAGED_KEYREF = /^env:BATON_MANAGED_[A-Z0-9_]+$/;

/* ------------------------------------------------------------------ */
/* Host side                                                           */
/* ------------------------------------------------------------------ */

export async function buildEnrollment(
  config: EndpointsConfig,
  memberId: string,
  mint: MintMemberKey,
): Promise<EnrollmentPayload> {
  const endpoints: EnrolledEndpoint[] = [];
  const credentials: EnrollmentPayload['credentials'] = [];
  const notes: string[] = [];

  for (const ep of config.endpoints) {
    // Needs a credential ⇔ the host configured one. An Ollama box on the LAN
    // does not, and handing it a reference to a key it never reads would make
    // it unusable the moment the store is empty.
    const needsKey = ep.keyRef !== null;
    endpoints.push({
      id: ep.id,
      kind: ep.kind,
      url: ep.url,
      models: ep.models,
      health: ep.health,
      keyRef: needsKey ? `env:${managedEnvName(ep.id)}` : null,
      authEnv: ep.authEnv,
      gateway: ep.gateway,
      egress: ep.egress,
      managed: true,
    });

    // GW-E7: nothing in front of the runtime means nobody to ask for a key.
    // Asking anyway would POST an admin request at a model server.
    if (!needsKey || grantEnforcement(ep) !== 'gateway') continue;

    const minted = await mint(ep.id);
    if (minted) {
      credentials.push({ endpointId: ep.id, value: minted.value, expiresAt: minted.expiresAt });
    } else {
      notes.push(
        `'${ep.id}': could not issue a credential for ${memberId}. The endpoint is configured but will not run until an owner issues one — the company key is deliberately not sent.`,
      );
    }
  }

  return { version: ENROLLMENT_VERSION, endpoints, credentials, notes };
}

/* ------------------------------------------------------------------ */
/* Member side                                                         */
/* ------------------------------------------------------------------ */

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Everything that arrived, minus everything that should not have.
 *
 * The endpoint rows go back through `validateEndpointsConfig`, so a URL
 * carrying a credential, an unsafe health path or a bogus kind is refused here
 * by the same code that refuses it in a hand-written file. `null` means the
 * payload is not one, and the caller must write nothing (P18-E6).
 */
export function readEnrollmentPayload(raw: unknown): EnrollmentPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<EnrollmentPayload>;
  if (r.version !== ENROLLMENT_VERSION || !Array.isArray(r.endpoints)) return null;

  // Build a config block and let the existing validator be the gate.
  const block: Record<string, unknown> = {};
  for (const e of r.endpoints) {
    const id = str((e as EnrolledEndpoint)?.id);
    if (!id || block[id] !== undefined) continue;
    const keyRef = str((e as EnrolledEndpoint)?.keyRef);
    block[id] = {
      kind: (e as EnrolledEndpoint)?.kind,
      url: (e as EnrolledEndpoint)?.url,
      ...(Array.isArray((e as EnrolledEndpoint)?.models) ? { models: (e as EnrolledEndpoint).models } : {}),
      ...(str((e as EnrolledEndpoint)?.health) ? { health: (e as EnrolledEndpoint).health } : {}),
      // Only the shape this module mints. A `keyRef` naming any other variable
      // is a way to make a launch read something we never put there.
      ...(MANAGED_KEYREF.test(keyRef) ? { keyRef } : {}),
      ...(str((e as EnrolledEndpoint)?.authEnv) ? { authEnv: (e as EnrolledEndpoint).authEnv } : {}),
      ...(str((e as EnrolledEndpoint)?.gateway) ? { gateway: (e as EnrolledEndpoint).gateway } : {}),
      ...((e as EnrolledEndpoint)?.egress === 'local' || (e as EnrolledEndpoint)?.egress === 'external'
        ? { egress: (e as EnrolledEndpoint).egress }
        : {}),
    };
  }

  // Validated against an EMPTY env on purpose: this step decides what is
  // well-formed, not what resolves on this laptop. An endpoint whose credential
  // has not landed yet is still an endpoint — it is unusable, with a reason.
  const { config } = validateEndpointsConfig({ endpoints: block }, {});
  const endpoints: EnrolledEndpoint[] = config.endpoints.map((ep) => ({
    id: ep.id,
    kind: ep.kind,
    url: ep.url,
    models: ep.models,
    health: ep.health,
    keyRef: ep.keyRef,
    authEnv: ep.authEnv,
    gateway: ep.gateway,
    egress: ep.egress,
    managed: true,
  }));

  const credentials: EnrollmentPayload['credentials'] = [];
  for (const c of Array.isArray(r.credentials) ? r.credentials : []) {
    const endpointId = str((c as { endpointId?: unknown })?.endpointId);
    const value = typeof (c as { value?: unknown })?.value === 'string' ? (c as { value: string }).value : '';
    if (!endpointId || !value.trim()) continue;
    const expiresAt = str((c as { expiresAt?: unknown })?.expiresAt);
    credentials.push({ endpointId, value, expiresAt: expiresAt || null });
  }

  const notes = (Array.isArray(r.notes) ? r.notes : []).filter((n): n is string => typeof n === 'string').slice(0, 20);
  return { version: ENROLLMENT_VERSION, endpoints, credentials, notes };
}

/** One enrolled endpoint as it is written into `baton.config.json`. */
function toConfigEntry(e: EnrolledEndpoint): Record<string, unknown> {
  return {
    kind: e.kind,
    url: e.url,
    ...(e.models.length ? { models: e.models } : {}),
    health: e.health,
    ...(e.keyRef ? { keyRef: e.keyRef } : {}),
    ...(e.authEnv ? { authEnv: e.authEnv } : {}),
    ...(e.gateway ? { gateway: e.gateway } : {}),
    ...(e.egress ? { egress: e.egress } : {}),
    managed: true,
  };
}

/**
 * The company's endpoints replace the company's endpoints, and nothing else —
 * P18-E3.
 *
 * "Not editable locally" cannot mean a file the user is unable to write; it is
 * their disk. It means refresh is authoritative: a managed entry is REPLACED
 * rather than merged into, so a local edit does not survive. That matters for
 * one field in particular — an employee must not be able to re-badge a company
 * endpoint as `egress: "local"` and make "leaves your network" disappear.
 */
export function mergeManagedEndpoints(
  local: Record<string, unknown>,
  enrolled: EnrolledEndpoint[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(local ?? {})) {
    const managed = value !== null && typeof value === 'object' && (value as { managed?: unknown }).managed === true;
    if (!managed) out[id] = value; // personal entries, and `allowPaidFallback`
  }
  for (const e of enrolled) out[e.id] = toConfigEntry(e);
  return out;
}

/**
 * Write what was enrolled. Credentials first, then the config that points at
 * them: the failure that leaves a config naming a credential which never
 * arrived is the one that reads as broken, and this ordering cannot produce it.
 * The reverse leftover — a credential nothing references — is inert.
 */
export async function applyEnrollment(root: string, payload: EnrollmentPayload | null): Promise<void> {
  if (!payload) {
    throw new Error('the host did not return a usable enrollment — nothing was written');
  }

  const path = join(root, CONFIG_FILE);
  let file: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown;
    if (parsed && typeof parsed === 'object') file = parsed as Record<string, unknown>;
  } catch {
    // No config yet, or one we cannot parse. Enrollment writes a fresh
    // `endpoints` block either way rather than refusing to start.
  }

  const creds: Record<string, string> = {};
  for (const c of payload.credentials) creds[managedEnvName(c.endpointId)] = c.value;
  if (payload.credentials.length) await saveManagedCredentials(root, creds);

  const existing = file.endpoints !== null && typeof file.endpoints === 'object' ? (file.endpoints as Record<string, unknown>) : {};
  const next = { ...file, endpoints: mergeManagedEndpoints(existing, payload.endpoints) };

  // Temp + rename: a crash mid-write must not leave a config that parses as
  // half a fleet.
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
  await rename(tmp, path);
}

/* ------------------------------------------------------------------ */
/* Host side, wired up                                                 */
/* ------------------------------------------------------------------ */

/** How long a minted credential lives. Short enough that a laptop nobody
 *  revoked stops working on its own, long enough not to be a daily chore. */
const CREDENTIAL_DAYS = 30;

/**
 * The payload for one member, with real credentials minted at the gateway.
 *
 * Each mint replaces that member's previous key for the endpoint: the old one
 * is revoked first, so re-running `baton endpoints refresh` cannot leave a trail
 * of live credentials nobody is tracking.
 */
export async function enrollmentFor(
  root: string,
  memberId: string,
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now,
): Promise<EnrollmentPayload> {
  const { config } = await loadEndpointsConfig(root, env);
  const expiresAt = new Date(now() + CREDENTIAL_DAYS * 86_400_000).toISOString();
  const issued = await loadIssuedKeys(root);

  return buildEnrollment(config, memberId, async (endpointId) => {
    const endpoint = config.endpoints.find((e) => e.id === endpointId);
    if (!endpoint) return null;
    const { adapter } = gatewayAdapterFor(endpoint);
    if (!adapter.mintMemberKey) return null;

    const minted = await adapter.mintMemberKey(endpoint, env, { memberId, expiresAt });
    if (!minted) return null;

    // Only after a successful mint: revoking first would leave the member with
    // nothing if the new one failed to issue.
    const prior = issued.find((k) => k.memberId === memberId && k.endpointId === endpointId);
    if (prior && adapter.revokeMemberKey) await adapter.revokeMemberKey(endpoint, env, prior.keyId);
    if (minted.keyId) {
      await recordIssuedKey(root, { memberId, endpointId, keyId: minted.keyId, issuedAt: new Date(now()).toISOString() });
    }
    return { value: minted.value, expiresAt: minted.expiresAt };
  });
}

export interface RevokeOutcome {
  endpointId: string;
  keyId: string;
  revoked: boolean;
}

/**
 * Kill every credential this host issued to one member — P18-E2.
 *
 * Returns what happened per key rather than a bare boolean, because "we could
 * not reach the gateway" and "it is gone" must produce different sentences. A
 * caller that prints "revoked" over a failed call is telling an admin their
 * leaver is locked out when they are not.
 */
export async function revokeIssuedKeysFor(
  root: string,
  memberId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RevokeOutcome[]> {
  const { config } = await loadEndpointsConfig(root, env);
  const keys = await takeIssuedKeys(root, memberId);
  const out: RevokeOutcome[] = [];
  for (const k of keys) {
    const endpoint = config.endpoints.find((e) => e.id === k.endpointId);
    const adapter = endpoint ? gatewayAdapterFor(endpoint).adapter : null;
    const revoked = endpoint && adapter?.revokeMemberKey
      ? await adapter.revokeMemberKey(endpoint, env, k.keyId)
      : false;
    out.push({ endpointId: k.endpointId, keyId: k.keyId, revoked });
  }
  return out;
}

/**
 * Ask the host for this machine's enrollment.
 *
 * Never throws on a network failure: the host being unreachable is routine
 * (laptop asleep, VPN down), and it must not stop `baton join` from finishing
 * the part that worked. `null` means nothing usable came back, and
 * `applyEnrollment` refuses it — so a failed fetch writes nothing (P18-E6).
 */
export async function fetchEnrollment(
  link: { url: string; token: string },
  timeoutMs = 15_000,
): Promise<{ payload: EnrollmentPayload | null; error: string | null }> {
  let res: Response;
  try {
    res = await fetch(`${link.url.replace(/\/+$/, '')}/api/endpoints/enrollment`, {
      headers: { Authorization: `Bearer ${link.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { payload: null, error: `could not reach ${link.url} (${(e as Error).message})` };
  }
  if (res.status === 401) {
    // P18-E5/E2 — an invite that expired unused, or a member who was revoked.
    return { payload: null, error: 'the host rejected this token — ask an owner for a fresh invite' };
  }
  if (!res.ok) return { payload: null, error: `the host replied ${res.status}` };
  try {
    return { payload: readEnrollmentPayload(await res.json()), error: null };
  } catch {
    return { payload: null, error: 'the host did not return JSON — is that really a Baton daemon?' };
  }
}
