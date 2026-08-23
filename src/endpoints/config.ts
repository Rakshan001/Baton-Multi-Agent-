// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The `endpoints` block of `baton.config.json` — your own model servers.
 *
 *   { "endpoints": {
 *       "fleet": {
 *         "kind": "anthropic-compatible",   // | openai-compatible | ollama
 *         "url": "https://gw.corp.internal:4000",
 *         "models": ["kimi-k2", "qwen3-coder"],
 *         "health": "/health",
 *         "keyRef": "env:BATON_FLEET_KEY"   // never the key itself
 *       },
 *       "allowPaidFallback": false          // reserved: not an endpoint
 *   } }
 *
 * Validated on its own, like the `executor` block and for the same reason: a
 * typo here must not disarm routing, which the team relies on every day.
 *
 * Two of the refusals below are not typo handling:
 *
 *   E2  A `keyRef` that resolves to nothing leaves the endpoint UNUSABLE, with
 *       the reason. Never fall through to an unauthenticated call — a gateway
 *       that answers without a key is one anyone on the network can bill you on.
 *   E3  A literal credential — in a `key` field, in the URL, or written into
 *       `keyRef` — refuses to load at all. `baton.config.json` is committed in
 *       some repos, so a key that loads is a key in a diff and in a brief.
 */

import { readFile } from 'node:fs/promises';
import { detectSecret } from '../memory.js';
import { withManagedEnv } from './managed-credentials.js';
import { join } from 'node:path';

export type EndpointKind = 'anthropic-compatible' | 'openai-compatible' | 'ollama';

export interface EndpointConfig {
  /** The key it was declared under. Declaration order is precedence (E4). */
  id: string;
  kind: EndpointKind;
  url: string;
  /** Empty means "not declared here" — P17 fills it from the gateway. */
  models: string[];
  health: string;
  keyRef: string | null;
  /** Which env var the gateway reads the credential from. Gateways disagree
   *  (`x-api-key` vs a bearer), so this is declarable; null uses the default
   *  for the kind. A NAME, never a value. */
  authEnv: string | null;
  /** Which gateway administers this endpoint. Kept as an opaque string here on
   *  purpose: validating the NAME belongs to the adapter registry, so no gateway
   *  is spelled outside `gateways/` (D4). */
  gateway: string | null;
  /** An admin's answer to "does this keep our code on our network?", when the
   *  address cannot prove it either way. Outranks inference — see egress.ts. */
  egress: 'local' | 'external' | null;
  /** false ⇒ never launch against it. The reason is in `unusable`. */
  usable: boolean;
  unusable: string | null;
}

export interface EndpointsConfig {
  endpoints: EndpointConfig[];
  /** Cost safety (P16): a gateway outage must not promote queued work onto a
   *  paid frontier model. Off unless someone wrote it down. */
  allowPaidFallback: boolean;
}

export const DEFAULT_ENDPOINTS_CONFIG: EndpointsConfig = { endpoints: [], allowPaidFallback: false };

const KINDS: ReadonlySet<string> = new Set(['anthropic-compatible', 'openai-compatible', 'ollama']);

/** A credential written where a reference belongs. Refused on sight. */
const SECRET_FIELDS = ['key', 'apiKey', 'api_key', 'token', 'secret', 'password'] as const;

/** Query parameters that carry a credential in the URL itself. */
const SECRET_PARAMS = ['key', 'api_key', 'apikey', 'access_token', 'token', 'password'];

const RESERVED = 'allowPaidFallback';

/** A single leading slash, then no `@` (userinfo), no `\` and no whitespace —
 *  the characters that let a suffix retarget the request's host. `//host` is
 *  refused by the leading-slash-then-non-slash rule. */
const SAFE_HEALTH_PATH = /^\/(?!\/)[^@\s\\]*$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function trimmed(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const out = value.trim();
  return out.length > 0 ? out : null;
}

