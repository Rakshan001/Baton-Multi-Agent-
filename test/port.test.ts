// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PORT_SCAN_CAP, nextFreePort, portFree, servePortClash } from '../src/util/port.js';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((res) => s.close(() => res()))));
});

async function occupy(port: number, host = '127.0.0.1', ipv6Only = false): Promise<void> {
  const s = createServer();
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject);
    s.listen({ port, host, ipv6Only }, () => resolve());
  });
  servers.push(s);
}

/** Can this machine bind IPv6 loopback at all? */
const hasIpv6 = await new Promise<boolean>((res) => {
  const s = createServer();
  s.once('error', () => res(false));
  s.listen(0, '::1', () => s.close(() => res(true)));
});

describe('nextFreePort', () => {
  it('returns start when it is free and not in used', async () => {
    const used = new Set<number>();
    const p = await nextFreePort(37111, used);
    expect(p).toBe(37111);
    expect(used.has(37111)).toBe(true);
  });

  it('skips ports already in the used set', async () => {
    const used = new Set([37121, 37122]);
    const p = await nextFreePort(37121, used);
    expect(p).toBe(37123);
  });

  it('skips a port that is actually bound', async () => {
    await occupy(37131);
    const p = await nextFreePort(37131, new Set());
    expect(p).toBeGreaterThan(37131);
    expect(await portFree(37131)).toBe(false);
  });

  it('throws when the scan cap is exhausted', async () => {
    const start = 37141;
    const used = new Set<number>();
    for (let i = 0; i <= PORT_SCAN_CAP; i++) used.add(start + i);
    await expect(nextFreePort(start, used)).rejects.toThrow(/no free port/);
  });

  it('rejects a non-port start', async () => {
    await expect(nextFreePort(0, new Set())).rejects.toThrow(/invalid port/);
  });
});

describe('portFree', () => {
  it('is true for a port nobody holds', async () => {
    expect(await portFree(37161)).toBe(true);
  });

  // `localhost` resolves to ::1 first on macOS, so a daemon (or any app) on
  // ::1 alone owns http://localhost:<port> even though 127.0.0.1 is bindable.
  it.runIf(hasIpv6)('is false for a port held on ::1 only', async () => {
    await occupy(37171, '::1');
    expect(await portFree(37171)).toBe(false);
  });

  it.runIf(hasIpv6)('is false for a port held on the IPv6 wildcard only', async () => {
    await occupy(37181, '::', true);
    expect(await portFree(37181)).toBe(false);
  });
});

describe('servePortClash', () => {
  const root = join(tmpdir(), 'baton-a');
  it('never moves when --port was explicit', () => {
    expect(servePortClash({ portExplicit: true, root, holderRoot: join(tmpdir(), 'other') }))
      .toBe('fail-explicit');
  });

  it('refuses a live holder of the same root', () => {
    expect(servePortClash({ portExplicit: false, root, holderRoot: root }))
      .toBe('fail-same-root');
  });

  it('treats the same path spelled two ways as one root', () => {
    expect(servePortClash({
      portExplicit: false,
      root: join(root, '.'),
      holderRoot: root,
    })).toBe('fail-same-root');
  });

  it('advances when the holder is a different project', () => {
    expect(servePortClash({ portExplicit: false, root, holderRoot: join(tmpdir(), 'baton-b') }))
      .toBe('advance');
  });

  it('advances when the holder is unknown', () => {
    expect(servePortClash({ portExplicit: false, root, holderRoot: null }))
      .toBe('advance');
  });
});
