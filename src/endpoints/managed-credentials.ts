// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The per-member gateway credentials this machine was enrolled with.
 *
 * Kept out of `baton.config.json` on purpose: that file is committed in plenty
 * of repos, and P15-E3 already refuses to load one carrying a literal key. This
 * is the same split `host.json` uses — configuration in the tracked file, the
 * secret beside it at 0600.
 *
 * The bridge between the two is an environment variable NAME. A managed
 * endpoint carries `keyRef: "env:BATON_MANAGED_FLEET"`, and `loadEndpointsConfig`
 * merges this store into the env it validates against. That keeps
 * `resolveEndpointKey` exactly as it was — one scheme, `env:`, resolved
 * synchronously — instead of teaching the hot path a second way to find a
 * secret.
 */
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { batonDir } from '../store.js';

const PREFIX = 'BATON_MANAGED_';
/** Same ceiling the config's own values get; a store is not a place to grow one. */
const VALUE_MAX = 4_096;

export function managedCredentialsPath(root: string): string {
  return join(batonDir(root), 'managed-keys.json');
}

/** The env var a managed endpoint's `keyRef` points at. Derived from the id so
 *  the host and the member compute the same name without exchanging it. */
export function managedEnvName(endpointId: string): string {
  const tail = endpointId.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${PREFIX}${tail || 'ENDPOINT'}`;
}

/** True for names this module owns, so a merge cannot be used to set PATH. */
export function isManagedEnvName(name: string): boolean {
  return /^BATON_MANAGED_[A-Z0-9_]+$/.test(name);
}

/**
 * Never throws. A missing store is the ordinary state of every machine that was
 * never enrolled, and an unreadable one must degrade to "no credentials" —
 * which leaves the endpoint unusable with a reason, rather than letting it
 * reach a gateway unauthenticated.
 */
export async function loadManagedCredentials(root: string): Promise<Record<string, string>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(managedCredentialsPath(root), 'utf-8'));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    // Only names this module mints. Without the check, a tampered store is a
    // way to set any environment variable a launch will later read.
    if (!isManagedEnvName(name)) continue;
    if (typeof value !== 'string' || !value.trim() || value.length > VALUE_MAX) continue;
    out[name] = value;
  }
  return out;
}

/** Replaces the store wholesale: enrollment is authoritative, and a merge would
 *  keep a credential the host has stopped issuing. Written via a temp file so a
 *  crash mid-write cannot leave a half-parsed one. */
export async function saveManagedCredentials(root: string, creds: Record<string, string>): Promise<string> {
  const path = managedCredentialsPath(root);
  await mkdir(batonDir(root), { recursive: true });
  const kept = Object.fromEntries(Object.entries(creds).filter(([name, v]) => isManagedEnvName(name) && typeof v === 'string' && v.trim()));
  const tmp = `${path}.${process.pid}.tmp`;
  // 0600 on the TEMP file too: the window between write and rename is exactly
  // as long as it takes another process to read it.
  await writeFile(tmp, `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  return path;
}

export async function clearManagedCredentials(root: string): Promise<boolean> {
  try {
    await rm(managedCredentialsPath(root));
    return true;
  } catch {
    return false;
  }
}

/**
 * The environment a managed endpoint's `keyRef` is resolved against.
 *
 * A real environment variable WINS. The store exists to supply what the shell
 * does not, and silently overriding an operator's own export would make the
 * machine behave differently from what their shell says it will — the kind of
 * difference nobody finds for a day.
 */
export async function withManagedEnv(
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const stored = await loadManagedCredentials(root);
  const out: NodeJS.ProcessEnv = { ...env };
  for (const [name, value] of Object.entries(stored)) {
    if (out[name] === undefined) out[name] = value;
  }
  return out;
}
