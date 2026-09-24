// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What a skill LISTING costs to build.
 *
 * The acceptance criterion for skill-usage-wire is that building a list reads
 * no reference-file content at all — "the 137,923 bytes measured above drop to
 * zero for a list". `bundledSkills()` alone satisfied that as soon as `content`
 * became a getter, but the real list path is `listSkillStatus()` (which serves
 * `GET /api/skills` and `baton skills`), and it goes on to `summarize()`, whose
 * contentSha256/byteSize touched every reference and fired every getter:
 * 125,870 bytes per listing, measured.
 *
 * So the criterion is measured here rather than asserted about a mechanism.
 * `referenceReads` counts bytes actually pulled off disk; a listing must not
 * move it.
 *
 * Order matters in this file: the measuring test runs FIRST, while the process
 * has never read a reference file. Later tests deliberately read content, and
 * both the per-file cache and the catalog cache would hide a regression from a
 * measurement taken after them. The first test asserts its own precondition so
 * a reordering fails loudly instead of passing vacuously.
 *
 * HOME is redirected — listSkillStatus reads the machine-wide skill library and
 * bookmarks out of ~/.baton.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { usePrivateHome } from './helpers/private-home.js';
import { listSkillStatus } from '../src/skills/install.js';
import { bundledSkills } from '../src/skills/catalog.js';
import { referenceReads } from '../src/skills/digests.js';
import { summarize } from '../src/skills/summary.js';

describe('the cost of a skill listing', () => {
  usePrivateHome('baton-listing-cost-home-');
  let repo = '';

  beforeAll(async () => { repo = await mkdtemp(join(tmpdir(), 'baton-listing-cost-')); });
  afterAll(async () => { await rm(repo, { recursive: true, force: true }); });

  it('reads ZERO bytes of reference content', async () => {
    expect(referenceReads.bytes, 'precondition: nothing may have read a reference before this test').toBe(0);

    const list = await listSkillStatus(repo);
    expect(list.length).toBeGreaterThan(5);

    expect(referenceReads.bytes, 'a listing read reference-file content').toBe(0);
    expect(referenceReads.files, 'a listing opened a reference file').toBe(0);
  });

  it('still reports a real hash and a size that includes the references', async () => {
    const list = await listSkillStatus(repo);
    const withRefs = list.filter((s) => s.references.length > 0);
    expect(withRefs.length, 'expected bundled skills with references').toBeGreaterThan(0);
    for (const s of withRefs) {
      expect(s.contentSha256).toMatch(/^[0-9a-f]{64}$/);
      // A skill whose references were ignored would weigh only its SKILL.md.
      expect(s.byteSize).toBeGreaterThan(2000);
    }
  });

  it('agrees byte-for-byte with hashing the reference contents directly', async () => {
    const listed = new Map((await listSkillStatus(repo)).map((s) => [s.id, s]));
    const defs = (await bundledSkills()).filter((d) => d.references.length > 0);
    expect(defs.length).toBeGreaterThan(0);

    for (const def of defs) {
      // Plain objects, no digest: summarize() has to hash the actual bytes.
      const eager = { ...def, references: def.references.map((r) => ({ rel: r.rel, content: r.content })) };
      const direct = summarize(eager);
      expect(listed.get(def.id)?.contentSha256, `${def.id} hash`).toBe(direct.contentSha256);
      expect(listed.get(def.id)?.byteSize, `${def.id} size`).toBe(direct.byteSize);
    }
  });

  it('counts the bytes when something really does read a reference', async () => {
    // Guards the instrument itself: a meter that never moves proves nothing.
    expect(referenceReads.bytes).toBeGreaterThan(0);
    expect(referenceReads.files).toBeGreaterThan(0);
  });
});
