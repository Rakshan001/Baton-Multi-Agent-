// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Optional CLI on PATH. Uninstall reverses only what we created;
 * the machine data directory (shared with the CLI daemon registry) is kept
 * unless the user explicitly opts into deletion.
 */
import {
  existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadBrand } from './brand.js';
import { resolveCliEntry } from './spawn.js';

export type CliInstallKind = 'symlink' | 'path' | 'none';

export interface CliInstallState {
  kind: CliInstallKind;
  commandName: string;
  target: string | null;
  installed: boolean;
  detail: string;
}

export interface UninstallResult {
  cliRemoved: boolean;
  dataDirKept: boolean;
  dataDirPath: string;
  detail: string;
}

interface Saved { kind: CliInstallKind; path: string; commandName: string }

/** Machine data dir — same root the CLI daemon registry uses (src/daemons.ts). */
function dataDir(): string {
  return join(homedir(), `.${loadBrand().commandName}`);
}

function stateFile(): string {
  return join(dataDir(), 'desktop-cli-install.json');
}

function readSaved(): Saved | null {
  try { return JSON.parse(readFileSync(stateFile(), 'utf8')) as Saved; }
  catch { return null; }
}

function writeSaved(s: Saved): void {
  mkdirSync(dirname(stateFile()), { recursive: true });
  writeFileSync(stateFile(), `${JSON.stringify(s, null, 2)}\n`);
}

function clearSaved(): void {
  try { unlinkSync(stateFile()); } catch { /* gone */ }
}

export function bundledCliPath(): string {
  try { return resolveCliEntry(); }
  catch { return process.env.BATON_CLI_ENTRY ?? join(process.cwd(), 'dist', 'cli.js'); }
}

export function getCliInstallState(): CliInstallState {
  const brand = loadBrand();
  const saved = readSaved();
  if (!saved) {
    return {
      kind: 'none', commandName: brand.commandName, target: null,
      installed: false, detail: 'CLI not linked from this app',
    };
  }
  const ok = saved.kind === 'symlink' ? existsSync(saved.path) : true;
  return {
    kind: saved.kind, commandName: saved.commandName, target: saved.path,
    installed: ok, detail: ok ? `Installed at ${saved.path}` : 'Recorded install missing on disk',
  };
}

export function installCliSymlink(cliJs: string): CliInstallState {
  const brand = loadBrand();
  const name = brand.commandName;
  const candidates = ['/usr/local/bin', join(homedir(), '.local', 'bin')];
  let dir: string | null = null;
  for (const d of candidates) {
    try { mkdirSync(d, { recursive: true }); dir = d; break; }
    catch { /* next */ }
  }
  if (!dir) throw new Error('No writable bin directory for the CLI symlink');
  const link = join(dir, name);
  const wrapper = join(dir, `.${name}-app-cli`);
  writeFileSync(wrapper, `#!/bin/sh\nexec node "${cliJs}" "$@"\n`, { mode: 0o755 });
  try { if (existsSync(link)) unlinkSync(link); } catch { /* */ }
  symlinkSync(wrapper, link);
  writeSaved({ kind: 'symlink', path: link, commandName: name });
  return getCliInstallState();
}

export function installCliUserPath(cliDir: string): CliInstallState {
  const brand = loadBrand();
  if (process.platform !== 'win32' && !process.env.BATON_WIN_PATH_FILE) {
    throw new Error('User PATH install is Windows-only');
  }
  const marker = process.env.BATON_WIN_PATH_FILE ?? join(dataDir(), 'desktop-user-path.txt');
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, `${cliDir}\n`);
  writeSaved({ kind: 'path', path: cliDir, commandName: brand.commandName });
  return getCliInstallState();
}

export function uninstallCli(opts: { deleteDataDir?: boolean } = {}): UninstallResult {
  const data = dataDir();
  const saved = readSaved();
  let cliRemoved = false;
  if (saved) {
    if (saved.kind === 'symlink') {
      try {
        const st = lstatSync(saved.path);
        if (st.isSymbolicLink() || st.isFile()) unlinkSync(saved.path);
        const wrapper = join(dirname(saved.path), `.${saved.commandName}-app-cli`);
        if (existsSync(wrapper)) unlinkSync(wrapper);
        cliRemoved = true;
      } catch { /* best-effort */ }
    } else if (saved.kind === 'path') {
      const marker = process.env.BATON_WIN_PATH_FILE ?? join(dataDir(), 'desktop-user-path.txt');
      try { unlinkSync(marker); cliRemoved = true; } catch { /* */ }
    }
    clearSaved();
  }
  let dataDirKept = true;
  if (opts.deleteDataDir === true && existsSync(data)) {
    rmSync(data, { recursive: true, force: true });
    dataDirKept = false;
  }
  return {
    cliRemoved,
    dataDirKept,
    dataDirPath: data,
    detail: dataDirKept
      ? `CLI cleaned up; kept ${data} (graphs and memory)`
      : `CLI cleaned up; deleted ${data}`,
  };
}
