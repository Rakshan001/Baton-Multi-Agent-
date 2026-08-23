// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getCliInstallState, installCliSymlink, installCliUserPath, uninstallCli,
} from '../electron/cli-install.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
  }
});

describe('cli uninstall honesty', () => {
  it('removes the PATH/symlink marker and keeps the data dir by default', () => {
    const home = mkdtempSync(join(tmpdir(), 'baton-uninstall-'));
    dirs.push(home);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const data = join(home, '.baton');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'memory.json'), '{"keep":true}\n');

    const bin = join(home, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    // Point install at a fake cli.js inside the temp home.
    const cliJs = join(home, 'cli.js');
    writeFileSync(cliJs, '#!/usr/bin/env node\nconsole.log("ok")\n', { mode: 0o755 });

    // Force symlink install into our temp bin by making /usr/local/bin unwritable path fail —
    // installCliSymlink tries /usr/local/bin first; use BATON override via cwd bin by
    // installing user-path style on non-win with BATON_WIN_PATH_FILE.
    process.env.BATON_WIN_PATH_FILE = join(data, 'desktop-user-path.txt');
    installCliUserPath(join(home, 'cli-dir'));
    expect(getCliInstallState().installed).toBe(true);
    expect(existsSync(process.env.BATON_WIN_PATH_FILE)).toBe(true);

    const result = uninstallCli({ deleteDataDir: false });
    expect(result.cliRemoved).toBe(true);
    expect(result.dataDirKept).toBe(true);
    expect(existsSync(join(data, 'memory.json'))).toBe(true);
    expect(existsSync(process.env.BATON_WIN_PATH_FILE)).toBe(false);
    expect(getCliInstallState().installed).toBe(false);
  });

  it('only deletes the data dir when explicitly requested', () => {
    const home = mkdtempSync(join(tmpdir(), 'baton-uninstall-del-'));
    dirs.push(home);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const data = join(home, '.baton');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'memory.json'), '{"keep":true}\n');
    process.env.BATON_WIN_PATH_FILE = join(data, 'desktop-user-path.txt');
    installCliUserPath(join(home, 'cli-dir'));

    const result = uninstallCli({ deleteDataDir: true });
    expect(result.dataDirKept).toBe(false);
    expect(existsSync(data)).toBe(false);
  });
});
