/**
 * Shared tmux primitives. Lives in util/ so every module that must see tmux
 * state (terminals.ts, spawn.ts, commands/rm.ts) gets the SAME session naming
 * and the same hardened exec — cross-PROCESS coordination happens through
 * tmux itself (session names are deterministic), never through in-process maps.
 */
import { createHash } from 'node:crypto';
import { execa } from 'execa';
import { probeBinary } from './exec.js';

/**
 * One-shot tmux calls get a hard timeout: a wedged tmux server (e.g. a stale
 * client that stopped draining output) must surface as an error, never hang
 * the daemon's request handlers.
 */
export const TMUX_TIMEOUT_MS = 10_000;

export const tmux = (args: string[]) => execa('tmux', args, { timeout: TMUX_TIMEOUT_MS });

export const tmuxTry = async (args: string[]): Promise<boolean> => {
  try {
    await tmux(args);
    return true;
  } catch {
    return false;
  }
};

let tmuxProbe: Promise<boolean> | null = null;
export function detectTmux(): Promise<boolean> {
  tmuxProbe ??= probeBinary('tmux', ['-V']);
  return tmuxProbe;
}

/** Stable per-repo prefix so two repos' daemons can never collide on a slug. */
export function repoPrefix(root: string): string {
  return `baton-${createHash('sha1').update(root).digest('hex').slice(0, 6)}-`;
}

export function sessionNameFor(root: string, slug: string): string {
  return `${repoPrefix(root)}${slug}`;
}

export function slugFromSession(root: string, sessionName: string): string | null {
  const prefix = repoPrefix(root);
  return sessionName.startsWith(prefix) ? sessionName.slice(prefix.length) : null;
}

/** Cross-process check: does a live tmux session exist for this task? */
export async function tmuxSessionExists(root: string, slug: string): Promise<boolean> {
  if (!(await detectTmux())) return false;
  return tmuxTry(['has-session', '-t', sessionNameFor(root, slug)]);
}

/**
 * Cross-process kill: terminate the task's tmux session no matter which
 * process spawned it. Safe when tmux is missing, the server is down, or the
 * session never existed. The owning daemon's control client notices the
 * session vanish and cleans up its own state.
 */
export async function killSessionFor(root: string, slug: string): Promise<boolean> {
  if (!(await detectTmux())) return false;
  return tmuxTry(['kill-session', '-t', sessionNameFor(root, slug)]);
}
