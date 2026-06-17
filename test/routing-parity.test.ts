/**
 * The web demo-mode routing mirror (web/src/lib/routing.ts) must stay in
 * lockstep with the backend (src/routing.ts) — this is the test that makes
 * silent divergence impossible.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROUTING as serverConfig, scoreSeverity as serverSeverity,
  suggestAgent as serverSuggest, suggestRoute as serverRoute,
} from '../src/routing.js';
import {
  BUILTIN_ROUTING as webConfig, scoreSeverity as webSeverity,
  suggestAgent as webSuggest, suggestRoute as webRoute,
} from '../web/src/lib/routing.js';

const TASKS = [
  'fix the crash on login',
  'redesign the settings page component',
  'plan the architecture for payments',
  'build the release artifacts',
  'investigate the failing regression in css layout',
  'write release notes for v2',
  'UI bug: broken responsive layout',
  'research a design doc for the new frontend',
];

describe('web routing mirror parity', () => {
  it('builtin configs are identical', () => {
    expect(webConfig).toEqual(serverConfig);
  });

  it.each(TASKS)('agrees with the backend on: %s', (task) => {
    const a = serverSuggest(task, serverConfig);
    const b = webSuggest(task, webConfig);
    expect(b.agent).toBe(a.agent);
    expect(b.model).toBe(a.model);
    expect(b.matched).toEqual(a.matched);
    expect(b.source).toBe(a.source);
  });

  it.each(TASKS)('severity + rich route agree on: %s', (task) => {
    expect(webSeverity(task)).toEqual(serverSeverity(task));
    expect(webRoute(task, webConfig)).toEqual(serverRoute(task, serverConfig));
  });

  it.each(TASKS)('rich route agrees in manual and single modes: %s', (task) => {
    const manual = { mode: 'manual' as const };
    const single = { mode: 'single' as const, single: { agent: 'claude', model: 'opus' } };
    expect(webRoute(task, { ...webConfig, ...manual })).toEqual(serverRoute(task, { ...serverConfig, ...manual }));
    expect(webRoute(task, { ...webConfig, ...single })).toEqual(serverRoute(task, { ...serverConfig, ...single }));
  });
});
