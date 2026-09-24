// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Provenance: the record that makes a fetched skill updatable, and the guard
 * that stops an update from eating someone's local edits.
 *
 * HOME is redirected per test — these write ~/.baton/skill-origins.json, and a
 * suite that can rewrite the developer's own library is worse than no suite.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hashSkillFiles, loadOrigins, setOrigin, getOrigin, clearOrigin, originsPath,
  MAX_ORIGINS, ORIGINS_VERSION,
} from '../src/skills/origins.js';
import { updateSkill, globalSkillsDir, SkillLocallyEditedError } from '../src/skills/install.js';
import { usePrivateHome } from './helpers/private-home.js';

const home = usePrivateHome('baton-origin-home-');
let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'baton-origin-repo-'));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const ORIGIN = { url: 'https://github.com/o/r', fetchedAt: '2026-08-26T00:00:00.000Z', contentHash: 'abc' };

describe('hashSkillFiles', () => {
  it('does not depend on the order files were read in', () => {
    const a = [{ rel: 'SKILL.md', content: 'x' }, { rel: 'scripts/a.py', content: 'y' }];
    const b = [{ rel: 'scripts/a.py', content: 'y' }, { rel: 'SKILL.md', content: 'x' }];
    expect(hashSkillFiles(a)).toBe(hashSkillFiles(b));
  });

  it('changes when any byte of any file changes', () => {
    const base = [{ rel: 'SKILL.md', content: 'x' }, { rel: 'a.py', content: 'y' }];
    expect(hashSkillFiles(base)).not.toBe(hashSkillFiles([{ rel: 'SKILL.md', content: 'x' }, { rel: 'a.py', content: 'z' }]));
  });

  it('cannot be fooled by moving content between a path and its neighbour', () => {
    // Without the NUL separators, 'ab'+'c' and 'a'+'bc' would collide.
    expect(hashSkillFiles([{ rel: 'ab', content: 'c' }]))
      .not.toBe(hashSkillFiles([{ rel: 'a', content: 'bc' }]));
  });
});

