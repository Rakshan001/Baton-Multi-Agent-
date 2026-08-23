// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Spawn bundled CLI under ELECTRON_RUN_AS_NODE. Never stdio:'ignore'. */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBrand } from './brand.js';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const RING = 20;

export interface SpawnHandle {
  child: ChildProcess;
  lines: string[];
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

export function resolveCliEntry(): string {
  if (process.env.BATON_CLI_ENTRY && existsSync(process.env.BATON_CLI_ENTRY)) {
    return process.env.BATON_CLI_ENTRY;
  }
  const brand = loadBrand();
  const resources = packagedResourcesPath();
  if (resources) {
    const p = join(resources, brand.commandName, 'package', 'dist', 'cli.js');
    if (existsSync(p)) return p;
  }
  for (const p of [join(here, '..', '..', 'dist', 'cli.js'), join(here, '..', 'dist', 'cli.js')]) {
    if (existsSync(p)) return p;
  }
  throw new Error('dist/cli.js not found — run npm run build');
}

export function spawnServe(root: string, opts: { write?: boolean } = {}): SpawnHandle {
  const cli = resolveCliEntry();
  const args = [cli, 'serve'];
  if (opts.write) args.push('--write');
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
  return { child, lines };
}

export function lastLines(h: SpawnHandle): string[] {
  return [...h.lines];
}
