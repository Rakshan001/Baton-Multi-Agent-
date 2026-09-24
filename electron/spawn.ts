// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Spawn bundled CLI under ELECTRON_RUN_AS_NODE. Never stdio:'ignore'. */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadBrand } from './brand.js';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const RING = 20;

export interface SpawnHandle {
  child: ChildProcess;
  lines: string[];
  /** Port passed as `--port`, if any — so in-flight Starts can skip it. */
  port?: number;
}

function packagedResourcesPath(): string | null {
  // Avoid a static electron import — this module is unit-tested in Node.
  try {
    const electron = require('electron') as { app?: { isPackaged?: boolean } };
    if (electron?.app?.isPackaged && typeof (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath === 'string') {
      return (process as NodeJS.Process & { resourcesPath: string }).resourcesPath;
    }
  } catch {
    /* not running under Electron */
  }
  return null;
}

/**
 * Ordered candidate paths for one file in the CLI's dist/.
 *
 * Pure, and it takes its roots as arguments rather than reading them, because
 * the packaged layout is the branch that broke: `require('electron')` throws
 * under vitest, so a resolver that reads process.resourcesPath itself can only
 * ever be exercised in its dev branch — which is how fleet.ts shipped searching
 * the two dev dirs and nothing else.
 */
export function distCandidates(
  file: string,
  opts: { here: string; resources?: string | null; commandName: string },
): string[] {
  const out: string[] = [];
  // Packaged first: a dev checkout sitting beside an installed app must never
  // shadow the payload that app actually ships.
  if (opts.resources) out.push(join(opts.resources, opts.commandName, 'package', 'dist', file));
  out.push(join(opts.here, '..', '..', 'dist', file));
  out.push(join(opts.here, '..', 'dist', file));
  return out;
}

/** First candidate that exists, or throw naming the file that is missing. */
export function resolveDistEntry(file: string): string {
  const candidates = distCandidates(file, {
    here,
    resources: packagedResourcesPath(),
    commandName: loadBrand().commandName,
  });
  for (const p of candidates) if (existsSync(p)) return p;
  throw new Error(`dist/${file} not found — run npm run build`);
}

export function resolveCliEntry(): string {
  if (process.env.BATON_CLI_ENTRY && existsSync(process.env.BATON_CLI_ENTRY)) {
    return process.env.BATON_CLI_ENTRY;
  }
  return resolveDistEntry('cli.js');
}

/**
 * Argv for `serve` under ELECTRON_RUN_AS_NODE. Isolated so a test can pin
 * `--port` without spawning a child (Cursor's host exports ELECTRON_RUN_AS_NODE,
 * which makes an Electron binary launched from that shell exit as plain Node).
 */
export function serveArgs(cli: string, opts: { write?: boolean; port?: number } = {}): string[] {
  const args = [cli, 'serve'];
  if (opts.write) args.push('--write');
  if (opts.port != null) {
    if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
      throw new Error(`invalid port: ${opts.port}`);
    }
    args.push('--port', String(opts.port));
  }
  return args;
}

/**
 * First free dashboard port, skipping ports the fleet already claims.
 * Loads dist/util/port.js the same way fleet.ts loads dist/daemons.js — Electron
 * cannot import `src/` (separate tsconfig).
 */
export async function pickServePort(used: Set<number>): Promise<number> {
  const href = pathToFileURL(resolveDistEntry('util/port.js')).href;
  const { nextFreePort } = await import(href) as {
    nextFreePort: (start: number, used?: Set<number>) => Promise<number>;
  };
  return nextFreePort(7077, used);
}

/**
 * Serializes only the port-pick + spawn, not the post-spawn wait. Two Start
 * clicks must not call `nextFreePort` with separate `used` sets — that is how
 * they both land on 7078. The 800ms "is it up?" sleep stays outside so a
 * second project can pick while the first child is still booting.
 */
export class ServeStartGate {
  reserved = new Set<number>();
  inflight = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** Fleet ports ∪ reserved in-flight picks ∪ already-spawned children. */
export function collectUsedPorts(
  fleetPorts: Iterable<number | null | undefined>,
  reserved: Iterable<number>,
  spawnPorts: Iterable<number | undefined>,
): Set<number> {
  const used = new Set<number>();
  for (const p of reserved) used.add(p);
  for (const p of fleetPorts) if (p != null) used.add(p);
  for (const p of spawnPorts) if (p != null) used.add(p);
  return used;
}

/**
 * Same-root guard for Start. `key` and `inflight`/`spawnKeys` are already
 * canonical; fleet roots may still be a symlink spelling, so they go through
 * `canonical` before compare.
 */
export function rootIsBusy(
  key: string,
  opts: {
    fleet: ReadonlyArray<{ root: string; state: string }>;
    spawnKeys: Iterable<string>;
    inflight: Iterable<string>;
    canonical: (p: string) => string;
  },
): boolean {
  for (const s of opts.inflight) if (s === key) return true;
  for (const s of opts.spawnKeys) if (s === key) return true;
  return opts.fleet.some((r) => r.state === 'running' && opts.canonical(r.root) === key);
}

export function spawnServe(root: string, opts: { write?: boolean; port?: number } = {}): SpawnHandle {
  const cli = resolveCliEntry();
  const args = serveArgs(cli, opts);
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  const push = (buf: Buffer) => {
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      if (!line) continue;
      lines.push(line);
      if (lines.length > RING) lines.shift();
    }
  };
  child.stdout?.on('data', push);
  child.stderr?.on('data', push);
  return { child, lines, port: opts.port };
}

export function lastLines(h: SpawnHandle): string[] {
  return [...h.lines];
}
