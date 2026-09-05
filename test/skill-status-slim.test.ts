// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listSkillStatus, findSkill } from '../src/skills/install.js';

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'baton-skill-status-'));
}

describe('listSkillStatus', () => {
  it('returns the bundled catalogue', async () => {
    const skills = await listSkillStatus(await scratch());
    expect(skills.length).toBeGreaterThan(5);
    expect(skills.map((s) => s.id)).toContain('bug-fix');
  });

  it('ships no skill bodies — the listing is metadata only', async () => {
    const skills = await listSkillStatus(await scratch());
    for (const s of skills) {
      expect(s, `${s.id} still carries a body`).not.toHaveProperty('body');
    }
  });

  it('costs a small fraction of what the skills weigh on disk', async () => {
    // Bundled skills are ~330 KB (~82k tokens). Listing them used to ship every
    // body, so rendering a list of names cost all of it.
    //
    // The floor is not zero: `description` is ~44% of what remains, and it is
    // the field an agent matches on to pick a skill — trimming it would break
    // selection to save tokens, which is the wrong trade. A ratio is asserted
    // rather than an absolute so this stays meaningful as skills are added.
    const skills = await listSkillStatus(await scratch());
    const listingBytes = Buffer.byteLength(JSON.stringify(skills), 'utf8');
    const onDiskBytes = skills.reduce((n, s) => n + s.byteSize, 0);

    expect(listingBytes).toBeLessThan(onDiskBytes * 0.25);
    expect(listingBytes / 4).toBeLessThan(20_000);
  });

  it('keeps each entry small enough to hold many in context', async () => {
    const skills = await listSkillStatus(await scratch());
    for (const s of skills) {
      const tokens = Buffer.byteLength(JSON.stringify(s), 'utf8') / 4;
      expect(tokens, `${s.id} summary is ${Math.round(tokens)} tokens`).toBeLessThan(1500);
    }
  });

  it('still carries what a caller needs to choose a skill', async () => {
    const skills = await listSkillStatus(await scratch());
    const bugFix = skills.find((s) => s.id === 'bug-fix')!;
    expect(bugFix.description.length).toBeGreaterThan(20);
    expect(bugFix.tags.length).toBeGreaterThan(0);
    expect(bugFix.source).toBe('bundled');
    expect(bugFix.installs.length).toBeGreaterThan(0);
  });

  it('carries a content hash and byte size so a client can skip a refetch', async () => {
    const skills = await listSkillStatus(await scratch());
    const bugFix = skills.find((s) => s.id === 'bug-fix')!;
    expect(bugFix.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(bugFix.byteSize).toBeGreaterThan(1000);
  });

  it('lists reference paths without their contents', async () => {
    const skills = await listSkillStatus(await scratch());
    const withRefs = skills.find((s) => s.references.length > 0);
    expect(withRefs, 'expected at least one bundled skill with references').toBeDefined();
    expect(withRefs!.references.every((r) => typeof r === 'string')).toBe(true);
  });

  it('is stable across calls, so an ETag built from it does not flap', async () => {
    const root = await scratch();
    const a = await listSkillStatus(root);
    const b = await listSkillStatus(root);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('findSkill', () => {
  it('still returns the full body — this is the on-demand path', async () => {
    const skill = await findSkill(await scratch(), 'bug-fix');
    expect(skill).not.toBeNull();
    expect(skill!.body.length).toBeGreaterThan(500);
  });

  it('returns null for a skill that does not exist', async () => {
    expect(await findSkill(await scratch(), 'no-such-skill')).toBeNull();
  });
});
