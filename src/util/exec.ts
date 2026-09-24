// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
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
  /** Output hit the caller's `maxBuffer`; `stdout` holds the first part only. */
  truncated?: true;
}

/** Hard ceiling on any single git command, so a hung git never blocks Baton. */
export const GIT_TIMEOUT_MS = 30_000;

/**
 * Most git processes Baton runs at once, across the whole process. A poll tick
 * fans out per task (board, conflicts, signals, worktrees all `Promise.all`),
 * so uncapped it runs N gits at once and a 50-worktree hub stalls the event
 * loop ~200 ms. One global queue bounds every fan-out, and whatever nests them,
 * where a per-site limit would multiply instead. 8 measured best: 4 is slower,
 * 16 is no kinder to the loop.
 *
 * Queue wait is NOT covered by `GIT_TIMEOUT_MS` — the timeout starts when the
 * process does. By design: under load a call waits its turn rather than fail.
 * Measured cost is interactive latency, ~0.4 s at N=20 worktrees and ~1.5 s at
 * N=50, on a 2 s tick whose `running` guard already skips a beat.
 */
export const GIT_MAX_CONCURRENT = 8;

/**
 * A FIFO concurrency limiter: at most `max` of the wrapped functions run at
 * once, and waiters start in arrival order. A finished job hands its slot
 * straight to the next waiter, so nobody can overtake the queue. `async` with
 * `finally` means a job that rejects OR throws synchronously still releases its
 * slot.
 *
 * `holdMs` bounds how long a job may keep its slot, independently of its
 * result: at the deadline the slot passes on while the caller keeps awaiting
 * its own promise. The slot is released exactly once either way, and the timer
 * is cleared on settle and `unref()`'d, so it never keeps the process alive.
 * Exported for tests.
 */
export function createLimiter(max: number): <T>(fn: () => Promise<T>, holdMs?: number) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>, holdMs?: number): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      const next = waiting.shift();
      if (next) next(); // the slot passes on; `active` is unchanged
      else active--;
    };
    const timer = holdMs === undefined ? undefined : setTimeout(release, holdMs);
    timer?.unref?.();
    try {
      return await fn();
    } finally {
      if (timer) clearTimeout(timer);
      release();
    }
  };
}

/**
 * Past its own timeout, how much longer a git may keep its slot. execa's
 * `timeout` kills git, but the promise settles only once every holder of the
 * child's stdout/stderr has closed them — a surviving grandchild (gc,
 * pack-objects, a hung ssh under fetch, a local upload-pack) can keep it
 * pending for minutes. Without this deadline, eight of those would wedge every
 * git call in the daemon.
 */
const GIT_SLOT_GRACE_MS = 10_000;

/**
 * The one slot every `execa('git', …)` below goes through. A slot is held for
 * one child process — never across another await, so the queue cannot
 * deadlock on itself — and for at most `GIT_TIMEOUT_MS + GIT_SLOT_GRACE_MS`,
 * so a child that never lets go cannot starve it either. The caller still
 * awaits the real result; only the slot is given back early.
 *
 * An already-aborted `signal` skips the spawn: a queued call whose caller gave
 * up while waiting rejects at once instead of starting a git nobody wants.
 */
const gitLimit = createLimiter(GIT_MAX_CONCURRENT);
function gitSlot<T>(spawn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return gitLimit(() => {
    if (signal?.aborted) {
      const err = new Error('git aborted before it started', { cause: signal.reason });
      err.name = 'AbortError';
      return Promise.reject(err);
    }
    return spawn();
  }, GIT_TIMEOUT_MS + GIT_SLOT_GRACE_MS);
}

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
  // A user's `no` makes status omit untracked files, so a worktree holding only
  // new work reads as clean and a removal guard lets it be deleted. `-c` also
  // reaches git's own check inside a non-forced `worktree remove`.
  'status.showUntrackedFiles=normal',
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

/**
 * Read one git config value WITHOUT our own hardening shadowing it.
 *
 * `core.hooksPath=` above means our git calls never run repo hooks — correct,
 * and it also makes the repo's real `core.hooksPath` unreadable through any
 * normal call: `config --get` returns our empty override, and `rev-parse
 * --git-path hooks` resolves to `./`. That is how a hook meant for `.git/hooks`
 * ends up written to the repository root, where it silently never runs — which
 * looks exactly like success.
 *
 * So this drops the override for the key being read, and nothing else. Returns
 * null when unset, which is the common case.
 */
export async function gitConfigValue(key: string, cwd?: string): Promise<string | null> {
  const flags = HARDENED_GIT_CONFIG
    .filter((c) => c.toLowerCase() !== `${key.toLowerCase()}=`)
    .flatMap((c) => ['-c', c]);
  try {
    const { stdout } = await gitSlot(() => execa('git', [...flags, 'config', '--get', key], execOpts(cwd)));
    return stdout.trim() || null;
  } catch {
    return null;   // exit 1 means "not set", which is not an error here
  }
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
  const { stdout } = await gitSlot(() => execa('git', hardenedArgs(args), execOpts(cwd, signal)), signal);
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

/**
 * Run a git command without throwing. Inspect `.ok` for success.
 *
 * `opts.maxBuffer` caps stdout only (in characters, as execa counts) — stderr
 * keeps execa's default, so a burst of warnings never reads as a cut-off
 * stdout. Past it the result is `ok: false, truncated: true` with the output
 * read so far, so a caller can show part of a huge diff instead of none.
 */
export async function gitTry(
  args: string[],
  cwd?: string,
  signal?: AbortSignal,
  opts: { maxBuffer?: number } = {},
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await gitSlot(() => execa('git', hardenedArgs(args), {
      ...execOpts(cwd, signal),
      ...(opts.maxBuffer !== undefined ? { maxBuffer: { stdout: opts.maxBuffer } } : {}),
    }), signal);
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string; isMaxBuffer?: boolean };
    return {
      ok: false,
      stdout: (e.stdout ?? '').trim(),
      stderr: (e.stderr ?? e.message ?? '').trim(),
      ...(e.isMaxBuffer ? { truncated: true as const } : {}),
    };
  }
}
