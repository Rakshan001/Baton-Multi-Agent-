// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { delimiter, win32 } from 'node:path';
import { ensureBinPath, commonBinDirs } from '../src/util/path-env.js';

describe('ensureBinPath', () => {
  it('appends missing common bin dirs (POSIX)', () => {
    if (process.platform === 'win32') return; // no-op on Windows
    const env = { PATH: '/usr/bin' };
    ensureBinPath(env);
    const parts = env.PATH.split(delimiter);
    expect(parts).toContain('/opt/homebrew/bin');
    expect(parts).toContain('/usr/local/bin');
  });

  it('is idempotent and never reorders existing entries', () => {
    if (process.platform === 'win32') return;
    const env = { PATH: '/opt/homebrew/bin:/my/custom' };
    ensureBinPath(env);
    expect(env.PATH.startsWith('/opt/homebrew/bin:/my/custom')).toBe(true); // existing kept first
    const after = env.PATH;
    ensureBinPath(env);
    expect(env.PATH).toBe(after); // second pass changes nothing
  });

  it('handles an empty PATH', () => {
    if (process.platform === 'win32') return;
    const env: NodeJS.ProcessEnv = {};
    ensureBinPath(env);
    expect(env.PATH?.split(delimiter)).toEqual(commonBinDirs());
  });
});

/**
 * Windows.
 *
 * commonBinDirs returned [] on win32, so ensureBinPath — the thing that finds a
 * tool the launching shell's PATH has not caught up with — did nothing at all
 * there. The failure this produced is exact: `winget install astral-sh.uv`
 * succeeds, winget reports the package already installed, and the very next
 * command in the same shell says `uv: The term 'uv' is not recognized`, because
 * winget wrote the PATH entry to the registry and the running process still
 * holds the environment it started with.
 *
 * Both dirs matter and they are different tools' answers to the same question:
 * winget shims land in its Links dir, while uv's own installer and everything
 * `uv tool install` produces (graphify.exe among them) land in ~/.local/bin.
 *
 * Paths are built with win32.join and the platform is passed in, so this runs
 * on the POSIX machines that actually execute CI.
 */
describe('commonBinDirs on Windows', () => {
  const HOME = 'C:\\Users\\rak';
  const LOCALAPPDATA = 'C:\\Users\\rak\\AppData\\Local';

  it('finds a winget-installed uv the running shell cannot see', () => {
    const dirs = commonBinDirs(HOME, 'win32', { LOCALAPPDATA });
    expect(dirs).toContain(win32.join(LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'));
  });

  it('finds what `uv tool install` produced', () => {
    const dirs = commonBinDirs(HOME, 'win32', { LOCALAPPDATA });
    expect(dirs).toContain(win32.join(HOME, '.local', 'bin'));
  });

  it('derives LOCALAPPDATA from home when the variable is absent', () => {
    // A service or a stripped environment may not carry it; the layout is fixed.
    const dirs = commonBinDirs(HOME, 'win32', {});
    expect(dirs).toContain(win32.join(HOME, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links'));
  });

  it('never leaks Windows dirs onto POSIX', () => {
    const dirs = commonBinDirs('/Users/rak', 'darwin', { LOCALAPPDATA });
    expect(dirs.some((d) => d.includes('WinGet'))).toBe(false);
    expect(dirs).toContain('/opt/homebrew/bin');
  });
});
