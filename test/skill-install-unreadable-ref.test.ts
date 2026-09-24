// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A reference file that cannot be read at the moment it is installed.
 *
 * A bundled reference is loaded lazily — named when the catalogue is built,
 * read only when something asks for the bytes — and a read that FAILS answers
 * `''` rather than throwing, because a property getter in the middle of a
 * render can do nothing useful with an exception. `installSkill` is not a
 * render: it took that `''`, wrote a zero-byte file, counted it in
 * `references`, and reported success. Meanwhile the listing's `contentSha256`
 * still described the real bytes, because it comes from the build-time digest
 * manifest and a mode-000 file stats perfectly well.
 *
 * So the install claimed to have written a file it had not, under a hash over
 * bytes that never reached disk — and the agent got `references/x.md` present
 * and empty, which is worse than absent: the SKILL.md tells it to read that
 * file, and an empty one reads as "there is nothing to say here".
 *
 * Measured before the fix: `references: 2`, a zero-byte
 * `references/smell-baseline.md` on disk, and nothing anywhere saying so.
 *
 * This test makes a file in the repo's own bundled tree temporarily
 * unreadable, so every path restores the mode. It is skipped for root, which
 * reads mode-000 files regardless, and it must run before anything else in
 * this file reads that reference: a successful read is cached for the life of
 * the process.
 *
 * The lock is held for ONE `installSkill` call at a time and dropped in a
 * `finally`, not for the whole file: `code-review/references/smell-baseline.md`
 * is a real file in this repository that other suites read while this one runs,
 * and vitest runs test FILES in parallel. A mode-000 window wide enough to span
 * a whole describe is a window wide enough to fail somebody else's test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { usePrivateHome } from './helpers/private-home.js';
import { installSkill, skillTargetFor } from '../src/skills/install.js';

usePrivateHome('baton-unreadable-home-');

const BUNDLED = fileURLToPath(new URL('../src/skills/bundled', import.meta.url));
const LOCKED_REL = 'references/smell-baseline.md';
const LOCKED = join(BUNDLED, 'code-review', LOCKED_REL);

/** Root reads a mode-000 file, so there is nothing to reproduce there. */
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

let repo = '';

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'baton-unreadable-repo-'));
});

// A second line of defence, not the primary one: `lockedInstall` already
// restores the mode in a `finally`. This catches the case where the lock is
// taken and the process dies between the chmod and the install.
afterEach(async () => { await chmod(LOCKED, 0o644); });

/**
 * Run ONE install with the reference unreadable, and give the mode back
 * immediately — the narrowest window the assertion can be made in.
 */
async function lockedInstall(id: string): Promise<Awaited<ReturnType<typeof installSkill>>> {
  await chmod(LOCKED, 0o000);
  try {
    return await installSkill(repo, id, 'claude');
  } finally {
    await chmod(LOCKED, 0o644);
  }
}

/** Every reference file that actually reached disk, however deeply nested. */
async function refsOnDisk(): Promise<string[]> {
  const dir = join(skillTargetFor('claude', 'code-review', repo)!.refsDir, 'references');
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

describe.skipIf(asRoot)('installing a skill whose reference cannot be read', () => {
  it('does not write a zero-byte stand-in for it', async () => {
    const r = await lockedInstall('code-review');
    const dest = join(skillTargetFor('claude', 'code-review', repo)!.refsDir, LOCKED_REL);
    if (existsSync(dest)) {
      expect((await stat(dest)).size, 'an unreadable reference was written as an empty file').toBeGreaterThan(0);
    }
    expect(existsSync(dest), 'the file was written despite never being read').toBe(false);
    expect(r.wrote).toBe(true);
  });

  it('does not count it, and names it instead', async () => {
    const r = await lockedInstall('code-review');
    expect(r.unreadable).toEqual([LOCKED_REL]);
    // The other reference is fine and must still land: one unreadable file is
    // not a reason to install none of them.
    expect(r.references).toBe(1);
    // And the number is not a literal anyone can drift: it must equal what is
    // actually on disk. A count taken before the writes — the original bug —
    // passes `toBe(1)` and fails this.
    expect(r.references, 'the count must describe what was actually written')
      .toBe((await refsOnDisk()).length);
    const ok = join(skillTargetFor('claude', 'code-review', repo)!.refsDir, 'references/security-baseline.md');
    expect((await readFile(ok, 'utf-8')).length).toBeGreaterThan(0);
  });

  it('writes every reference, and reports none unreadable, once it is readable again', async () => {
    // Nothing to unlock: the two tests above each gave the mode back before
    // they returned. "Again" is still the point — a read that failed must not
    // poison the cache for the next install.
    const r = await installSkill(repo, 'code-review', 'claude');
    expect(r.unreadable).toEqual([]);
    expect(r.references).toBe(2);
    expect(r.references).toBe((await refsOnDisk()).length);
    const dest = join(skillTargetFor('claude', 'code-review', repo)!.refsDir, LOCKED_REL);
    expect((await readFile(dest, 'utf-8')).length).toBeGreaterThan(0);
  });
});

describe('a skill whose references are all readable', () => {
  it('reports an empty unreadable list rather than omitting the field', async () => {
    // An absent field would read as "this daemon does not know", which is the
    // same distinction `excluded` is documented to preserve.
    const r = await installSkill(repo, 'bug-fix', 'claude');
    expect(r.unreadable).toEqual([]);
    expect(r.references).toBeGreaterThan(0);
    const dir = join(skillTargetFor('claude', 'bug-fix', repo)!.refsDir, 'references');
    const written = (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
    expect(r.references, 'the count must describe what was actually written').toBe(written.length);
  });
});
