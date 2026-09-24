// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getCliInstallState, installCliSymlink, installCliUserPath, uninstallCli,
} from '../electron/cli-install.ts';
import { usePrivateHome } from './helpers/private-home.js';

describe('cli uninstall honesty', () => {
  // uninstallCli deletes ~/.baton, so this suite MUST NOT be able to see the
  // real one. It used to set HOME and USERPROFILE per test and never restore
  // them, which left a since-deleted temp path as $HOME for every later test in
  // the same worker.
  const home = usePrivateHome('baton-uninstall-');

  // Not the helper's business: it owns the machine-wide state redirect, and
  // this one is Baton's own escape hatch for the Windows PATH marker.
  afterEach(() => { delete process.env.BATON_WIN_PATH_FILE; });

  it('removes the PATH/symlink marker and keeps the data dir by default', () => {
    const data = join(home(), '.baton');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'memory.json'), '{"keep":true}\n');

    const bin = join(home(), '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    // Point install at a fake cli.js inside the temp home.
    const cliJs = join(home(), 'cli.js');
    writeFileSync(cliJs, '#!/usr/bin/env node\nconsole.log("ok")\n', { mode: 0o755 });

    // Force symlink install into our temp bin by making /usr/local/bin unwritable path fail —
    // installCliSymlink tries /usr/local/bin first; use BATON override via cwd bin by
    // installing user-path style on non-win with BATON_WIN_PATH_FILE.
    process.env.BATON_WIN_PATH_FILE = join(data, 'desktop-user-path.txt');
    installCliUserPath(join(home(), 'cli-dir'));
    expect(getCliInstallState().installed).toBe(true);
    expect(existsSync(process.env.BATON_WIN_PATH_FILE)).toBe(true);

    const result = uninstallCli({ deleteDataDir: false });
    expect(result.cliRemoved).toBe(true);
    expect(result.dataDirKept).toBe(true);
    expect(existsSync(join(data, 'memory.json'))).toBe(true);
    expect(existsSync(process.env.BATON_WIN_PATH_FILE)).toBe(false);
    expect(getCliInstallState().installed).toBe(false);
  });

  it('targets ~/.baton whatever the product is branded as', () => {
    // Regression: dataDir() once derived `~/.${brand.commandName}`. In this repo
    // commandName is "baton", so the two coincided and every test passed — the
    // divergence only appeared in a rebranded build, where uninstall deleted an
    // empty `~/.<brand>` and left the user's real knowledge base behind after
    // they explicitly asked for it to be removed.
    //
    // The CLI writes to `~/.baton` unconditionally (src/daemons.ts:52,
    // src/agents/registry.ts:134). The app must address the same directory, so
    // this path is not a branding concern and must not be derived from one.
    mkdirSync(join(home(), '.baton'), { recursive: true });

    const result = uninstallCli({ deleteDataDir: false });
    expect(result.dataDirPath).toBe(join(home(), '.baton'));
    expect(result.dataDirKept).toBe(true);
    expect(existsSync(join(home(), '.baton'))).toBe(true);
  });

  it('only deletes the data dir when explicitly requested', () => {
    const data = join(home(), '.baton');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'memory.json'), '{"keep":true}\n');
    process.env.BATON_WIN_PATH_FILE = join(data, 'desktop-user-path.txt');
    installCliUserPath(join(home(), 'cli-dir'));

    const result = uninstallCli({ deleteDataDir: true });
    expect(result.dataDirKept).toBe(false);
    expect(existsSync(data)).toBe(false);
  });
});
