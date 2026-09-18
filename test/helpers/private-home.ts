// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Give a test file its own throwaway `$HOME` (and `%USERPROFILE%`).
 *
 * Baton keeps machine-wide state in `~/.baton/` — the skill library, bookmarks,
 * skill origins, the quarantine release store, the skill usage ledger. Any test
 * that installs, loads or releases a skill touches at least one of them, and a
 * suite that can write into the developer's real library is worse than no suite:
 * it can release a skill they never reviewed, exhaust a cap, or leave state that
 * makes the NEXT run behave differently.
 *
 * That is not hypothetical. The skill usage ledger landed without this and put
 * 183 real entries in a developer's own `~/.baton/skill-usage.jsonl` before
 * anyone noticed, because four test files installed skills without redirecting
 * HOME. A shared helper exists so the fifth one does not have to remember.
 *
 * Call it once at the top of a `describe`. Returns a getter for the temp path,
 * for the rare test that needs to look inside it.
 *
 * ```ts
 * describe('something that installs a skill', () => {
 *   const home = usePrivateHome();
 *   it('...', async () => { … home() … });
 * });
 * ```
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';

/** Both are redirected: `homedir()` reads USERPROFILE on Windows, HOME elsewhere. */
const KEYS = ['HOME', 'USERPROFILE'] as const;

export function usePrivateHome(label = 'baton-home-'): () => string {
  let dir = '';
  const real: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), label));
    for (const k of KEYS) {
      real[k] = process.env[k];
      process.env[k] = dir;
    }
  });

  afterEach(async () => {
    // Restored before the cleanup, so a failing rm still leaves HOME correct
    // for whatever runs next — a leaked HOME is the more damaging of the two.
    for (const k of KEYS) {
      // `process.env.X = undefined` stores the STRING "undefined", which is a
      // path — so a var that was unset has to be DELETED, not reassigned.
      if (real[k] === undefined) delete process.env[k];
      else process.env[k] = real[k];
    }
    await rm(dir, { recursive: true, force: true });
  });

  return () => dir;
}
