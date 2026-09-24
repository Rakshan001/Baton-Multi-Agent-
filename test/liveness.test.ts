// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Phase 7 / I1 — a task claimed over MCP is kept alive by that MCP session's
 * presence row (`sess-p<pid>`), including a claim recorded before phase 7 under
 * the old `pid-<pid>` slug.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHookSession } from '../src/signals.js';
import { livenessProbe } from '../src/liveness.js';
import type { PipelineTask } from '../src/pipeline.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'baton-liveness-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const TWO_HOURS_AGO = new Date(Date.now() - 2 * 3600_000).toISOString();
const task = (sessionSlug: string): PipelineTask =>
  ({ slug: 't-a', state: 'active', claimedBy: { agent: 'claude', sessionSlug, at: TWO_HOURS_AGO } }) as unknown as PipelineTask;

describe('livenessProbe finds the MCP heartbeat', () => {
  it('a sess-p claim reads the fresh presence row', () => {
    registerHookSession(root, 'sess-p4242', 'claude', root);
    expect(Date.now() - livenessProbe(root, { mtime: () => 0 })(task('sess-p4242'))).toBeLessThan(60_000);
  });
  it('a legacy pid- claim reads the same row', () => {
    registerHookSession(root, 'sess-p4242', 'claude', root);
    expect(Date.now() - livenessProbe(root, { mtime: () => 0 })(task('pid-4242'))).toBeLessThan(60_000);
  });
});
