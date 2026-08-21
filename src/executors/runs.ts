// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What survives a daemon restart: one file per run under `.baton/dispatch/`.
 *
 * Deliberately not one ledger (P2-E4). Two daemons on one repo cannot then
 * corrupt each other's bookkeeping — last writer wins per slug, which is the
 * right outcome, because a slug has exactly one run.
 *
 * The rule reattachment must not break (P2-E3): a daemon that restarted has
 * LOST the output stream of everything it launched. It can still stop the
 * process, and it must not claim more than that. An adopted run comes back as
 * `state: 'unknown'`, `stopOnly: true` — reporting `running` would promise an
 * observation nobody can deliver.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutorId, RunMode, RunState } from './types.js';

export interface DispatchRun {
  slug: string;
  agentId: string;
  executor: ExecutorId;
  mode: RunMode;
  /** null when the backend does not expose one (an Orca handle, say). */
  pid: number | null;
  startedAt: string;
  /** Our own record that this run is over. Outranks a recycled pid. */
  endedAt?: string;
}

export interface ReattachedRun extends DispatchRun {
  state: RunState;
  /** The daemon can stop this, and cannot observe it. Always true here. */
  stopOnly: true;
}

const DISPATCH_DIR = join('.baton', 'dispatch');

/** Slugs come from plan files. `../../id_rsa` must never become a path. */
const SAFE_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fileFor(root: string, slug: string): string {
  if (!SAFE_SLUG.test(slug)) {
    throw new Error(`refusing an unsafe run slug: ${JSON.stringify(slug)}`);
  }
  return join(root, DISPATCH_DIR, `${slug}.json`);
}

/** tmp + rename: a torn write must not become a half-parsed run record. */
export async function recordRun(root: string, run: DispatchRun): Promise<void> {
  const file = fileFor(root, run.slug);
  await mkdir(join(root, DISPATCH_DIR), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(run, null, 2), 'utf-8');
  await rename(tmp, file);
}

export async function readRun(root: string, slug: string): Promise<DispatchRun | null> {
  try {
    return JSON.parse(await readFile(fileFor(root, slug), 'utf-8')) as DispatchRun;
  } catch {
    // Missing, unreadable or unsafe: all "no run", none of them fatal.
    return null;
  }
}

export async function clearRun(root: string, slug: string): Promise<void> {
  try {
    await rm(fileFor(root, slug), { force: true });
  } catch {
    // Already gone is the desired state.
  }
}

export async function listRuns(root: string): Promise<DispatchRun[]> {
  let names: string[];
  try {
    names = await readdir(join(root, DISPATCH_DIR));
  } catch {
    return [];
  }
  const runs: DispatchRun[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    // One corrupt record must not hide every live run from a daemon that just
    // restarted, so this skips rather than throws.
    const run = await readRun(root, name.slice(0, -'.json'.length));
    if (run) runs.push(run);
  }
  return runs;
}

/**
 * Adopt whatever is still alive after a restart, and forget the rest.
 *
 * `isAlive` throwing counts as dead: wrong in the safe direction. Forgetting a
 * run that somehow survives costs an orphan process; adopting a dead one puts a
 * phantom on the board that nothing will ever clear.
 */
export async function reattachRuns(
  root: string,
  isAlive: (pid: number) => boolean,
): Promise<ReattachedRun[]> {
  const adopted: ReattachedRun[] = [];
  for (const run of await listRuns(root)) {
    // pids are recycled; our own end record outranks whatever holds it now.
    const finished = run.endedAt !== undefined;
    let alive = false;
    if (!finished && run.pid !== null) {
      try {
        alive = isAlive(run.pid);
      } catch {
        alive = false;
      }
    }
    if (alive) {
      adopted.push({ ...run, state: 'unknown', stopOnly: true });
    } else {
      await clearRun(root, run.slug);
    }
  }
  return adopted;
}
