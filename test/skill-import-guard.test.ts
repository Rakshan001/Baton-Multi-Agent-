// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The two guards that stand between "the user pasted a URL" and "an agent reads
 * this as its own instructions".
 *
 * Both exist because of one reproduced failure: `baton skills import
 * https://github.com/owner/repo/tree/main/skills/brag` fetched GitHub's own web
 * page and stored 230KB of `<!DOCTYPE html>` as a skill, reporting success. The
 * root cause was the CLI bypassing the GitHub-aware import path (pinned in
 * skill-import-cli.test.ts); this file covers the backstop that should have
 * caught it anyway, and the warning assembly the CLI had been missing.
 *
 * HOME is redirected per test — the library lives at ~/.baton/skills.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  uploadSkill, importSkillBundle, importWarnings, storedSkillPath, globalSkillsDir,
  loadCatalog, updateSkill, skillFilesOf, SKILL_BUNDLE_VERSION,
} from '../src/skills/install.js';
import { setOrigin, hashSkillFiles } from '../src/skills/origins.js';
import { usePrivateHome } from './helpers/private-home.js';

usePrivateHome('baton-import-guard-');

let repo: string;
beforeEach(async () => { repo = await mkdtemp(join(tmpdir(), 'baton-import-guard-repo-')); });
afterEach(async () => { await rm(repo, { recursive: true, force: true }); });

const SAMPLE = '---\nname: My Skill\ndescription: Does a thing.\n---\n\n# Body\n\nSteps here.\n';
const PAGE = '<!DOCTYPE html>\n<html lang="en">\n<head><title>owner/repo</title></head>\n<body>…</body>\n</html>\n';

const upload = (content: string, over: Partial<Parameters<typeof uploadSkill>[1]> = {}) =>
  uploadSkill(repo, { filename: 'my-skill.md', content, ...over });

describe('a web page is not a skill', () => {
  it('refuses an HTML document', async () => {
    await expect(upload(PAGE)).rejects.toThrow(/web page/i);
  });

  it('refuses one hidden behind a BOM or leading blank lines', async () => {
    await expect(upload(`﻿${PAGE}`)).rejects.toThrow(/web page/i);
    await expect(upload(`\n\n  \n${PAGE}`)).rejects.toThrow(/web page/i);
  });

  it('refuses the sibling shapes a CDN or an API error hands back', async () => {
    await expect(upload('<?xml version="1.0"?>\n<Error><Code>AccessDenied</Code></Error>')).rejects.toThrow(/web page/i);
    await expect(upload('<!doctype HTML PUBLIC "-//W3C//DTD HTML 4.01//EN">\n<html>')).rejects.toThrow(/web page/i);
    await expect(upload('<HTML>\n<body>nope</body>\n</HTML>')).rejects.toThrow(/web page/i);
  });

  it('still accepts a real skill, including markdown that opens with a tag', async () => {
    await expect(upload(SAMPLE)).resolves.toMatchObject({ id: 'my-skill' });
    // This repo's own README opens `<div align="center">`; a skill may too.
    await expect(upload('<div align="center">\n\n# Centered Skill\n\nDo a thing.\n</div>\n', { id: 'centered' }))
      .resolves.toMatchObject({ id: 'centered' });
  });

  it('skips one bad entry in a restore instead of failing the whole bundle', async () => {
    const r = await importSkillBundle(repo, {
      version: SKILL_BUNDLE_VERSION,
      skills: [
        { id: 'good-one', content: SAMPLE },
        { id: 'a-web-page', content: PAGE },
      ],
    });
    expect(r.imported).toEqual(['good-one']);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]).toMatchObject({ id: 'a-web-page' });
    expect(r.skipped[0].why).toMatch(/web page/i);
  });
});

describe('re-fetching a skill whose URL went bad', () => {
  it('refuses to overwrite a good skill with a login wall', async () => {
    const s = await upload(SAMPLE, { id: 'drifty' });
    const stored = (await loadCatalog(repo)).find((c) => c.id === 'drifty')!;
    await setOrigin('drifty', {
      url: 'https://example.com/skill.md',
      fetchedAt: new Date().toISOString(),
      contentHash: hashSkillFiles(skillFilesOf(stored)),
    });

    // The domain now serves a 200 web page where the SKILL.md used to be —
    // the exact shape that got stored as a skill in the first place.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(PAGE, { status: 200 }));
    try {
      await expect(updateSkill(repo, 'drifty')).rejects.toThrow(/web page/i);
    } finally {
      fetchSpy.mockRestore();
    }

    // And the good one is still there, untouched.
    const after = (await loadCatalog(repo)).find((c) => c.id === 'drifty')!;
    expect(after.description).toBe('Does a thing.');
    expect(s.id).toBe('drifty');
  });
});

describe('storedSkillPath', () => {
  it('names the flat file for a single-file skill, not a directory', async () => {
    const s = await upload(SAMPLE);
    // The review gate tells the reader to go read this path. `<id>/` would be a
    // directory that does not exist for every skill that arrived as one file.
    expect(storedSkillPath(s.id)).toBe(join(globalSkillsDir(), 'my-skill.md'));
  });

  it('names SKILL.md for a skill that brought companions', async () => {
    const r = await importSkillBundle(repo, {
      version: SKILL_BUNDLE_VERSION,
      skills: [{ id: 'with-refs', content: SAMPLE, files: [{ rel: 'references/a.md', content: '# a' }] }],
    });
    expect(r.imported).toEqual(['with-refs']);
    expect(storedSkillPath('with-refs')).toBe(join(globalSkillsDir(), 'with-refs', 'SKILL.md'));
  });

  it('is null for a skill that is not stored', () => {
    expect(storedSkillPath('never-imported')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */

/** The shape `importWarnings` reads — a stored skill plus what the fetch left behind. */
const skillWith = (body: string, refs: string[]) => ({
  body,
  references: refs.map((rel) => ({ rel, content: '' })),
});

describe('importWarnings', () => {
  it('does not warn about a reference that actually arrived', () => {
    const s = skillWith('See references/checklist.md before you start.', ['references/checklist.md']);
    expect(importWarnings(s)).toEqual([]);
  });

  it('warns only about the reference that did not come along', () => {
    const s = skillWith(
      'Read references/checklist.md, then references/missing.md.',
      ['references/checklist.md'],
    );
    expect(importWarnings(s)).toEqual(['references/missing.md']);
  });

  it('names runnable companions, capped at six', () => {
    const many = Array.from({ length: 8 }, (_, i) => `scripts/run${i}.py`);
    const [line] = importWarnings(skillWith('# hi', many));
    expect(line).toMatch(/Ships 8 runnable files/);
    expect(line).toContain('scripts/run0.py');
    expect(line).toMatch(/, …$/);
    // Six named, not eight — the seventh and eighth are behind the ellipsis.
    expect(line).not.toContain('scripts/run6.py');
  });

  it('truncates a long skipped list instead of printing every line', () => {
    const skipped = Array.from({ length: 265 }, (_, i) => `assets/sound${i}.ogg (binary)`);
    const out = importWarnings(skillWith('# hi', []), skipped);
    expect(out).toHaveLength(6);
    expect(out[0]).toBe('assets/sound0.ogg (binary)');
    expect(out[4]).toBe('assets/sound4.ogg (binary)');
    expect(out[5]).toBe('and 260 more');
  });

  it('leaves a short skipped list alone', () => {
    const out = importWarnings(skillWith('# hi', []), ['a.png (binary)', 'b.zip (binary)']);
    expect(out).toEqual(['a.png (binary)', 'b.zip (binary)']);
  });
});
