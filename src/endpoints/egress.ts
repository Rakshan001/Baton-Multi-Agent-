// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Does reaching this endpoint keep the customer's code on their own network?
 *
 * Computed from the ENDPOINT, never from a model's name. `gpt-4o` served by a
 * customer's own vLLM is local; a model called `local-llama` behind someone's
 * cloud proxy is external. A name is a string a vendor chose; the address is a
 * fact.
 *
 * 🔴 Never guess `local`. The two mistakes are not symmetric: calling an
 * external endpoint local puts a developer's code on a third party's servers
 * under a badge that promises otherwise, while calling a local one `unknown`
 * costs an admin one line of config. So anything not provably private answers
 * `unknown`, and every caller treats `unknown` exactly like `external`.
 */
import type { EndpointConfig } from './config.js';

export type EgressClass = 'local' | 'external' | 'unknown';

/** Suffixes reserved for private networks, so a match is a fact rather than a hunch. */
const INTERNAL_SUFFIXES = ['.internal', '.local', '.lan', '.intranet', '.home.arpa'];

function isPrivateIpv4(host: string): boolean | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  if (octets.some((o) => Number.isNaN(o) || o > 255)) return null;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 192 && b === 168) return true;
  // 172.16.0.0 – 172.31.255.255. One octet decides it, so the bound is explicit.
  if (a === 172 && b >= 16 && b <= 31) return true;
  // Link-local, which is as un-routable as it gets.
  if (a === 169 && b === 254) return true;
  return false;
}

export function classifyEgress(endpoint: EndpointConfig): EgressClass {
  // An admin's declaration outranks inference in both directions: they know
  // about the VPN, and about the loopback port that is really a tunnel.
  if (endpoint.egress) return endpoint.egress;

  let host: string;
  try {
    host = new URL(endpoint.url).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }

  // URL keeps IPv6 in brackets.
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (bare === '::1' || bare === '0:0:0:0:0:0:0:1') return 'local';
  // fc00::/7 — IPv6 unique-local.
  if (/^f[cd][0-9a-f]{2}:/.test(bare)) return 'local';

  const privateIp = isPrivateIpv4(bare);
  if (privateIp !== null) return privateIp ? 'local' : 'external';

  if (bare === 'localhost' || bare.endsWith('.localhost')) return 'local';
  if (INTERNAL_SUFFIXES.some((suffix) => bare.endsWith(suffix))) return 'local';

  // A single-label host (`gpu`, `gateway`) is *probably* internal DNS, and
  // probably is precisely what this function may not do. The admin can say so
  // with `"egress": "local"`.
  if (!bare.includes('.')) return 'unknown';

  return 'external';
}