/** An http(s) URL with no credential in it, or the reason it was refused. */
function checkUrl(raw: unknown): { url: string } | { error: 'shape' | 'credential' } {
  const text = trimmed(raw);
  if (text === null) return { error: 'shape' };
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { error: 'shape' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { error: 'shape' };
  if (parsed.username || parsed.password) return { error: 'credential' };
  for (const [name] of parsed.searchParams) {
    if (SECRET_PARAMS.includes(name.toLowerCase())) return { error: 'credential' };
  }
  // A key parked in a PATH segment used to load, and this phase publishes `url`
  // to the settings pane and the phone. `detectSecret` is the repo's own
  // detector, so one check covers every shape it already knows.
  if (detectSecret(text) !== null) return { error: 'credential' };
  return { url: text };
}

/**
 * Resolve a `keyRef`. Only `env:` today; `keychain:` is recognised so it gets
 * an honest "not yet" rather than being mistaken for a literal key — adding it
 * later is one more case here.
 *
 * Never returns the secret: callers only ever need to know that it resolved.
 */
function resolveKeyRef(ref: string, env: NodeJS.ProcessEnv): { ok: true } | { ok: false; reason: string; literal?: true } {
  const colon = ref.indexOf(':');
  const scheme = colon === -1 ? '' : ref.slice(0, colon);
  const rest = colon === -1 ? '' : ref.slice(colon + 1).trim();

  if (scheme === 'env') {
    if (!rest) return { ok: false, reason: 'keyRef names no environment variable' };
    return trimmed(env[rest]) !== null
      ? { ok: true }
      : { ok: false, reason: `${rest} is not set in this environment` };
  }
  if (scheme === 'keychain') {
    return { ok: false, reason: 'keychain refs are not resolved yet — use an env: ref' };
  }
  return { ok: false, reason: 'expected a reference like "env:NAME"', literal: true };
}

/**
 * Never throws, never rejects the file. Returns the endpoints to use and every
 * reason the result differs from what was written.
 *
 * `env` is a parameter rather than a read of `process.env` so the resolution
 * half of this is as testable as the parsing half.
 */
export function validateEndpointsConfig(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): { config: EndpointsConfig; errors: string[] } {
  const errors: string[] = [];
  const file = record(raw);
  if (!file || file.endpoints === undefined) {
    return { config: DEFAULT_ENDPOINTS_CONFIG, errors };
  }

  const block = record(file.endpoints);
  if (!block) {
    // P15-E1. Routing and executor are validated by their own functions and
    // never see this, which is the whole point of a separate block.
    errors.push('endpoints: expected an object — no endpoints configured');
    return { config: DEFAULT_ENDPOINTS_CONFIG, errors };
  }

  let allowPaidFallback = false;
  if (block[RESERVED] !== undefined) {
    if (typeof block[RESERVED] === 'boolean') {
      allowPaidFallback = block[RESERVED];
    } else {
      errors.push(`endpoints.${RESERVED}: expected true or false — staying off`);
    }
  }

  const endpoints: EndpointConfig[] = [];
  for (const [id, value] of Object.entries(block)) {
    if (id === RESERVED) continue;

    // JS object keys that look like array indices are enumerated first, so an
    // all-digit name would silently jump the queue — and precedence here IS
    // declaration order.
    if (/^\d+$/.test(id)) {
      errors.push(`endpoints.${id}: an all-digit name is not kept in declaration order — rename it`);
      continue;
    }

    const ep = record(value);
    if (!ep) {
      errors.push(`endpoints.${id}: expected an object — ignored`);
      continue;
    }

    // E3 first: a file carrying a literal credential should not get as far as
    // being partly accepted.
    const leaked = SECRET_FIELDS.filter((f) => ep[f] !== undefined);
    if (leaked.length) {
      for (const f of leaked) {
        errors.push(`endpoints.${id}.${f}: a literal credential — use "keyRef": "env:NAME" instead. Endpoint not loaded`);
      }
      continue;
    }

    if (typeof ep.kind !== 'string' || !KINDS.has(ep.kind)) {
      errors.push(`endpoints.${id}.kind: expected anthropic-compatible, openai-compatible or ollama — endpoint not loaded`);
      continue;
    }

    const url = checkUrl(ep.url);
    if ('error' in url) {
      // The URL is never echoed: the refusal it most matters for is the one
      // where the URL contains the key.
      errors.push(url.error === 'credential'
        ? `endpoints.${id}.url: carries a credential — use "keyRef" instead. Endpoint not loaded`
        : `endpoints.${id}.url: expected an http(s) URL — endpoint not loaded`);
      continue;
    }

    let models: string[] = [];
    if (ep.models !== undefined) {
      const list = Array.isArray(ep.models) ? ep.models.map(trimmed).filter((m): m is string => m !== null) : null;
      if (list === null) {
        errors.push(`endpoints.${id}.models: expected an array of model names — none registered`);
      } else {
        models = list;
      }
    }

    // A name, not a value: `authEnv: "sk-…"` is someone pasting a key one
    // field lower than the one that already refuses it.
    let authEnv: string | null = null;
    if (ep.authEnv !== undefined) {
      const name = trimmed(ep.authEnv);
      if (name === null || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        errors.push(`endpoints.${id}.authEnv: expected the NAME of an environment variable — using the default for ${ep.kind}`);
      } else {
        authEnv = name;
      }
    }

    const gateway = trimmed(ep.gateway);
    if (ep.gateway !== undefined && gateway === null) {
      errors.push(`endpoints.${id}.gateway: expected a gateway name — using the default`);
    }

    let egress: 'local' | 'external' | null = null;
    if (ep.egress !== undefined) {
      if (ep.egress === 'local' || ep.egress === 'external') {
        egress = ep.egress;
      } else {
        errors.push(`endpoints.${id}.egress: expected "local" or "external" — leaving it to be inferred from the address`);
      }
    }

    let keyRef: string | null = null;
    let usable = true;
    let unusable: string | null = null;
    if (ep.keyRef !== undefined) {
      const ref = trimmed(ep.keyRef);
      if (ref === null) {
        errors.push(`endpoints.${id}.keyRef: expected a reference like "env:NAME" — endpoint not loaded`);
        continue;
      }
      const resolved = resolveKeyRef(ref, env);
      if (resolved.ok) {
        keyRef = ref;
      } else if (resolved.literal) {
        errors.push(`endpoints.${id}.keyRef: ${resolved.reason}, not a key. Endpoint not loaded`);
        continue;
      } else {
        keyRef = ref;
        usable = false;
        unusable = resolved.reason;
        errors.push(`endpoints.${id}.keyRef: ${resolved.reason} — endpoint unusable`);
      }
    }

    // 🔴 The probe used to build `url + health`, so a health of
    // "@evil.example/v1" made the request go to evil.example with the gateway
    // demoted to userinfo — carrying the key. Only a plain absolute path is
    // accepted; anything else falls back to /health, which still reaches the
    // right host.
    let health = '/health';
    if (ep.health !== undefined) {
      const wanted = trimmed(ep.health);
      if (wanted !== null && SAFE_HEALTH_PATH.test(wanted)) {
        health = wanted;
      } else {
        errors.push(`endpoints.${id}.health: expected a path beginning with '/' and containing no '@' — using /health`);
      }
    }

    endpoints.push({ id, kind: ep.kind as EndpointKind, url: url.url, models, health, keyRef, authEnv, gateway, egress, usable, unusable });
  }

  return { config: { endpoints, allowPaidFallback }, errors };
}

/**
 * Which endpoint serves a model. Declaration order and nothing else (E4):
 * reordering because a key failed to resolve would make the server your code
 * runs on depend on the shell the daemon happened to start in. An unusable
 * winner still wins — and P16 refuses with its reason, which is the point.
 */
export function endpointForModel(config: EndpointsConfig, model: string): EndpointConfig | null {
  return config.endpoints.find((e) => e.models.includes(model)) ?? null;
}

/** Models more than one endpoint claims. `doctor` prints these; nothing picks silently. */
export function shadowedModels(config: EndpointsConfig): { model: string; winner: string; shadowedBy: string[] }[] {
  const byModel = new Map<string, string[]>();
  for (const ep of config.endpoints) {
    for (const model of ep.models) {
      const ids = byModel.get(model) ?? [];
      if (!ids.includes(ep.id)) ids.push(ep.id);
      byModel.set(model, ids);
    }
  }
  return [...byModel]
    .filter(([, ids]) => ids.length > 1)
    .map(([model, ids]) => ({ model, winner: ids[0], shadowedBy: ids.slice(1) }));
}

/** A missing or unreadable file is "no endpoints", never an error: dispatch has
 *  to keep working while somebody is halfway through editing it. */
export async function loadEndpointsConfig(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ config: EndpointsConfig; errors: string[] }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(root, 'baton.config.json'), 'utf-8'));
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      config: DEFAULT_ENDPOINTS_CONFIG,
      errors: missing ? [] : [`could not read baton.config.json: ${(e as Error).message} — no endpoints configured`],
    };
  }
  // Credentials this machine was ENROLLED with live in a 0600 store, not in the
  // committed config and not in the shell. Merged here so `resolveEndpointKey`
  // keeps its single synchronous scheme (`env:`) rather than learning a second
  // way to find a secret. The shell still wins on a name it already sets.
  return validateEndpointsConfig(raw, await withManagedEnv(root, env));
}
