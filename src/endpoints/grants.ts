// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Who may run a model that leaves the company's network.
 *
 * **This is not a copy of the gateway's `allowed_models`.** The gateway decides
 * which models a key can reach at all, and Baton never mirrors that — two
 * systems disagreeing about what an employee may run is precisely the drift the
 * design forbids. Baton decides the one thing a gateway has no concept of:
 * whether this person may send the customer's code off the customer's network.
 *
 * So the split is clean and neither side can contradict the other:
 *
 *   the gateway   which models exist for this key      (catalog.ts reads it)
 *   Baton         may this person use an external one  (this file)
 *
 * The default is the product: `local` is open to everyone, and anything that
 * leaves is denied until an admin names a person. An admin enabling Opus for
 * five senior engineers is the intended flow; enabling it for everyone by
 * accident, silently, is what the default prevents.
 */
import { classifyEgress, type EgressClass } from './egress.js';
import type { EndpointConfig } from './config.js';
import { slugify } from '../util/slug.js';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { batonDir } from '../store.js';
import { withLock } from '../util/lock.js';
import { hasActiveMembers, loadMembers } from '../members.js';

export const GRANTS_VERSION = 1;

/** Ten employees times a handful of frontier models, with room to spare. A cap
 *  exists so a corrupt file cannot become an unbounded read. */
const MAX_GRANTS = 2_000;
const ID_MAX = 40;
/** Model ids are vendor strings, not slugs — kept verbatim, only bounded. */
const MODEL_MAX = 120;

export interface ModelGrant {
  memberId: string;
  /** Qualified by endpoint: two endpoints can serve one model name (GW-E4), and
   *  a grant on the company gateway must not authorise a personal proxy. */
  endpointId: string;
  model: string;
  grantedBy: string;
  grantedAt: string;
  /** Set on revoke. The row survives, because "who could send code to a vendor,
   *  and when" is the question an audit asks a year later. */
  revokedAt?: string;
}

export interface GrantRegistry {
  version: number;
  /**
   * Does anybody administer this fleet? True once the host has members.
   *
   * A laptop with no member registry is governed by whoever is sitting at it —
   * the same rule `decideAccess` applies to loopback. Gating a solo developer
   * out of their own paid API key would make this feature a bug for every
   * single-person install.
   */
  administered: boolean;
  grants: ModelGrant[];
}

export type GrantReason = 'local' | 'granted' | 'unadministered' | 'not-granted';

export interface GrantDecision {
  allowed: boolean;
  reason: GrantReason;
  /** Already phrased for a human, and actionable: a developer who reads it
   *  should know what to ask for and who to ask. */
  detail: string;
}

export interface GrantOffer {
  model: string;
  endpointId: string;
  egress: EgressClass;
}

export const EMPTY_GRANTS = (): GrantRegistry => ({
  version: GRANTS_VERSION,
  administered: false,
  grants: [],
});

const grantId = (v: unknown): string => (typeof v === 'string' ? slugify(v, ID_MAX) : '');

export function cleanGrantRegistry(raw: unknown): GrantRegistry {
  if (!raw || typeof raw !== 'object') return EMPTY_GRANTS();
  const r = raw as Partial<GrantRegistry>;
  if (r.version !== GRANTS_VERSION) return EMPTY_GRANTS();

  // Read FIRST, and independently of the grant rows. A grants array we cannot
  // parse must not also un-administer the fleet: the two mistakes are not
  // symmetric — a corrupt file that denies costs an admin a re-grant, one that
  // allows sends code to a vendor nobody approved.
  const administered = r.administered === true;
  if (!Array.isArray(r.grants)) return { version: GRANTS_VERSION, administered, grants: [] };

  const grants: ModelGrant[] = [];
  for (const g of r.grants) {
    if (grants.length >= MAX_GRANTS) break;
    const memberId = grantId((g as ModelGrant)?.memberId);
    const endpointId = grantId((g as ModelGrant)?.endpointId);
    const model = typeof (g as ModelGrant)?.model === 'string' ? (g as ModelGrant).model.trim().slice(0, MODEL_MAX) : '';
    // All three name the grant. A row missing one authorises nothing knowable,
    // so it is dropped rather than half-honoured.
    if (!memberId || !endpointId || !model) continue;
    grants.push({
      memberId,
      endpointId,
      model,
      grantedBy: grantId((g as ModelGrant)?.grantedBy) || 'unknown',
      grantedAt: typeof (g as ModelGrant)?.grantedAt === 'string' ? (g as ModelGrant).grantedAt : new Date(0).toISOString(),
      ...(typeof (g as ModelGrant)?.revokedAt === 'string' ? { revokedAt: (g as ModelGrant).revokedAt } : {}),
    });
  }
  return { version: GRANTS_VERSION, administered, grants };
}

const isLive = (g: ModelGrant, memberId: string, endpointId: string, model: string): boolean =>
  !g.revokedAt && g.memberId === memberId && g.endpointId === endpointId && g.model === model;

/**
 * May `memberId` launch `model` on `endpoint`?
 *
 * The answer is a VALUE, taken once at launch and never re-asked while the
 * agent works (GW-E2). Killing a task mid-edit to enforce a policy change loses
 * work; revocation lands on the next launch instead.
 */
