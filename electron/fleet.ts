// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Wrap dist/daemons.js — do not reimplement fleet discovery or stopping. */
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
type Daemons = typeof import('../dist/daemons.js');

function resolveDaemons(): string {
  if (process.env.BATON_DIST_DIR) {
    const p = join(process.env.BATON_DIST_DIR, 'daemons.js');
    if (existsSync(p)) return pathToFileURL(p).href;
  }
  for (const p of [
    join(here, '..', '..', 'dist', 'daemons.js'),
    join(here, '..', 'dist', 'daemons.js'),
  ]) {
    if (existsSync(p)) return pathToFileURL(p).href;
  }
  throw new Error('dist/daemons.js not found — run npm run build');
}

let mod: Promise<Daemons> | null = null;
const daemons = (): Promise<Daemons> => (mod ??= import(resolveDaemons()) as Promise<Daemons>);

export type FleetState = 'running' | 'stale' | 'stopped' | 'missing';

export interface FleetRow {
  pid: number | null;
  port: number | null;
  root: string;
  name: string;
  state: FleetState;
  startedAt: string | null;
  writeEnabled: boolean;
  host: boolean;
  version: string | null;
}

export async function listFleet(): Promise<FleetRow[]> {
  const d = await daemons();
  return (await d.listVerifiedDaemons()).map((v) => ({
    pid: v.pid,
    port: v.port,
    root: v.root,
    name: basename(v.root),
    state: (v.status === 'live' ? 'running' : 'stale') as FleetState,
    startedAt: v.startedAt,
    writeEnabled: v.writeEnabled,
    host: v.host,
    version: v.version,
  }));
}

export async function stopFleetDaemon(pid: number, port: number): Promise<string> {
  const d = await daemons();
  const rec = (await d.listVerifiedDaemons()).find((r) => r.pid === pid && r.port === port);
  if (!rec) return 'failed';
  if (rec.status === 'stale') return 'refused-stale';
  return d.stopDaemon(rec);
}

export async function cleanFleetRecord(pid: number, port: number): Promise<void> {
  await (await daemons()).removeDaemonRecord(pid, port);
}

export async function cleanDeadFleetRecords(): Promise<number> {
  return (await (await daemons()).sweepDeadDaemonRecords()).length;
}
