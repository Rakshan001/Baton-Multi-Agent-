// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A skill removed from source must stop shipping.
 *
 * `scripts/copy-assets.mjs` copies `src/skills/bundled` into `dist/skills/bundled`,
 * and `package.json`'s `files` ships `dist`. The copy was additive — `cpSync`
 * overwrites what it finds and removes nothing — so a skill directory deleted
 * from source stayed in `dist` forever, kept shipping, and `baton skills` went
 * on listing it as real. Measured on this repo before the fix: 12 skill
 * directories in source, 31 in `dist`.
 *
 * That is not untidiness. Deleting a skill is how you RETRACT one — the answer
 * to shipping a playbook that turns out to be wrong or hostile — and a
 * retraction that does not take effect is the failure mode that matters. A
 * stale directory is also invisible to `digests.json`, which is generated from
 * source, so nothing else would have caught it either.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = process.cwd();

describe('the bundled-skill copy prunes what source no longer has', () => {
  let dist: string;
  let src: string;
  let sandbox: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'baton-prune-'));
    src = join(sandbox, 'src', 'skills', 'bundled');
    dist = join(sandbox, 'dist', 'skills', 'bundled');
    await mkdir(src, { recursive: true });
    await mkdir(dist, { recursive: true });
  });
  afterEach(async () => { await rm(sandbox, { recursive: true, force: true }); });

  const skill = async (dir: string, id: string) => {
    await mkdir(join(dir, id), { recursive: true });
    await writeFile(join(dir, id, 'SKILL.md'), `---\nname: ${id}\ndescription: d\n---\n\nDo it.\n`, 'utf-8');
  };

  /** Run the real script against a sandbox root, so this tests the shipped code. */
  const runCopy = () =>
    execFileSync('node', [join(REPO, 'scripts', 'copy-assets.mjs')], {
      encoding: 'utf-8', env: { ...process.env, BATON_ASSET_ROOT: sandbox },
    });

  it('removes a skill directory that source no longer has', async () => {
    await skill(src, 'kept');
    await skill(dist, 'kept');
    await skill(dist, 'retracted');   // deleted from source in a past release

    runCopy();

    expect(existsSync(join(dist, 'kept', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dist, 'retracted'))).toBe(false);
  });

  it('still copies everything source does have', async () => {
    await skill(src, 'a');
    await skill(src, 'b');
    runCopy();
    const got = (await readdir(dist)).filter((f) => f !== 'digests.json').sort();
    expect(got).toEqual(['a', 'b']);
  });

  it('is idempotent — a second run changes nothing', async () => {
    await skill(src, 'a');
    runCopy();
    const first = (await readdir(dist)).sort();
    runCopy();
    expect((await readdir(dist)).sort()).toEqual(first);
  });

  it('leaves dist alone when source is missing, rather than emptying it', async () => {
    // A misconfigured checkout must not delete a built artifact.
    await rm(join(sandbox, 'src'), { recursive: true, force: true });
    await skill(dist, 'already-built');
    runCopy();
    expect(existsSync(join(dist, 'already-built'))).toBe(true);
  });
});
