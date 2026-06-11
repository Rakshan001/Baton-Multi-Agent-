/**
 * Safe + hardened git execution. Runs `git` with an argv array via execa — no
 * shell, so no parsing/expansion/injection regardless of user-controlled task text.
 *
 * Adapted from handler.dev's shell-free exec approach
 * (.refs/handler.dev/packages/server/src/lib/safe-exec.ts, MIT) and from
 * daintree's hardened git factory — per-command timeout, env sanitization, and
 * non-interactive `-c` config flags
 * (.refs/daintree/electron/utils/hardenedGit.ts, Apache-2.0). Daintree wraps
 * simple-git; here the same hardening concepts are reimplemented over execa for
 * Baton's local, git-only use. See NOTICE.
 */
import { execa } from 'execa';

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Hard ceiling on any single git command, so a hung git never blocks Baton. */
export const GIT_TIMEOUT_MS = 30_000;

/**
 * Config overrides passed as `-c key=value` before every subcommand. They take
 * precedence over repo/global config and neutralize anything that could prompt,
 * page, or run external commands during an otherwise-local operation.
 */
const HARDENED_GIT_CONFIG = [
  'core.pager=cat', // never page (would block on a non-TTY)
  'credential.helper=', // no credential helper
  'core.askpass=', // no GUI/askpass prompt
  'core.sshCommand=', // no custom ssh command from repo config
  'protocol.ext.allow=never', // block ext:: transport (RCE vector)
  'core.hooksPath=', // don't run repo hooks during our own git calls
  'core.fsmonitor=false', // avoid fsmonitor races
  'core.quotepath=false', // emit literal UTF-8 paths (keeps porcelain v2 parsing simple)
  'core.precomposeunicode=true', // NFC paths on macOS so comparisons are stable
] as const;

/** Env vars that could redirect git to an editor, pager, prompt, or alt config. */
const BLOCKED_GIT_ENV_KEYS = new Set([
  'EDITOR',
  'GIT_ASKPASS',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_EDITOR',
  'GIT_EXEC_PATH',
  'GIT_EXTERNAL_DIFF',
  'GIT_PAGER',
  'GIT_PROXY_COMMAND',
  'GIT_SEQUENCE_EDITOR',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_TEMPLATE_DIR',
  'PAGER',
  'PREFIX',
  'SSH_ASKPASS',
]);

/** Prepend the hardened `-c` config flags to a git argv. Pure; exported for tests. */
export function hardenedArgs(args: string[]): string[] {
  const flags: string[] = [];
  for (const cfg of HARDENED_GIT_CONFIG) flags.push('-c', cfg);
  return [...flags, ...args];
}

let cachedEnv: NodeJS.ProcessEnv | undefined;

/** Sanitized, non-interactive environment for git. Pure; exported for tests. */
export function gitEnv(
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (BLOCKED_GIT_ENV_KEYS.has(upper) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(upper)) {
      delete env[key];
    }
  }
  // Non-interactive: never prompt for credentials or open a TTY dialog.
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GCM_INTERACTIVE = 'Never';
  // `true` exits 0 with empty stdout, so any helper that ignores the prompt flag
  // fails fast instead of hanging. Not on PATH on Windows; the flags above cover it.
  if (platform !== 'win32') env.GIT_ASKPASS = 'true';
  // Keep non-ASCII paths intact across iconv on Windows / minimal Linux locales.
  env.LC_CTYPE = platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
  env.LC_ALL = ''; // let the specific LC_CTYPE above take effect
  env.LC_MESSAGES = 'C';
  env.LANGUAGE = '';
  return env;
}

function execOpts(cwd?: string, signal?: AbortSignal) {
  cachedEnv ??= gitEnv();
  return {
    cwd,
    env: cachedEnv,
    extendEnv: false,
    timeout: GIT_TIMEOUT_MS,
    ...(signal ? { cancelSignal: signal } : {}),
  } as const;
}

/** Run a git command. Throws on non-zero exit / timeout. Returns trimmed stdout. */
export async function git(args: string[], cwd?: string, signal?: AbortSignal): Promise<string> {
  const { stdout } = await execa('git', hardenedArgs(args), execOpts(cwd, signal));
  return stdout.trim();
}

/**
 * Is a CLI on the PATH and runnable? Cross-platform (no `which`/`command -v`):
 * we just try to run it. Shared by every binary probe (tar, graphify, agents).
 */
export async function probeBinary(cmd: string, args: string[] = ['--version'], timeoutMs = 5000): Promise<boolean> {
  try {
    await execa(cmd, args, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/** Run a git command without throwing. Inspect `.ok` for success. */
export async function gitTry(args: string[], cwd?: string, signal?: AbortSignal): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execa('git', hardenedArgs(args), execOpts(cwd, signal));
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: (e.stdout ?? '').trim(),
      stderr: (e.stderr ?? e.message ?? '').trim(),
    };
  }
}
