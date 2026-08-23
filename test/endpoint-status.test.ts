// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P17 step 2 — `baton endpoints status`, the screen someone opens when their
 * own models are not being used.
 *
 * Everything it renders was decided elsewhere and tested there. What this file
 * pins is that the rendering does not quietly upgrade any of it: an unverified
 * list is labelled, an indeterminate probe is not "up", and an `unknown` egress
 * class reads as a warning rather than as safety.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bus } from '../src/events.js';
import { endpointsStatus, endpointStatusLines, type EndpointStatusRow } from '../src/endpoints/status.js';

const row = (over: Partial<EndpointStatusRow> = {}): EndpointStatusRow => ({
  id: 'fleet',
  kind: 'openai-compatible',
  url: 'https://gw.corp.internal/v1',
  gateway: 'omniroute',
  egress: 'local',
  health: 'ok',
  detail: 'fleet answered HTTP 200',
  models: [{ id: 'qwen3-coder', endpointId: 'fleet', egress: 'local' }],
  verified: true,
  fetchedAt: '2026-08-22T23:00:00.000Z',
  usable: true,
  unusable: null,
  reachableBy: ['codex'],
  unreachableBy: ['claude', 'cursor', 'gemini', 'antigravity', 'aider', 'opencode', 'openclaw'],
  ...over,
});

const render = (rows: EndpointStatusRow[]): string => endpointStatusLines(rows).join('\n');

// 🔴 Found by review. `/api/endpoints/status` called `endpointsStatus()`, which
// published on the bus; `/api/events` streams every event; the settings pane
// re-fetches on any event. Read -> publish -> read, forever, for as long as the
// pane was open. D5's rule ("a client never triggers an upstream call") exists
// to prevent exactly this, so a READ publishes nothing at all.
describe('reading the status is not an event', () => {
  it('publishes nothing when someone asks for the status', async () => {
    const seen: string[] = [];
    const off = bus.onAny((e) => seen.push(e.event.type));
    try {
      await endpointsStatus(process.cwd(), {});
    } finally {
      off();
    }
    expect(seen).toEqual([]);
  });
});

// An endpoint whose keyRef never resolved was reported `unauthorized` — a
// rejection the gateway never issued, because it was never asked. P16-E8 keeps
// those two apart on purpose: different cause, different fix.
describe('an endpoint we never asked about', () => {
  it('is not reported as rejected by the gateway', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'baton-status-'));
    await writeFile(
      join(dir, 'baton.config.json'),
      JSON.stringify({ endpoints: { fleet: { kind: 'openai-compatible', url: 'https://gw.corp.internal/v1', models: ['m'], keyRef: 'env:NOT_SET' } } }),
      'utf-8',
    );
    const [row] = await endpointsStatus(dir, {});
    expect(row.usable).toBe(false);
    expect(row.health).not.toBe('unauthorized');
    expect(row.health).toBe('unknown');
    expect(row.detail).toContain('NOT_SET');
  });
});

describe('endpointStatusLines', () => {
  it('says there is nothing configured rather than printing an empty screen', () => {
    expect(render([])).toContain('No endpoints');
  });

  it('shows what is served, from where, and how it was reached', () => {
    const out = render([row()]);
    expect(out).toContain('fleet');
    expect(out).toContain('gw.corp.internal');
    expect(out).toContain('qwen3-coder');
  });

  // The badge the whole product rests on.
  it('badges every model with whether the code leaves the network', () => {
    expect(render([row()])).toContain('On your network');
    expect(render([row({ egress: 'external', models: [{ id: 'opus', endpointId: 'fleet', egress: 'external' }] })]))
      .toContain('Leaves your network');
  });

  // 🔴 unknown reads as a warning, never as safe.
  it('never renders an unknown egress class as safe', () => {
    const out = render([row({ egress: 'unknown', models: [{ id: 'm', endpointId: 'fleet', egress: 'unknown' }] })]);
    expect(out).toContain('Unverified');
    expect(out).not.toContain('On your network');
  });

  it('labels a fallback list as unverified rather than passing it off as live', () => {
    const out = render([row({ verified: false, detail: 'could not ask fleet what it serves' })]);
    expect(out).toContain('unverified');
    expect(out).toContain('could not ask');
  });

  it('does not report an indeterminate probe as up', () => {
    const out = render([row({ health: 'unknown', detail: 'fleet did not answer within 2000ms' })]);
    expect(out).not.toMatch(/\bup\b/);
    expect(out).toContain('did not answer');
  });

  it('shows the age of what it is showing, so nothing reads as "now"', () => {
    expect(render([row()])).toContain('2026-08-22T23:00:00.000Z');
  });

  // P19 renders these rows; the CLI states the same fact, because "why is my
  // Antigravity task not using the gateway" is answered by seeing it listed.
  it('says which agents can reach it, and which cannot', () => {
    const out = render([row()]);
    expect(out).toContain('codex');
    expect(out).toMatch(/cannot|no custom endpoint|vendor/i);
    expect(out).toContain('antigravity');
  });

  it('names an endpoint that is configured but unusable, instead of hiding it', () => {
    const out = render([row({ usable: false, unusable: 'GW_KEY is not set in this environment' })]);
    expect(out).toContain('GW_KEY');
  });
});
