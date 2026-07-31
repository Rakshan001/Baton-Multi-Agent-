/**
 * The pure half of the Daemons card (web/src/lib/fleet.ts).
 *
 * The ordering rule worth a test file: self first, live before stale, and a
 * stale leftover NEVER above a living daemon — the row order is how someone
 * scanning for "which one did I mean" reads the machine.
 */
import { describe, expect, it } from 'vitest';
import { DEMO_FLEET, fleetOrder, folderName, middleTruncate, uptimeLabel } from '../web/src/lib/fleet';
import type { FleetDaemon } from '../web/src/types';

const d = (over: Partial<FleetDaemon>): FleetDaemon => ({
  pid: 1, port: 7077, root: '/u/dev/x', startedAt: new Date().toISOString(),
  version: '0', writeEnabled: true, host: false, status: 'live', self: false, ...over,
});

describe('fleetOrder', () => {
  it('self first, then live by port, stale always last', () => {
    const rows = fleetOrder([
      d({ port: 7091, status: 'stale' }),
      d({ port: 7080 }),
      d({ port: 7079 }),
      d({ port: 7077, self: true }),
    ]);
    expect(rows.map((r) => r.port)).toEqual([7077, 7079, 7080, 7091]);
    expect(rows[rows.length - 1].status).toBe('stale');
  });

  it('does not mutate its input', () => {
    const input = [d({ port: 2 }), d({ port: 1 })];
    fleetOrder(input);
    expect(input.map((r) => r.port)).toEqual([2, 1]);
  });
});

describe('folderName / middleTruncate', () => {
  it('names a daemon by its last path segment, trailing slash or not', () => {
    expect(folderName('/Users/you/dev/fatfox')).toBe('fatfox');
    expect(folderName('/Users/you/dev/fatfox/')).toBe('fatfox');
    expect(folderName('/')).toBe('/');
  });

  it('truncates the middle, keeping both recognisable ends', () => {
    const p = '/Users/you/Desktop/Developer/playground/some-long-project-name';
    const t = middleTruncate(p, 30);
    expect(t.length).toBeLessThanOrEqual(31);
    expect(t.startsWith('/Users/you')).toBe(true);
    expect(t.endsWith('name')).toBe(true);
    expect(middleTruncate('/short', 30)).toBe('/short');
  });
});

describe('uptimeLabel', () => {
  it('reads as a human would say it, and never goes negative', () => {
    const now = Date.now();
    expect(uptimeLabel(new Date(now - 30_000).toISOString(), now)).toBe('just started');
    expect(uptimeLabel(new Date(now - 5 * 60_000).toISOString(), now)).toBe('up 5m');
    expect(uptimeLabel(new Date(now - 90 * 60_000).toISOString(), now)).toBe('up 1h 30m');
    expect(uptimeLabel(new Date(now + 60_000).toISOString(), now)).toBe('—'); // clock skew
    expect(uptimeLabel('not-a-date', now)).toBe('—');
  });
});

describe('demo fixtures', () => {
  it('showcase exactly one self and one stale row — Clean up is half the feature', () => {
    expect(DEMO_FLEET.filter((r) => r.self).length).toBe(1);
    expect(DEMO_FLEET.filter((r) => r.status === 'stale').length).toBe(1);
    // The self row must be live: a dashboard served by a stale daemon is a
    // contradiction the card should never have to draw.
    expect(DEMO_FLEET.find((r) => r.self)?.status).toBe('live');
  });
});
