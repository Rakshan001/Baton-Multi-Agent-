// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
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

// Cache only a POSITIVE result: once tmux is found it never disappears, but a
// negative must be re-probed — otherwise installing tmux (or fixing PATH) while
// the daemon runs would never take effect until a restart.
let tmuxFound = false;
export async function detectTmux(): Promise<boolean> {
  if (tmuxFound) return true;
  tmuxFound = await probeBinary('tmux', ['-V']);
  return tmuxFound;
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

/**
 * tmux resolves `-t <name>` as exact match, then fnmatch, then **prefix** — so a
 * bare session name aims at the wrong session whenever one slug prefixes
 * another. With `fix-login` running, `-t fix` hits it: `baton rm fix` killed a
 * different task's agent, and `attach-session -t fix` streamed (and accepted
 * keystrokes for) the wrong terminal. Verified on tmux 3.6b.
 *
 * A leading `=` forces exact matching (tmux 1.8+), but the two forms are NOT
 * interchangeable — the target grammar differs by argument type, also verified:
 *
 *   target-session   has-session, kill-session, attach-session,     `=name`
 *                    set-environment, show-environment
 *   target-pane and  capture-pane, send-keys, set-option,           `=name:`
 *   target-window    resize-window
 *
 * A bare `=name` handed to capture-pane fails outright ("can't find pane"), and
 * to set-option ("no such session"), so picking the wrong helper breaks the
 * command rather than silently mistargeting it.
 */
export function exactSession(sessionName: string): string {
  return `=${sessionName}`;
}

/** Exact-match target for pane/window arguments — see {@link exactSession}. The
 *  trailing colon selects that session's current window/pane. */
export function exactPane(sessionName: string): string {
  return `=${sessionName}:`;
}

/** Cross-process check: does a live tmux session exist for this task? */
export async function tmuxSessionExists(root: string, slug: string): Promise<boolean> {
  if (!(await detectTmux())) return false;
  return tmuxTry(['has-session', '-t', exactSession(sessionNameFor(root, slug))]);
}

/** All live tmux session names (empty when tmux is missing or no server runs). */
export async function listSessions(): Promise<string[]> {
  if (!(await detectTmux())) return [];
  try {
    const { stdout } = await tmux(['list-sessions', '-F', '#{session_name}']);
    return stdout.split('\n').filter(Boolean);
  } catch {
    return []; // no server running → no sessions
  }
}

/**
 * Cross-process kill: terminate the task's tmux session no matter which
 * process spawned it. Safe when tmux is missing, the server is down, or the
 * session never existed. The owning daemon's control client notices the
 * session vanish and cleans up its own state.
 */
export async function killSessionFor(root: string, slug: string): Promise<boolean> {
  if (!(await detectTmux())) return false;
  return tmuxTry(['kill-session', '-t', exactSession(sessionNameFor(root, slug))]);
}
