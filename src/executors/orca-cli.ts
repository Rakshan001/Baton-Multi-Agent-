// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * How to talk to the `orca` CLI, decided without executing anything.
 *
 * Argv construction and envelope parsing live here, apart from the executor, so
 * the whole surface is a unit test rather than something you learn by launching
 * an Electron app. When Orca's CLI changes shape, this file's tests fail —
 * which is the point (P4-E6).
 *
 * Every shape below was read out of Orca's own source rather than its docs:
 * the envelope is `src/shared/runtime-rpc-envelope.ts`, the failure form is
 * `src/cli/format.ts:reportCliError`, and `path:` resolution is
 * `orca-runtime.ts:resolveWorktreeSelector`.
 */

/**
 * Attestation variables Orca sets inside its own terminals.
 *
 * Deleted from every exec. A Baton daemon started from an Orca terminal
 * inherits them, and Orca then attests each of the dispatcher's calls as coming
 * from *that* terminal — so the dispatcher gets fenced as though an agent were
 * making the call. Nothing about the daemon's identity should depend on where
 * the user happened to launch it.
 */
export const STRIPPED_ORCA_ENV = [
  'ORCA_TERMINAL_HANDLE',
  'ORCA_PANE_KEY',
  'ORCA_AGENT_LAUNCH_TOKEN',
] as const;

/**
 * Which binary to run (P4-E3).
 *
 * On Linux bare `orca` is normally the GNOME screen reader at `/usr/bin/orca`,
 * and running it starts speech on the user's machine — so the IDE ships as
 * `orca-ide` there. `ORCA_CLI_COMMAND` outranks both: Orca exports it for
 * managed WSL sessions, where neither default is correct.
 */
export function orcaBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const declared = env.ORCA_CLI_COMMAND?.trim();
  if (declared) return declared;
  return platform === 'linux' ? 'orca-ide' : 'orca';
}

/** The environment for an `orca` exec: this process's, minus the fence. */
export function orcaEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const key of STRIPPED_ORCA_ENV) delete out[key];
  return out;
}

export interface TerminalCreate {
  /** Absolute path to the Baton worktree. */
  cwd: string;
  /** The full launch command line, as Orca will run it. */
  command: string;
  slug: string;
}

/**
 * `path:` is the only selector that can name a worktree Orca did not create.
 *
 * Verified in Orca's source: `resolveWorktreeSelector` filters the resolved
 * worktree list, and that list comes from `provider.listWorktrees(repo.path)` —
 * an actual scan, whose own comment says it exists to catch "worktree changes
 * made outside Orca". So a Baton worktree resolves, **provided its repo is
 * registered**. Unregistered, the answer is `selector_not_found` (P4-E1).
 */
export function terminalCreateArgs(req: TerminalCreate): string[] {
  return [
    'terminal', 'create',
    '--worktree', `path:${req.cwd}`,
    '--command', req.command,
    '--title', `baton:${req.slug}`,
    '--json',
  ];
}

/** P4-E4: never send before this returns. A pointer typed into a TUI that is
 *  still starting lands in the wrong buffer, or in no buffer at all. */
export function terminalWaitArgs(handle: string, timeoutMs: number): string[] {
  return ['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', String(timeoutMs), '--json'];
}

/** `--enter` submits it. Without that the pointer sits in the input unsent, and
 *  the agent looks started while having read nothing. */
export function terminalSendArgs(handle: string, text: string): string[] {
  return ['terminal', 'send', '--terminal', handle, '--text', text, '--enter', '--json'];
}

export function terminalReadArgs(handle: string, cursor?: string): string[] {
  return [
    'terminal', 'read', '--terminal', handle,
    ...(cursor ? ['--cursor', cursor] : []),
    '--json',
  ];
}

export function terminalCloseArgs(handle: string): string[] {
  return ['terminal', 'close', '--terminal', handle, '--json'];
}

export function terminalShowArgs(handle: string): string[] {
  return ['terminal', 'show', '--terminal', handle, '--json'];
}

/** How registration is checked before a dispatch relies on `path:`. */
export function repoListArgs(): string[] {
  return ['repo', 'list', '--json'];
}

export function statusArgs(): string[] {
  return ['status', '--json'];
}

export type OrcaEnvelope =
  | { ok: true; result: unknown }
  | { ok: false; code: string; message: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Read one CLI response.
 *
 * Anything that is not an envelope is a **failure**, never a success: a
 * different program on PATH named `orca`, a shim printing a banner, or a CLI
 * old enough not to know `--json` would otherwise be read as a launch that
 * worked. The first `{` is found rather than assumed at offset zero, because
 * Node deprecation warnings and wrapper banners reach stdout in the wild.
 */
export function parseOrcaEnvelope(stdout: string): OrcaEnvelope {
  const start = stdout.indexOf('{');
  if (start === -1) {
    return { ok: false, code: 'orca_unparseable', message: unparseable(stdout) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    return { ok: false, code: 'orca_unparseable', message: unparseable(stdout) };
  }
  const env = asRecord(parsed);
  if (!env || typeof env.ok !== 'boolean') {
    return { ok: false, code: 'orca_unparseable', message: unparseable(stdout) };
  }
  if (env.ok) return { ok: true, result: env.result };

  const error = asRecord(env.error);
  const code = typeof error?.code === 'string' && error.code ? error.code : 'orca_error';
  const message = typeof error?.message === 'string' && error.message
    ? error.message
    : 'orca reported a failure with no message';
  return { ok: false, code, message };
}

const MAX_ECHO = 200;

function unparseable(stdout: string): string {
  const seen = stdout.trim().slice(0, MAX_ECHO);
  return seen
    ? `orca did not return a JSON envelope. It printed: ${seen}`
    : 'orca returned nothing. Is it installed, and is the app running?';
}