describe('the origins file', () => {
  it('round-trips a record', async () => {
    await setOrigin('foo', ORIGIN);
    expect(await getOrigin('foo')).toEqual(ORIGIN);
  });

  it('reads a missing file as nothing recorded', async () => {
    expect(await loadOrigins()).toEqual({});
  });

  it('reads a corrupt file as nothing recorded rather than throwing', async () => {
    await mkdir(join(home(), '.baton'), { recursive: true });
    await writeFile(originsPath(), '{ this is not json', 'utf-8');
    expect(await loadOrigins()).toEqual({});
  });

  it('ignores a file written by a different version', async () => {
    await mkdir(join(home(), '.baton'), { recursive: true });
    await writeFile(originsPath(), JSON.stringify({ version: ORIGINS_VERSION + 9, skills: { a: ORIGIN } }), 'utf-8');
    expect(await loadOrigins()).toEqual({});
  });

  it('drops malformed entries but keeps the good ones', async () => {
    await mkdir(join(home(), '.baton'), { recursive: true });
    await writeFile(originsPath(), JSON.stringify({
      version: ORIGINS_VERSION,
      skills: { good: ORIGIN, bad: { url: 42 }, alsoBad: null },
    }), 'utf-8');
    expect(Object.keys(await loadOrigins())).toEqual(['good']);
  });

  it('forgets an origin when asked, and shrugs at one that is not there', async () => {
    await setOrigin('foo', ORIGIN);
    await clearOrigin('foo');
    expect(await getOrigin('foo')).toBeNull();
    await expect(clearOrigin('nope')).resolves.toBeUndefined();
  });

  it('stops recording new skills past the cap, without disturbing existing ones', async () => {
    // Seeded in ONE write rather than 500 sequential read-modify-writes. The
    // subject is the cap, not the throughput -- and the loop was a real source
    // of flake: under load it blew the 5s timeout, and its still-running writes
    // then landed in the NEXT test's freshly redirected HOME, filling that
    // test's cap so its own setOrigin was silently refused.
    const skills: Record<string, unknown> = {};
    for (let i = 0; i < MAX_ORIGINS; i++) skills[`s${i}`] = { ...ORIGIN, fetchedAt: '2026-01-01T00:00:00Z' };
    await mkdir(join(home(), '.baton'), { recursive: true });
    await writeFile(originsPath(), JSON.stringify({ version: ORIGINS_VERSION, skills }), 'utf-8');

    await setOrigin('one-too-many', ORIGIN);
    expect(await getOrigin('one-too-many')).toBeNull();
    // An UPDATE to something already recorded still works at the cap.
    await setOrigin('s0', { ...ORIGIN, contentHash: 'changed' });
    expect((await getOrigin('s0'))!.contentHash).toBe('changed');
  });

  /**
   * Two records written at once.
   *
   * `save()` is a read-modify-write staged under one temp path per PID, which
   * keeps two AGENTS apart but not two writes inside one daemon. Restoring a
   * bundle records an origin per skill and the dashboard imports concurrently,
   * so overlapping writes are the normal case, not the exotic one: unserialized
   * the first rename moves the shared temp file away and the second throws
   * ENOENT — through `recordOrigin`, which swallows it — while the record it
   * was writing is gone. A skill that silently loses its origin loses its
   * update button, which is the one thing this file exists to provide.
   */
  it('keeps every record when several are written at once', async () => {
    await Promise.all([
      setOrigin('a', { ...ORIGIN, contentHash: 'ha' }),
      setOrigin('b', { ...ORIGIN, contentHash: 'hb' }),
      setOrigin('c', { ...ORIGIN, contentHash: 'hc' }),
    ]);
    expect(Object.keys(await loadOrigins()).sort()).toEqual(['a', 'b', 'c']);
  });

  it('does not throw, or leave a temp file, when a write overlaps a delete', async () => {
    await setOrigin('doomed', ORIGIN);
    await Promise.all([setOrigin('kept', { ...ORIGIN, contentHash: 'hk' }), clearOrigin('doomed')]);
    expect(await getOrigin('kept')).toMatchObject({ contentHash: 'hk' });
    expect(await getOrigin('doomed')).toBeNull();
    expect(await readdir(join(home(), '.baton'))).toEqual(['skill-origins.json']);
  });
});

describe('updateSkill', () => {
  /** Put a skill in the library without going through the network. */
  const put = async (id: string, files: { rel: string; content: string }[]) => {
    for (const f of files) {
      const dest = join(globalSkillsDir(), id, f.rel);
      await mkdir(join(dest, '..'), { recursive: true });
      await writeFile(dest, f.content, 'utf-8');
    }
  };
  const SKILL = '---\nname: pinned\ndescription: "A skill used to prove the update guard refuses to eat local edits."\n---\n\n# Pinned\n';

  it('reports no-origin for a skill nobody recorded (a hand upload)', async () => {
    await put('pinned', [{ rel: 'SKILL.md', content: SKILL }]);
    expect(await updateSkill(repo, 'pinned')).toEqual({ id: 'pinned', status: 'no-origin' });
  });

  it('refuses when the local copy no longer matches what was imported', async () => {
    await put('pinned', [{ rel: 'SKILL.md', content: SKILL }, { rel: 'notes.md', content: 'mine\n' }]);
    // Record a hash of something else entirely: that is what a local edit looks like.
    await setOrigin('pinned', { ...ORIGIN, contentHash: hashSkillFiles([{ rel: 'SKILL.md', content: 'different' }]) });
    await expect(updateSkill(repo, 'pinned')).rejects.toThrow(SkillLocallyEditedError);
    await expect(updateSkill(repo, 'pinned')).rejects.toThrow(/local edits/);
  });

  it('refuses to update a Baton built-in', async () => {
    await expect(updateSkill(repo, 'bug-fix')).rejects.toThrow(/built-in/);
  });
});
