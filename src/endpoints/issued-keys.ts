// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What this host issued at the gateway, and for whom.
 *
 * Exists for one sentence in P18-E2: *"revoke the member; the gateway
 * credential dies with it."* That is only true if something tells the gateway.
 * Revoking a member stops them obtaining a NEW credential immediately — the
 * token check does that with no help from here — but the one already on their
 * laptop keeps working until the gateway is asked to kill it, and asking needs
 * the id it was filed under.
 *
 * **This file holds no key material.** The raw value is shown once, at mint, and
 * was never ours to keep; a `keyId` is an identifier, so a leaked ledger is a
 * list of names rather than a set of working credentials.
 *
 * And the part that must not be overstated anywhere in the UI: none of this is
 * a remote wipe. The config cached on a leaver's laptop survives. It is simply
 * inert, which is a different and much more honest claim.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { batonDir } from '../store.js';
import { withLock } from '../util/lock.js';

/** Ten employees times a handful of endpoints, with room to spare. */
const MAX_ISSUED = 2_000;

export interface IssuedKey {
  memberId: string;
  endpointId: string;
  /** The gateway's identifier for the key. Never the key. */
  keyId: string;
  issuedAt: string;
}

export function issuedKeysPath(root: string): string {
  return join(batonDir(root), 'issued-keys.json');
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function clean(raw: unknown): IssuedKey[] {
  if (!Array.isArray(raw)) return [];
  const out: IssuedKey[] = [];
  for (const k of raw) {
    if (out.length >= MAX_ISSUED) break;
    const memberId = str((k as IssuedKey)?.memberId);
    const endpointId = str((k as IssuedKey)?.endpointId);
    const keyId = str((k as IssuedKey)?.keyId);
    // All three are needed to revoke anything. A row missing one names a key we
    // could not act on, which is worse than no row at all.
    if (!memberId || !endpointId || !keyId) continue;
    out.push({ memberId, endpointId, keyId, issuedAt: str((k as IssuedKey)?.issuedAt) || new Date(0).toISOString() });
  }
  return out;
}

/** Never throws. No ledger is the ordinary state of a host that has issued
 *  nothing, and an unreadable one must not stop a mint. */
export async function loadIssuedKeys(root: string): Promise<IssuedKey[]> {
  try {
    return clean(JSON.parse(await readFile(issuedKeysPath(root), 'utf-8')));
  } catch {
    return [];
  }
}

async function write(root: string, keys: IssuedKey[]): Promise<void> {
  const path = issuedKeysPath(root);
  await mkdir(batonDir(root), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(keys, null, 2)}\n`);
  await rename(tmp, path);
}

/**
 * One live key per member per endpoint. Re-enrolling replaces the record rather
 * than appending, because two records for one pair means the older key is one
 * nothing will ever revoke.
 */
export async function recordIssuedKey(root: string, key: IssuedKey): Promise<void> {
  await withLock(issuedKeysPath(root), async () => {
    const keys = (await loadIssuedKeys(root)).filter(
      (k) => !(k.memberId === key.memberId && k.endpointId === key.endpointId),
    );
    await write(root, [...keys, key]);
  });
}

/**
 * Take this member's keys out of the ledger and hand them back, in one step.
 *
 * Read-then-delete rather than read-then-caller-deletes: a revoke that crashes
 * between the two would leave records that get "revoked" again on the next run,
 * and a gateway asked to revoke a key twice is noise in someone's audit log.
 */
export async function takeIssuedKeys(root: string, memberId: string): Promise<IssuedKey[]> {
  return withLock(issuedKeysPath(root), async () => {
    const keys = await loadIssuedKeys(root);
    const mine = keys.filter((k) => k.memberId === memberId);
    if (mine.length) await write(root, keys.filter((k) => k.memberId !== memberId));
    return mine;
  });
}
