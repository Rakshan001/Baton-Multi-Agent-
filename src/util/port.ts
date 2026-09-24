// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Loopback port allocation for `baton serve` and `baton setup`.
 *
 * A scan cap is mandatory: without it a full ephemeral range on a loaded
 * machine is a hang, not a "ports are busy" error. `start` plus twenty more
 * (21 candidates) is enough to walk past a handful of sibling daemons
 * starting at 7077.
 */
import { createServer } from 'node:net';
import { resolve } from 'node:path';

export const PORT_SCAN_CAP = 20;

/** Codes meaning "this machine has no IPv6 here" — nothing can hold the port there. */
const NO_IPV6 = new Set(['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EINVAL']);

function bindable(port: number, host: string, ipv6Only: boolean): Promise<boolean> {
  return new Promise((res) => {
    const s = createServer();
    s.once('error', (e: NodeJS.ErrnoException) => res(host !== '127.0.0.1' && NO_IPV6.has(e.code ?? '')));
    s.once('listening', () => s.close(() => res(true)));
    s.listen({ port, host, ipv6Only });
  });
}

/**
 * True if a TCP port is bindable on loopback right now — on BOTH stacks. The
 * dashboard URL is `http://localhost:<port>`, and `localhost` resolves to ::1
 * first on macOS, so a process on ::1 or `::` alone owns that URL even while
 * 127.0.0.1 is free. Probed one at a time: `::` covers ::1, so binding both
 * at once would collide with ourselves.
 */
export async function portFree(port: number): Promise<boolean> {
  for (const [host, v6only] of [['127.0.0.1', false], ['::1', false], ['::', true]] as const) {
    if (!(await bindable(port, host, v6only))) return false;
  }
  return true;
}

/**
 * First free port at/after `start`, skipping `used` (so callers don't
 * double-assign). Adds the winner to `used`. Scans `start..start+PORT_SCAN_CAP`
 * inclusive (PORT_SCAN_CAP + 1 candidates); throws if none is free, or past 65535.
 */
export async function nextFreePort(start: number, used: Set<number> = new Set()): Promise<number> {
  if (!Number.isInteger(start) || start < 1 || start > 65535) {
    throw new Error(`invalid port: ${start}`);
  }
  const last = Math.min(65535, start + PORT_SCAN_CAP);
  for (let p = start; p <= last; p++) {
    if (used.has(p) || !(await portFree(p))) continue;
    used.add(p);
    return p;
  }
  throw new Error(`no free port in ${start}–${last}`);
}

/**
 * What to do when `listen` throws EADDRINUSE.
 *
 * Explicit `--port` never moves. A live holder of this port serving the same
 * root is a duplicate daemon. Anything else (other project, or an unknown
 * process) may take the next free port — that is how two projects run at once.
 */
export type ServePortClash = 'fail-explicit' | 'fail-same-root' | 'advance';

export function servePortClash(opts: {
  portExplicit: boolean;
  root: string;
  holderRoot: string | null;
}): ServePortClash {
  if (opts.portExplicit) return 'fail-explicit';
  if (opts.holderRoot !== null && resolve(opts.holderRoot) === resolve(opts.root)) {
    return 'fail-same-root';
  }
  return 'advance';
}
