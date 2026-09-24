// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Two desktop Start clicks used to pick the same port: each built a fresh
 * `used` set from the fleet, which does not list a child until after listen.
 */
import { describe, expect, it } from 'vitest';
import {
  ServeStartGate, collectUsedPorts, rootIsBusy,
} from '../electron/spawn.js';
import { nextFreePort } from '../src/util/port.js';

const identity = (p: string) => p;

describe('collectUsedPorts', () => {
  it('unions fleet, reserved, and in-flight spawn ports', () => {
    expect([...collectUsedPorts([7077, null], [7078], [7079, undefined])].sort())
      .toEqual([7077, 7078, 7079]);
  });
});

describe('rootIsBusy', () => {
  it('treats an inflight or spawned canonical key as busy', () => {
    expect(rootIsBusy('/a', {
      fleet: [], spawnKeys: [], inflight: ['/a'], canonical: identity,
    })).toBe(true);
    expect(rootIsBusy('/a', {
      fleet: [], spawnKeys: ['/a'], inflight: [], canonical: identity,
    })).toBe(true);
  });

  it('canonicalizes a live fleet root so a symlink spelling still matches', () => {
    const canonical = (p: string) => (p === '/alias' ? '/real' : p);
    expect(rootIsBusy('/real', {
      fleet: [{ root: '/alias', state: 'running' }],
      spawnKeys: [], inflight: [], canonical,
    })).toBe(true);
    expect(rootIsBusy('/real', {
      fleet: [{ root: '/alias', state: 'stopped' }],
      spawnKeys: [], inflight: [], canonical,
    })).toBe(false);
  });

  it('does not treat a different root as busy', () => {
    expect(rootIsBusy('/a', {
      fleet: [{ root: '/b', state: 'running' }],
      spawnKeys: ['/c'], inflight: ['/d'], canonical: identity,
    })).toBe(false);
  });
});

describe('ServeStartGate', () => {
  it('runs enqueued picks one at a time', async () => {
    const gate = new ServeStartGate();
    let concurrent = 0;
    let max = 0;
    await Promise.all([0, 1, 2].map(() => gate.enqueue(async () => {
      concurrent++;
      max = Math.max(max, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent--;
    })));
    expect(max).toBe(1);
  });

  it('does not wedge after a thrown pick', async () => {
    const gate = new ServeStartGate();
    await expect(gate.enqueue(async () => { throw new Error('boom'); })).rejects.toThrow(/boom/);
    expect(await gate.enqueue(async () => 7)).toBe(7);
  });

  it('a shared reserved set under the gate assigns distinct ports', async () => {
    const start = 39321;
    const gate = new ServeStartGate();
    const ports = await Promise.all([0, 1].map(() => gate.enqueue(async () => {
      const used = collectUsedPorts([], gate.reserved, []);
      const p = await nextFreePort(start, used);
      gate.reserved.add(p);
      return p;
    })));
    expect(new Set(ports).size).toBe(2);
  });
});
