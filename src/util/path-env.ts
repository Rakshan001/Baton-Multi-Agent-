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
import { delimiter } from 'node:path';
import { homedir } from 'node:os';

/** Standard install dirs a GUI-launched process commonly misses (POSIX only). */
export function commonBinDirs(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === 'win32') return [];
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
