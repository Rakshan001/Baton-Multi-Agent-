// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Is this endpoint answering, and will it accept our credential?
 *
 * Two states that look the same from a distance and have completely different
 * fixes, which is why they stay two states: `unreachable` (start the gateway,
 * check the URL) and `unauthorized` (fix the key). Baton does not compute
 * uptime, load-balance, or probe individual servers behind the gateway — that
 * is what a gateway is for. This answers one question, once per TTL.
 *
 * Cheap by construction: a dispatch round may weigh twenty queued tasks against
 * the same endpoint, and twenty probes for one answer is a self-inflicted
 * outage.
 */
import type { EndpointConfig } from './config.js';
import { resolveEndpointKey } from './launch-env.js';

/**
 * `unknown` is not a softer `unreachable` — it is the honest answer when the
 * gateway did not reply IN TIME (P17-E1). A refused socket is a fact; silence
 * is not, and reporting silence as either "up" or "down" invents one. Every
 * caller treats `unknown` as unusable for launching, and every UI renders it as
 * a warning rather than as health.
 */
export type EndpointHealth = 'ok' | 'unreachable' | 'unauthorized' | 'unknown';

export interface EndpointProbe {
  state: EndpointHealth;
  detail: string;
}

/** Long enough that a dispatch round asks once; short enough that a gateway
 *  someone just started is not remembered as down. */
export const HEALTH_TTL_MS = 30_000;
const TIMEOUT_MS = 2_000;

const cache = new Map<string, { at: number; probe: EndpointProbe }>();
// A result-only cache lets every concurrent caller through, because none has
// resolved yet — which is exactly the Monday-9am case P17-E4 is about.
const inFlight = new Map<string, Promise<EndpointProbe>>();

export function clearEndpointHealthCache(): void {
  cache.clear();
  inFlight.clear();
}

/** The header each dialect authenticates with. */
function authHeader(endpoint: EndpointConfig, key: string): Record<string, string> {
  return endpoint.kind === 'anthropic-compatible'
    ? { 'x-api-key': key }
    : { authorization: `Bearer ${key}` };
}

export interface ProbeOptions {
  now?: number;
  /** Overridable so a test can wait 150ms for silence instead of two seconds. */
  timeoutMs?: number;
}

/**
 * The URL to probe, or `null` when the stored `health` would take the request
 * somewhere other than the endpoint's own origin.
 *
 * Defence at the sink as well as at the door (config.ts validates too): the
 * request that carries the credential is the one place worth checking twice.
 */
export function probeUrlFor(endpoint: EndpointConfig): string | null {
  let probe: URL;
  let origin: string;
  try {
    origin = new URL(endpoint.url).origin;
    probe = new URL(endpoint.health, endpoint.url);
  } catch {
    return null;
  }
  return probe.origin === origin && !probe.username && !probe.password ? probe.href : null;
}

export async function probeEndpoint(
  endpoint: EndpointConfig,
  env: NodeJS.ProcessEnv,
  opts: ProbeOptions = {},
): Promise<EndpointProbe> {
  const now = opts.now ?? Date.now();
  const cacheKey = `${endpoint.id} ${endpoint.url}${endpoint.health}`;
  const hit = cache.get(cacheKey);
  if (hit && now - hit.at < HEALTH_TTL_MS) return hit.probe;

  const running = inFlight.get(cacheKey);
  if (running) return running;

  const key = resolveEndpointKey(endpoint, env);
  const pending = ask(endpoint, key, opts.timeoutMs ?? TIMEOUT_MS).then((probe) => {
    cache.set(cacheKey, { at: now, probe });
    inFlight.delete(cacheKey);
    return probe;
  }, (e: unknown) => {
    inFlight.delete(cacheKey);
    throw e;
  });
  inFlight.set(cacheKey, pending);
  return pending;
}

async function ask(endpoint: EndpointConfig, key: string | null, timeoutMs: number): Promise<EndpointProbe> {
  // The credential goes in a header. A key in a query string is a key in every
  // proxy log between here and the gateway (P16-E5).
  const headers = key ? authHeader(endpoint, key) : {};
  const target = probeUrlFor(endpoint);
  if (target === null) {
    return { state: 'unreachable', detail: `${endpoint.id}: its health path does not stay on ${hostOf(endpoint.url)} — refusing to send the credential` };
  }
  try {
    const res = await fetch(target, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 || res.status === 403) {
      return { state: 'unauthorized', detail: `${endpoint.id} answered HTTP ${res.status}` };
    }
    // Anything else — including 404 — means something answered. A gateway with
    // no /health path is reachable, and calling it "down" would refuse work
    // that would have run.
    return { state: 'ok', detail: `${endpoint.id} answered HTTP ${res.status}` };
  } catch (e) {
    // A timeout is indeterminate; a refused socket or an unresolvable name is
    // not. The host is named because "the URL is internal and I am off the VPN"
    // is the most common support ticket this error answers (P17-E5).
    const where = hostOf(endpoint.url);
    if ((e as Error).name === 'TimeoutError') {
      return { state: 'unknown', detail: `${endpoint.id} (${where}) did not answer within ${timeoutMs}ms — it may be slow, or unreachable from this machine` };
    }
    return { state: 'unreachable', detail: `${endpoint.id} (${where}) did not answer: ${(e as Error).message}` };
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
