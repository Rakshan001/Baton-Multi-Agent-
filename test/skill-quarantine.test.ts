// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isReleased, listReleases, quarantinePath, releaseSkill, requiresReview,
  MAX_RELEASES, QUARANTINE_VERSION,
} from '../src/skills/quarantine.js';
import { usePrivateHome } from './helpers/private-home.js';

/**
 * The gate between "a skill is on disk" and "the agent loads it as its own
 * instructions". Everything about it is shaped by one asymmetry: letting an
 * unreviewed skill through is a security failure, while holding a good skill
 * back is an inconvenience with a visible fix.
 *
 * So unlike bookmarks.ts and origins.ts -- which degrade to "no opinion" when
 * their file is unreadable -- this one degrades to "nothing is released".
 */
describe('skill quarantine — fails closed, and binds approval to content', () => {
  // HOME is redirected per test: these write ~/.baton/skill-quarantine.json,
  // and a suite that can release skills in the developer's own library is
  // worse than no suite.
  const home = usePrivateHome('baton-quarantine-');

  it('holds an unknown skill', async () => {
    expect(await isReleased('some-skill', 'abc123')).toBe(false);
  });

  it('releases a skill for the exact content that was reviewed', async () => {
    await releaseSkill('some-skill', 'abc123', 'rakshan');
    expect(await isReleased('some-skill', 'abc123')).toBe(true);
  });

  it('re-holds the skill when its content changes after release', async () => {
    // Approval binds to a HASH, not a name -- otherwise an approved name is a
    // slot an attacker refills on the next update.
    await releaseSkill('some-skill', 'abc123', 'rakshan');
    expect(await isReleased('some-skill', 'def456')).toBe(false);
  });

  it('records who released it and when', async () => {
    await releaseSkill('some-skill', 'abc123', 'rakshan');
    const rows = await listReleases();
    expect(rows['some-skill'].by).toBe('rakshan');
    expect(rows['some-skill'].hash).toBe('abc123');
    expect(rows['some-skill'].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('persists across a reload', async () => {
    await releaseSkill('some-skill', 'abc123', 'rakshan');
    // A fresh read hits the file, not a cache: the daemon restarts.
    expect(await isReleased('some-skill', 'abc123')).toBe(true);
    expect(quarantinePath()).toContain(home());
  });

  it('is idempotent', async () => {
    await releaseSkill('some-skill', 'abc123', 'rakshan');
    await releaseSkill('some-skill', 'abc123', 'rakshan');
    expect(Object.keys(await listReleases())).toHaveLength(1);
  });

  describe('failing closed', () => {
    it('treats a corrupt state file as nothing released', async () => {
      await mkdir(join(home(), '.baton'), { recursive: true });
      await writeFile(quarantinePath(), '{ this is not json', 'utf-8');
      expect(await isReleased('some-skill', 'abc123')).toBe(false);
    });

    it('treats a file written by a future version as nothing released', async () => {
      await mkdir(join(home(), '.baton'), { recursive: true });
      await writeFile(quarantinePath(), JSON.stringify({ version: 999, released: { x: { hash: 'abc123' } } }), 'utf-8');
      expect(await isReleased('x', 'abc123')).toBe(false);
    });

    it('treats a missing file as nothing released', async () => {
      expect(await isReleased('anything', 'abc123')).toBe(false);
      expect(await listReleases()).toEqual({});
    });
  });

  describe('hostile input', () => {
    it('cannot be polluted by a skill id of __proto__', async () => {
      await releaseSkill('__proto__', 'abc123', 'attacker');
      // The whole point: no other id inherits a release from it.
      expect(await isReleased('unrelated-skill', 'abc123')).toBe(false);
      expect(({} as Record<string, unknown>).hash).toBeUndefined();
    });

    it('cannot be polluted by constructor or prototype either', async () => {
      await releaseSkill('constructor', 'abc123', 'attacker');
      await releaseSkill('prototype', 'abc123', 'attacker');
      expect(await isReleased('unrelated-skill', 'abc123')).toBe(false);
    });

    it('never lets an id escape the state directory', async () => {
      // The id is a KEY, never a path segment -- but assert it, because the day
      // someone writes one file per skill this test is the reason not to.
      await releaseSkill('../../escaped', 'abc123', 'attacker');
      expect(quarantinePath()).toContain(join(home(), '.baton'));
      expect(await isReleased('../../escaped', 'abc123')).toBe(true);
    });

    it('stops recording past the cap rather than growing without bound', async () => {
      // Seeded in one write rather than 500 read-modify-write cycles: the
      // subject is the cap, not the throughput.
      const released: Record<string, { hash: string; by: string; at: string }> = {};
      for (let i = 0; i < MAX_RELEASES; i++) released[`skill-${i}`] = { hash: 'h', by: 'r', at: '2026-01-01T00:00:00Z' };
      await mkdir(join(home(), '.baton'), { recursive: true });
      await writeFile(quarantinePath(), JSON.stringify({ version: QUARANTINE_VERSION, released }), 'utf-8');

      await releaseSkill('one-too-many', 'h', 'rakshan');
      const rows = await listReleases();
      expect(Object.keys(rows).length).toBe(MAX_RELEASES);
      expect(rows['one-too-many']).toBeUndefined();
      // An existing entry can still be UPDATED at the cap -- re-reviewing a
      // changed skill must not be blocked by a full file.
      await releaseSkill('skill-0', 'newhash', 'rakshan');
      expect((await listReleases())['skill-0'].hash).toBe('newhash');
    });
  });

  describe('two releases at once', () => {
    /**
     * The daemon serves concurrent requests, and `releaseSkill` is a
     * read-modify-write: load the whole map, add one row, stage it under a temp
     * name, rename it into place.
     *
     * The temp name is scoped to the PID, which is what stops two AGENTS
     * fighting over it — but two releases inside one daemon share that name
     * too. Unserialized they both stage to the same path, the first rename
     * moves it away, and the second gets ENOENT: a raw errno out of a route
     * that reported nothing wrong, and a release the reviewer thinks they
     * granted. Both halves are measured below.
     *
     * This is not a hypothetical pair of clicks. `grandfatherExistingLibrary`
     * releases a whole library in a loop, and two imports landing together on a
     * machine that has never used the gate both run it.
     */
    it('does not throw when two releases overlap', async () => {
      await Promise.all([
        releaseSkill('one', 'h1', 'rakshan'),
        releaseSkill('two', 'h2', 'rakshan'),
      ]);
    });

    it('keeps both, rather than the last writer erasing the first', async () => {
      await Promise.all([
        releaseSkill('one', 'h1', 'rakshan'),
        releaseSkill('two', 'h2', 'rakshan'),
        releaseSkill('three', 'h3', 'rakshan'),
      ]);
      expect(await isReleased('one', 'h1')).toBe(true);
      expect(await isReleased('two', 'h2')).toBe(true);
      expect(await isReleased('three', 'h3')).toBe(true);
    });

    it('leaves no temp file behind', async () => {
      await Promise.all([releaseSkill('one', 'h1', 'r'), releaseSkill('two', 'h2', 'r')]);
      expect(await readdir(join(home(), '.baton'))).toEqual(['skill-quarantine.json']);
    });
  });

  describe('what needs reviewing at all', () => {
    it('never quarantines a bundled skill', () => {
      // It shipped inside the package the user already chose to install;
      // holding it back would gate Baton on reviewing Baton.
      expect(requiresReview('bundled')).toBe(false);
    });

    it('quarantines everything the user brought in', () => {
      expect(requiresReview('imported')).toBe(true);
      expect(requiresReview('global')).toBe(true);
    });
  });
});