export function decideModelGrant(
  reg: GrantRegistry,
  memberId: string,
  endpoint: EndpointConfig,
  model: string,
): GrantDecision {
  const egress = classifyEgress(endpoint);
  // Checked before `administered`, because on a solo laptop "it runs on your
  // own hardware" is the truer answer than "nobody administers this".
  if (egress === 'local') {
    return { allowed: true, reason: 'local', detail: `'${model}' runs on your network` };
  }
  if (!reg.administered) {
    return { allowed: true, reason: 'unadministered', detail: `'${model}' is yours to use — nobody administers this machine` };
  }

  const member = slugify(memberId, ID_MAX);
  if (reg.grants.some((g) => isLive(g, member, endpoint.id, model))) {
    return { allowed: true, reason: 'granted', detail: `'${model}' was granted to ${member}` };
  }

  // `unknown` is worded as what it is rather than as a flat "external": an admin
  // reading this needs to know whether to grant the model or to declare the
  // endpoint's egress, and those are different fixes.
  const why = egress === 'unknown'
    ? `'${endpoint.id}' has not been shown to stay on your network, so it is treated as if it leaves your network`
    : `'${endpoint.id}' leaves your network`;
  return {
    allowed: false,
    reason: 'not-granted',
    detail: `${why}, and '${model}' has not been granted to ${member}. Ask an owner to run: baton endpoints grant ${member} ${model} --endpoint ${endpoint.id}`,
  };
}

export function grantModel(
  reg: GrantRegistry,
  g: { memberId: string; endpointId: string; model: string; grantedBy: string; at: string },
): GrantRegistry {
  const memberId = slugify(g.memberId, ID_MAX);
  const endpointId = slugify(g.endpointId, ID_MAX);
  const model = g.model.trim().slice(0, MODEL_MAX);
  // Re-granting something already live is a no-op rather than a duplicate row,
  // so `revoke` cannot leave a second grant standing behind the first.
  if (reg.grants.some((x) => isLive(x, memberId, endpointId, model))) return reg;
  return {
    ...reg,
    grants: [
      ...reg.grants,
      { memberId, endpointId, model, grantedBy: slugify(g.grantedBy, ID_MAX) || 'unknown', grantedAt: g.at },
    ],
  };
}

export function revokeModelGrant(
  reg: GrantRegistry,
  memberId: string,
  endpointId: string,
  model: string,
  at: string,
): GrantRegistry {
  const member = slugify(memberId, ID_MAX);
  const endpoint = slugify(endpointId, ID_MAX);
  return {
    ...reg,
    grants: reg.grants.map((g) => (isLive(g, member, endpoint, model) ? { ...g, revokedAt: at } : g)),
  };
}

/**
 * The models this person may actually run — GW-E3.
 *
 * Filtered by grant, not by catalog. A model listed in a picker that its owner
 * cannot use is indistinguishable from a bug, and it is the support ticket this
 * function exists to avoid.
 */
export function grantableModels(
  reg: GrantRegistry,
  memberId: string,
  rows: Array<{ endpoint: EndpointConfig; models: string[] }>,
): GrantOffer[] {
  const offers: GrantOffer[] = [];
  for (const row of rows) {
    const egress = classifyEgress(row.endpoint);
    for (const model of row.models) {
      if (!decideModelGrant(reg, memberId, row.endpoint, model).allowed) continue;
      offers.push({ model, endpointId: row.endpoint.id, egress });
    }
  }
  return offers;
}

/**
 * How much a grant is actually worth against this endpoint — GW-E7.
 *
 * With a gateway, the per-key policy enforces it at the network. Without one
 * there is a single shared credential and no admin surface, so a grant records
 * intent and nothing stops a determined user with the key. Saying that plainly
 * is better than implying a control we do not have.
 */
export function grantEnforcement(endpoint: EndpointConfig): 'gateway' | 'advisory' {
  return endpoint.gateway ? 'gateway' : 'advisory';
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

export function grantsPath(root: string): string {
  return join(batonDir(root), 'model-grants.json');
}

/**
 * `administered` is DERIVED at load, never read from the file.
 *
 * Storing it would let a registry written before the first member was added
 * keep saying "nobody administers this" long after somebody does — and that
 * stale flag opens every external model to everyone. The member registry is the
 * only thing that knows, so it is the only thing asked.
 */
export async function loadGrants(root: string): Promise<GrantRegistry> {
  let raw: unknown = null;
  try {
    raw = JSON.parse(await readFile(grantsPath(root), 'utf-8'));
  } catch {
    // No grants yet is the ordinary state, and an unreadable file must still
    // leave the fleet administered — the fail-closed direction.
  }
  const reg = cleanGrantRegistry(raw);
  return { ...reg, administered: hasActiveMembers(await loadMembers(root)) };
}

export async function saveGrants(root: string, reg: GrantRegistry): Promise<string> {
  const path = grantsPath(root);
  await mkdir(batonDir(root), { recursive: true });
  // `administered` is deliberately not written: see loadGrants.
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ version: GRANTS_VERSION, grants: reg.grants }, null, 2)}\n`);
  await rename(tmp, path);
  return path;
}

/** Read, change, write, under the same lock — so two admins granting at once
 *  cannot lose one of the grants. */
export function withGrants(
  root: string,
  change: (reg: GrantRegistry) => GrantRegistry,
): Promise<GrantRegistry> {
  return withLock(grantsPath(root), async () => {
    const next = change(await loadGrants(root));
    await saveGrants(root, next);
    return next;
  });
}
