// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * PATH augmentation for binaries Baton shells out to (tmux, graphify, agent
 * CLIs). When the daemon is launched from a GUI / non-login shell, PATH often
 * lacks the dirs where these live (Homebrew's /opt/homebrew/bin, ~/.local/bin),
 * so detection silently fails even though the tool is installed.
 *
 * We only APPEND missing dirs, never reorder existing ones, so a user's chosen
 * binary always wins. Git is unaffected: src/util/exec.ts builds git's env from
 * process.env, so calling this early just makes git's PATH equally complete.
 */
import { delimiter, win32 } from 'node:path';
import { homedir } from 'node:os';

/**
 * Standard install dirs a process commonly misses.
 *
 * Windows needs this at least as much as POSIX does, for a reason that has no
 * POSIX equivalent: `winget install` writes the new PATH entry to the registry
 * and broadcasts a change that a RUNNING process never receives. So the shell
 * that just installed uv cannot run it — `winget` reports the package already
 * installed and the next line says `uv: The term 'uv' is not recognized`. The
 * user is told to open a new terminal, which is a strange thing for a setup
 * tool to require of the machine it just set up.
 *
 * The two dirs are two tools' answers to the same question: winget puts its
 * shims in the Links dir, while uv's own installer — and every executable
 * `uv tool install` creates, graphify.exe included — goes to ~/.local/bin.
 */
export function commonBinDirs(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'win32') {
    // Derived rather than required: a service or a stripped environment may not
    // carry LOCALAPPDATA, and its location under the profile is fixed anyway.
    const localAppData = env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local');
    return [
      win32.join(localAppData, 'Microsoft', 'WinGet', 'Links'), // winget shims
      win32.join(home, '.local', 'bin'), // uv itself, and `uv tool install` output
    ];
  }
  return [
    '/opt/homebrew/bin', // Apple-silicon Homebrew
    '/usr/local/bin', // Intel Homebrew / common installs
    '/usr/bin',
    '/bin',
    `${home}/.local/bin`, // uv tools (graphify), pipx, etc.
  ];
}

/**
 * Append any common bin dir missing from `env.PATH` (idempotent). Mutates and
 * returns the resulting PATH string.
 */
export function ensureBinPath(env: NodeJS.ProcessEnv = process.env): string {
  const entries = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const have = new Set(entries);
  const missing = commonBinDirs().filter((d) => !have.has(d));
  if (missing.length === 0) return env.PATH ?? '';
  env.PATH = [...entries, ...missing].join(delimiter);
  return env.PATH;
}
