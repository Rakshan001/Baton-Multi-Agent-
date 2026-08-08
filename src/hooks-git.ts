// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The git hook that stamps `Baton-Task:` onto commits made in a task worktree.
 *
 * Baton does not make these commits — agents do, with plain `git commit` inside
 * their worktree. So the trailer has to come from git itself.
 *
 * One shared hook, deciding per invocation. Linked worktrees do not get their
 * own hooks directory: `core.hooksPath` resolves to the common `.git/hooks` for
 * every worktree of a repo, so a hook installed for one is installed for all —
 * including the main checkout, where a trailer would be wrong. The hook
 * therefore asks Baton at commit time which task (if any) owns the directory it
 * is running in, and does nothing everywhere else.
 *
 * Safety, in order of importance:
 *
 *   1. It NEVER overwrites a hook we did not write. A prepare-commit-msg hook
 *      someone else installed is their tooling, and clobbering it to add a
 *      convenience is not a trade Baton gets to make on their behalf.
 *   2. It fails open. `exit 0` on every path: a hook that can block `git commit`
 *      is a hook that can strand an agent's work in an uncommitted worktree,
 *      which is worse than missing lineage.
 *   3. It is best-effort at the call site. Worktree creation never fails because
 *      the hook could not be installed.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { gitConfigValue, gitTry } from './util/exec.js';

/** Marks a hook as ours — the only thing that makes overwriting it safe. */
export const HOOK_MARKER = '# >>> baton prepare-commit-msg (generated — safe to delete)';

/**
 * `$2` is git's message SOURCE: empty for a plain commit, `message` for -m,
 * `commit` for --amend/-C, `merge`/`squash`/`template` otherwise. We stamp the
 * first two and leave the rest alone: an amend already carries the trailer (the
 * stamp is idempotent, but re-running on a merge message would attach a task to
 * a commit no single task produced).
 */
export function hookScript(nodePath: string, cliPath: string): string {
  // Absolute node path, not `node`: a git hook fired from a GUI client or a
  // login shell that never sourced a version manager has a PATH nothing like
  // the terminal's, and a hook that cannot find its interpreter fails silently
  // on exactly the machines hardest to debug.
  return `#!/bin/sh
${HOOK_MARKER}
# Adds a Baton-Task: trailer to commits made inside a baton task worktree, so
# lineage survives losing .baton/. Does nothing anywhere else. Never blocks a
# commit: every path exits 0.
case "$2" in
  ""|message) ;;
  *) exit 0 ;;
esac
if [ -n "$BATON_NO_TRAILER" ]; then exit 0; fi
"${nodePath}" "${cliPath}" stamp-commit "$1" >/dev/null 2>&1
exit 0
`;
}

/**
 * Where this repo's hooks actually live.
 *
 * Not `rev-parse --git-path hooks`: our own hardening sets `core.hooksPath=` so
 * Baton's git calls never fire repo hooks, and that override makes `--git-path
 * hooks` answer `./` — the repository root. A hook written there is never run by
 * anything, and nothing reports it, so the install looks like it worked.
 *
 * `--git-common-dir` is unaffected by the override, and a genuinely configured
 * hooksPath (husky and friends) is read through the one path that can see past
 * our own config.
 */
export async function hooksDir(gitRepo: string): Promise<string | null> {
  const configured = await gitConfigValue('core.hooksPath', gitRepo);
  if (configured) return isAbsolute(configured) ? configured : resolve(gitRepo, configured);
  const common = await gitTry(['-C', gitRepo, 'rev-parse', '--git-common-dir']);
  if (!common.ok || !common.stdout) return null;
  const base = isAbsolute(common.stdout) ? common.stdout : resolve(gitRepo, common.stdout);
  return join(base, 'hooks');
}

export type InstallOutcome = 'installed' | 'already' | 'foreign' | 'failed';

/**
 * Install the hook into the repo's shared hooks directory.
 *
 * Returns what happened rather than throwing: the caller (worktree creation) has
 * something more important to do and must not fail over this.
 */
export async function installCommitHook(
  gitRepo: string,
  cliPath: string,
  nodePath: string = process.execPath,
): Promise<InstallOutcome> {
  try {
    if (!cliPath) return 'failed';
    const dir = await hooksDir(gitRepo);
    if (!dir) return 'failed';
    const file = join(dir, 'prepare-commit-msg');

    const existing = await readFile(file, 'utf-8').catch(() => null);
    if (existing !== null && !existing.includes(HOOK_MARKER)) return 'foreign';
    const script = hookScript(nodePath, cliPath);
    if (existing === script) return 'already';

    await mkdir(dir, { recursive: true });
    await writeFile(file, script, 'utf-8');
    await chmod(file, 0o755);
    return existing === null ? 'installed' : 'already';
  } catch {
    return 'failed';
  }
}
