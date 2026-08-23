// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
export function isAllowedDashboardUrl(
  url: string,
  knownPorts: ReadonlySet<number> | readonly number[],
): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]' && host !== '::1') {
    return false;
  }
  const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
  if (!Number.isInteger(port) || port <= 0) return false;
  const set = knownPorts instanceof Set ? knownPorts : new Set(knownPorts);
  return set.has(port);
}
