// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P2-E3 / P2-E4 — what survives a daemon restart.
 *
 * One file per run under `.baton/dispatch/`, deliberately not one ledger. Two
 * daemons on one repo then cannot corrupt each other's bookkeeping: last writer
 * wins per slug, which is correct, because a slug has exactly one run (P2-E4).
 *
 * The rule reattachment must not break: a daemon that restarts has LOST the
 * output stream of anything it launched. It can still stop the process, and it
 * must not pretend to anything more. `state: 'unknown'` and `stopOnly: true`
 * say exactly that (P2-E3) — an adopted run reported as `running` promises an
 * observation nobody can deliver.
 */
import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearRun, listRuns, reattachRuns, readRun, recordRun } from '../src/executors/runs.js';

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'baton-runs-'));
}

const run = (over: Record<string, unknown> = {}) => ({
  slug: 'add-auth',
  agentId: 'claude',
  executor: 'local' as const,
  mode: 'headless' as const,
  pid: 4242,
  startedAt: '2026-08-21T10:00:00.000Z',
  ...over,
});

describe('recordRun / readRun', () => {
  it('round-trips a run', async () => {
    const dir = await root();
    await recordRun(dir, run());
    expect(await readRun(dir, 'add-auth')).toMatchObject({ slug: 'add-auth', pid: 4242 });
  });

  it('a slug with no run is null, not an empty run', async () => {
    expect(await readRun(await root(), 'nothing')).toBeNull();
  });

  it('one file per slug, so two runs never share a file to race on', async () => {
    const dir = await root();
    await recordRun(dir, run());
    await recordRun(dir, run({ slug: 'fix-tests', pid: 99 }));
    const files = await readdir(join(dir, '.baton', 'dispatch'));
    expect(files.sort()).toEqual(['add-auth.json', 'fix-tests.json']);
  });

  it('the second write for a slug replaces the first — a slug has one run', async () => {
    const dir = await root();
    await recordRun(dir, run());
    await recordRun(dir, run({ pid: 777 }));
    expect((await readRun(dir, 'add-auth'))?.pid).toBe(777);
    expect(await listRuns(dir)).toHaveLength(1);
  });

  it('leaves no temp file behind — a torn write must not become a run', async () => {
    const dir = await root();
    await recordRun(dir, run());
    const files = await readdir(join(dir, '.baton', 'dispatch'));
    expect(files.filter((f) => !f.endsWith('.json'))).toEqual([]);
  });

  it('refuses a slug that would escape the dispatch directory', async () => {
    // The slug reaches this from a plan file. `../../id_rsa` must not be a path.
    const dir = await root();
    await expect(recordRun(dir, run({ slug: '../escape' }))).rejects.toThrow();
    await expect(readRun(dir, '../escape')).resolves.toBeNull();
  });

  it('clearRun removes the record and is safe to call twice', async () => {
    const dir = await root();
    await recordRun(dir, run());
    await clearRun(dir, 'add-auth');
    await clearRun(dir, 'add-auth');
    expect(await readRun(dir, 'add-auth')).toBeNull();
  });
});

describe('listRuns', () => {
  it('is empty before anything has been dispatched', async () => {
    expect(await listRuns(await root())).toEqual([]);
  });

  it('skips a corrupt record instead of failing the whole list', async () => {
    // One bad file must not hide every live run from the daemon that restarted.
    const dir = await root();
    await recordRun(dir, run());
    await mkdir(join(dir, '.baton', 'dispatch'), { recursive: true });
    await writeFile(join(dir, '.baton', 'dispatch', 'broken.json'), '{ not json', 'utf-8');
    expect(await listRuns(dir)).toHaveLength(1);
  });
});

describe('reattachRuns — P2-E3', () => {
  it('adopts a live process as stop-only, with an unknown state', async () => {
    // The daemon lost the output stream when it died. Reporting `running` would
    // promise an observation it cannot deliver.
    const dir = await root();
    await recordRun(dir, run());
    const adopted = await reattachRuns(dir, () => true);
    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatchObject({ slug: 'add-auth', state: 'unknown', stopOnly: true });
  });

  it('forgets a run whose process is gone, rather than showing a ghost', async () => {
    const dir = await root();
    await recordRun(dir, run());
    expect(await reattachRuns(dir, () => false)).toEqual([]);
    expect(await readRun(dir, 'add-auth')).toBeNull();
  });

  it('never adopts a run with no pid — there is nothing to stop', async () => {
    const dir = await root();
    await recordRun(dir, run({ pid: null }));
    expect(await reattachRuns(dir, () => true)).toEqual([]);
  });

  it('a liveness check that throws is treated as dead, not as alive', async () => {
    // Wrong in the safe direction: forgetting a run that is somehow alive costs
    // an orphan; adopting a dead one puts a phantom on the board.
    const dir = await root();
    await recordRun(dir, run());
    expect(await reattachRuns(dir, () => { throw new Error('EPERM'); })).toEqual([]);
  });

  it('an already-ended run is not adopted even if the pid was recycled', async () => {
    // pids are reused. `endedAt` is our own record that this run is over, and it
    // outranks whatever process now holds that number.
    const dir = await root();
    await recordRun(dir, run({ endedAt: '2026-08-21T11:00:00.000Z' }));
    expect(await reattachRuns(dir, () => true)).toEqual([]);
  });
});
