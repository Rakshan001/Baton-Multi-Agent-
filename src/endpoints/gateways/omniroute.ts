// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The OmniRoute adapter — the one that ships (D4).
 *
 * OmniRoute serves an OpenAI-compatible `/v1/models`, and answers it **through
 * the caller's key**: a key with `model_access_mode: "restricted"` sees only its
 * `allowed_models`. That is not a convenience, it is the design — the picker
 * shows exactly what that person may use, and the gateway stays the single
 * source of truth for who may reach what. Baton keeping its own copy of that
 * policy is how two systems come to disagree about what an employee is allowed
 * to run.
 *
 * This file is the only place in `src/` allowed to spell a gateway's name.
 */
import type { EndpointConfig } from '../config.js';
import { resolveEndpointKey } from '../launch-env.js';
import type { GatewayAdapter, MintedKey, MintRequest } from './types.js';

/** Same budget as the health probe: an admin surface must not stall a dispatch. */
const TIMEOUT_MS = 4_000;

/** `{ object: "list", data: [{ id: "…" }] }` — the OpenAI shape, checked rather
 *  than trusted, so a stranger on the port cannot become a model list. */
function readOpenAiModelList(body: unknown): string[] | null {
  if (body === null || typeof body !== 'object') return null;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const ids = data
    .map((row) => (row !== null && typeof row === 'object' ? (row as { id?: unknown }).id : null))
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
  return ids.length === data.length ? ids : null;
}

/** Ollama's own dialect: `{ models: [{ name: "qwen3-coder:7b" }] }`. */
function readOllamaTagList(body: unknown): string[] | null {
  if (body === null || typeof body !== 'object') return null;
  const models = (body as { models?: unknown }).models;
  if (!Array.isArray(models)) return null;
  const ids = models
    .map((row) => (row !== null && typeof row === 'object' ? (row as { name?: unknown }).name : null))
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
  return ids.length === models.length ? ids : null;
}

/**
 * `https://gw/v1` is the ordinary OpenAI base-URL convention, and appending
 * `/v1/models` to it asks for `/v1/v1/models`. Join on the segment the base
 * already carries rather than blindly concatenating.
 */
function joinCatalogPath(url: string, path: string): string {
  const base = url.replace(/\/+$/, '');
  return base.endsWith('/v1') && path.startsWith('/v1/') ? base + path.slice('/v1'.length) : base + path;
}

async function fetchModels(
  endpoint: EndpointConfig,
  env: NodeJS.ProcessEnv,
  path: string,
  read: (body: unknown) => string[] | null,
): Promise<string[] | null> {
  const key = resolveEndpointKey(endpoint, env);
  // A key in a query string is a key in every proxy log between here and the
  // gateway, so it travels as a header or not at all.
  const headers: Record<string, string> = key
    ? endpoint.kind === 'anthropic-compatible'
      ? { 'x-api-key': key }
      : { authorization: `Bearer ${key}` }
    : {};
  try {
    const res = await fetch(joinCatalogPath(endpoint.url, path), {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return read(await res.json());
  } catch {
    return null;
  }
}

/**
 * `POST /api/v1/registered-keys` — the admin route that issues a key and
 * returns the raw value exactly once, the same shape `baton member add` uses
 * for member tokens. Anything other than a 201 carrying a string `key` is a
 * refusal, and a refusal produces no credential at all.
 */
async function mintKey(
  endpoint: EndpointConfig,
  env: NodeJS.ProcessEnv,
  request: MintRequest,
): Promise<MintedKey | null> {
  const admin = resolveEndpointKey(endpoint, env);
  // Without an admin credential we are not an admin. Against a gateway running
  // with auth disabled, posting anyway would mint keys for anyone who can reach
  // the port — so this refuses to make the request rather than trying it.
  if (!admin) return null;
  try {
    const res = await fetch(joinAdminPath(endpoint.url, '/api/v1/registered-keys'), {
      method: 'POST',
      headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `baton-member-${request.memberId}`,
        ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status !== 201) return null;
    const body = (await res.json()) as { key?: unknown; keyId?: unknown; expiresAt?: unknown };
    if (typeof body?.key !== 'string' || !body.key.trim()) return null;
    return {
      value: body.key,
      expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
      keyId: typeof body.keyId === 'string' && body.keyId.trim() ? body.keyId : null,
    };
  } catch {
    return null;
  }
}

/** The admin API sits at the gateway's ROOT, not under the OpenAI base path a
 *  `url` usually points at. */
function joinAdminPath(url: string, path: string): string {
  const base = url.replace(/\/+$/, '');
  return (base.endsWith('/v1') ? base.slice(0, -'/v1'.length) : base) + path;
}

async function revokeKey(endpoint: EndpointConfig, env: NodeJS.ProcessEnv, keyId: string): Promise<boolean> {
  const admin = resolveEndpointKey(endpoint, env);
  if (!admin) return false;
  try {
    const res = await fetch(
      // Encoded, not interpolated: an id is data, and pasting it into a path is
      // how `../../admin/settings` becomes a request nobody meant to make.
      joinAdminPath(endpoint.url, `/api/v1/registered-keys/${encodeURIComponent(keyId)}/revoke`),
      { method: 'POST', headers: { authorization: `Bearer ${admin}` }, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    // 404 is success: the key is not there, which is what we were asking for.
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

export const omnirouteAdapter: GatewayAdapter = {
  id: 'omniroute',
  catalog: (endpoint, env) => fetchModels(endpoint, env, '/v1/models', readOpenAiModelList),
  mintMemberKey: mintKey,
  revokeMemberKey: revokeKey,
};

/**
 * No gateway at all — a model runtime reached directly (GW-E7). Fully
 * supported: the picker works, and per-person grants do not, because there is
 * no admin surface to ask. Saying that is better than appearing broken.
 */
export const directAdapter: GatewayAdapter = {
  id: 'direct',
  catalog: (endpoint, env) =>
    endpoint.kind === 'ollama'
      ? fetchModels(endpoint, env, '/api/tags', readOllamaTagList)
      : fetchModels(endpoint, env, '/v1/models', readOpenAiModelList),
};
