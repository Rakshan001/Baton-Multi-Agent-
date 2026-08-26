// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The user's own skill library: uploading, exporting, deleting, and the edge
 * cases that decide whether a released build is safe to hand to someone.
 *
 * HOME is redirected to a temp dir for every test, because the library lives at
 * ~/.baton/skills and `os.homedir()` reads $HOME on POSIX. Without that these
 * tests would read and WRITE the developer's real library — a test suite that
 * can delete your own skills is worse than no test suite.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  withSkillName, uploadSkill, removeSkill, exportSkillFile, exportSkills,
  importSkillBundle, loadCatalog, globalSkillsDir, isUserSkill, danglingReferences,
  bookmarkSkill, listSkillStatus, parseSkillMarkdown,
  SkillImportError, SkillExistsError, SkillExportRefused, SkillNotFoundError,
  SKILL_BUNDLE_VERSION,
} from '../src/skills/install.js';
import { loadBookmarks, bookmarksPath } from '../src/skills/bookmarks.js';

let home: string;
let repo: string;
let realHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'baton-skill-home-'));
  repo = await mkdtemp(join(tmpdir(), 'baton-skill-repo-'));
  realHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(async () => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  await rm(home, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

const upload = (content: string, over: Partial<Parameters<typeof uploadSkill>[1]> = {}) =>
  uploadSkill(repo, { filename: 'my-skill.md', content, ...over });

const SAMPLE = '---\nname: My Skill\ndescription: Does a thing.\ntags: [a, b]\n---\n\n# Body\n\nSteps here.\n';

describe('withSkillName', () => {
  it('rewrites an existing name and touches nothing else', () => {
    const out = withSkillName(SAMPLE, 'chosen-id');
    expect(out).toContain('name: chosen-id');
    expect(out).not.toContain('name: My Skill');
    // The whole reason this function exists rather than re-rendering frontmatter.
    expect(out).toContain('tags: [a, b]');
    expect(out).toContain('description: Does a thing.');
    expect(out).toContain('# Body');
  });

  it('inserts a name when the frontmatter has none', () => {
    const out = withSkillName('---\ndescription: No name here.\n---\n\nBody\n', 'chosen-id');
    expect(out).toContain('name: chosen-id');
    expect(out).toContain('description: No name here.');
  });

  it('wraps a bare markdown file that has no frontmatter at all', () => {
    const out = withSkillName('# Just a heading\n\nBody text.\n', 'chosen-id');
    expect(out.startsWith('---\nname: chosen-id\n---\n')).toBe(true);
    expect(out).toContain('# Just a heading');
  });

  it('is idempotent — re-normalising an already-normalised file changes nothing', () => {
    const once = withSkillName(SAMPLE, 'chosen-id');
    expect(withSkillName(once, 'chosen-id')).toBe(once);
  });
});

describe('uploadSkill', () => {
  it('stores into the machine-wide library, not the repo', async () => {
    const s = await upload(SAMPLE);
    expect(s.id).toBe('my-skill');
    expect(s.source).toBe('global');
    expect(existsSync(join(globalSkillsDir(), 'my-skill.md'))).toBe(true);
    expect(existsSync(join(repo, '.baton', 'skills', 'my-skill.md'))).toBe(false);
  });

  it('lets an explicit shortcut override the frontmatter name', async () => {
    const s = await upload(SAMPLE, { id: 'Deploy Checklist' });
    expect(s.id).toBe('deploy-checklist');
    const onDisk = await readFile(join(globalSkillsDir(), 'deploy-checklist.md'), 'utf-8');
    // The id and the on-disk name must agree, or `raw` installs would write a
    // SKILL.md whose name contradicts its directory.
    expect(onDisk).toContain('name: deploy-checklist');
  });

  it('refuses a shortcut that collides with a bundled skill', async () => {
    await expect(upload(SAMPLE, { id: 'bug-fix' })).rejects.toThrow(/built-in/);
  });

  it('refuses a second upload on the same shortcut, then allows replace', async () => {
    await upload(SAMPLE);
    await expect(upload(SAMPLE)).rejects.toThrow(SkillExistsError);
    await expect(upload(SAMPLE, { replace: true })).resolves.toMatchObject({ id: 'my-skill' });
  });

  it('refuses empty, oversized, binary, and non-markdown files', async () => {
    await expect(upload('   \n  ')).rejects.toThrow(/empty/);
    await expect(upload('x'.repeat(256 * 1024 + 1))).rejects.toThrow(/256KB/);
    await expect(upload('# ok\n\0binary')).rejects.toThrow(/not text/);
    await expect(upload(SAMPLE, { filename: 'notes.pdf' })).rejects.toThrow(/not a markdown file/);
  });

  it('refuses a shortcut with nothing usable in it', async () => {
    await expect(upload(SAMPLE, { id: '!!!' })).rejects.toThrow(/has no letters or digits/);
  });

  it('strips path traversal out of a shortcut instead of writing outside the library', async () => {
    const s = await upload(SAMPLE, { id: '../../etc/passwd' });
    expect(s.id).toBe('etc-passwd');
    expect(existsSync(join(globalSkillsDir(), 'etc-passwd.md'))).toBe(true);
  });

  it('accepts a file with no frontmatter, deriving the description from the body', async () => {
    const s = await upload('# Ship It\n\nDo the thing.\n', { filename: 'ship-it.md' });
    expect(s.id).toBe('ship-it');
    expect(s.description).toBe('Ship It');
  });
});

describe('frontmatter a YAML parser refuses', () => {
  // A colon in a plain scalar is invalid YAML and is also what people write.
  // It used to take the whole file down: description came out as "---" and the
  // fence leaked into the body, so the skill looked broken over punctuation.
  const COLON = '---\nname: deploy-checklist\ndescription: Our release ritual: migrations dry-run, flags off.\n---\n\n# Deploy checklist\n\nBody.\n';

  it('salvages the name and description instead of discarding both', () => {
    const r = parseSkillMarkdown(COLON, 'fallback');
    expect(r.id).toBe('deploy-checklist');
    expect(r.description).toBe('Our release ritual: migrations dry-run, flags off.');
  });

  it('keeps the fence out of the body', () => {
    expect(parseSkillMarkdown(COLON, 'fallback').body).not.toContain('---');
  });

  it('never describes a skill as "---"', () => {
    for (const text of [COLON, '---\nbroken: [unclosed\n---\n\nBody.\n']) {
      expect(parseSkillMarkdown(text, 'fallback').description).not.toBe('---');
    }
  });

  it('strips surrounding quotes but leaves valid YAML alone', () => {
    expect(parseSkillMarkdown('---\nname: x\ndescription: "Quoted: fine."\n---\n\nB\n', 'f').description).toBe('Quoted: fine.');
    const valid = parseSkillMarkdown('---\nname: y\ndescription: No colon\ntags: [a, b]\n---\n\nB\n', 'f');
    expect(valid.description).toBe('No colon');
  });

  it('still treats a horizontal rule in a frontmatter-less file as body', () => {
    expect(parseSkillMarkdown('Intro line.\n\n---\n\nMore.\n', 'f').description).toBe('Intro line.');
  });

  it('round-trips through upload with the colon intact', async () => {
    const s = await upload(COLON, { filename: 'deploy-checklist.md' });
    expect(s.description).toBe('Our release ritual: migrations dry-run, flags off.');
    const { text } = await exportSkillFile(repo, s.id);
    expect(text).toContain('Our release ritual: migrations dry-run');
  });
});

describe('danglingReferences', () => {
  it('names reference files a single-.md upload could not have carried', () => {
    const body = 'See references/checklist.md and references/deep/template.json for details.';
    expect(danglingReferences(body)).toEqual(['references/checklist.md', 'references/deep/template.json']);
  });

  it('is quiet for an ordinary skill, and never repeats one file', () => {
    expect(danglingReferences('# Just steps\n\n1. Do the thing.\n')).toEqual([]);
    expect(danglingReferences('references/a.md then references/a.md again')).toEqual(['references/a.md']);
  });
});

describe('loadCatalog precedence', () => {
  it('shows global skills in every repo, and never lets one shadow a bundled id', async () => {
    await upload(SAMPLE);
    const other = await mkdtemp(join(tmpdir(), 'baton-other-repo-'));
    try {
      const ids = (await loadCatalog(other)).map((s) => s.id);
      expect(ids).toContain('my-skill'); // the whole point of a global library
      expect(ids.filter((i) => i === 'bug-fix')).toHaveLength(1);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('still reads legacy per-repo skills, marked as project-scoped', async () => {
    await mkdir(join(repo, '.baton', 'skills'), { recursive: true });
    await writeFile(join(repo, '.baton', 'skills', 'legacy.md'), '---\nname: legacy\ndescription: Old one.\n---\n\nBody\n', 'utf-8');
    const found = (await loadCatalog(repo)).find((s) => s.id === 'legacy');
    expect(found?.source).toBe('imported');
    expect(isUserSkill(found!.source)).toBe(true);
  });

  it('normalises a legacy skill whose frontmatter name is a display name', async () => {
    // What the pre-1.x importSkill wrote: `name:` held the DISPLAY name, not the
    // id. Installed verbatim, Claude gets a SKILL.md contradicting its own dir.
    await mkdir(join(repo, '.baton', 'skills'), { recursive: true });
    await writeFile(join(repo, '.baton', 'skills', 'my-display-name.md'),
      '---\nname: My Display Name\ndescription: A legacy skill.\n---\n\nBody here.\n', 'utf-8');
    const found = (await loadCatalog(repo)).find((s) => s.id === 'my-display-name');
    expect(found?.raw).toContain('name: my-display-name');
    expect(found?.raw).not.toContain('name: My Display Name');
    expect(found?.raw).toContain('description: A legacy skill.');
  });

  it('gives a frontmatter-less file a name rather than installing it without one', async () => {
    await mkdir(join(repo, '.baton', 'skills'), { recursive: true });
    await writeFile(join(repo, '.baton', 'skills', 'bare.md'), '# Bare\n\nNo frontmatter at all.\n', 'utf-8');
    const found = (await loadCatalog(repo)).find((s) => s.id === 'bare');
    expect(found?.raw).toMatch(/^---\nname: bare\n---/);
  });

  it('prefers the global copy when both dirs hold the same id', async () => {
    await upload(SAMPLE, { id: 'dupe' });
    await mkdir(join(repo, '.baton', 'skills'), { recursive: true });
    await writeFile(join(repo, '.baton', 'skills', 'dupe.md'), '---\nname: dupe\ndescription: Project copy.\n---\n\nBody\n', 'utf-8');
    const hits = (await loadCatalog(repo)).filter((s) => s.id === 'dupe');
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe('global');
  });
});

describe('export', () => {
  it('hands back the exact bytes on disk', async () => {
    await upload(SAMPLE, { id: 'mine' });
    const { text } = await exportSkillFile(repo, 'mine');
    expect(text).toBe(await readFile(join(globalSkillsDir(), 'mine.md'), 'utf-8'));
    expect(text).toContain('tags: [a, b]');
  });

  it('refuses to export a bundled skill', async () => {
    await expect(exportSkillFile(repo, 'bug-fix')).rejects.toThrow(SkillExportRefused);
  });

  it('404s on a skill that does not exist', async () => {
    await expect(exportSkillFile(repo, 'nope')).rejects.toThrow(SkillNotFoundError);
  });

  it('bundles only the user\'s own skills', async () => {
    await upload(SAMPLE, { id: 'mine-a' });
    await upload(SAMPLE, { id: 'mine-b' });
    const bundle = await exportSkills(repo);
    expect(bundle.version).toBe(SKILL_BUNDLE_VERSION);
    expect(bundle.skills.map((s) => s.id).sort()).toEqual(['mine-a', 'mine-b']);
  });

  it('round-trips through a bundle onto a fresh machine', async () => {
    await upload(SAMPLE, { id: 'mine' });
    const bundle = await exportSkills(repo);

    await rm(globalSkillsDir(), { recursive: true, force: true });
    expect((await loadCatalog(repo)).some((s) => s.id === 'mine')).toBe(false);

    const result = await importSkillBundle(repo, bundle);
    expect(result.imported).toEqual(['mine']);
    const restored = (await loadCatalog(repo)).find((s) => s.id === 'mine');
    expect(restored?.source).toBe('global');
    expect(restored?.raw).toContain('tags: [a, b]');
  });
});

describe('importSkillBundle', () => {
  it('refuses a file that is not a bundle, and a version it cannot read', async () => {
    await expect(importSkillBundle(repo, { nope: true })).rejects.toThrow(/not a Baton skills bundle/);
    await expect(importSkillBundle(repo, { version: 99, skills: [] })).rejects.toThrow(/version 99/);
  });

  it('skips a colliding entry rather than overwriting or failing the whole restore', async () => {
    await upload(SAMPLE, { id: 'taken' });
    const r = await importSkillBundle(repo, {
      version: SKILL_BUNDLE_VERSION,
      exportedAt: '2026-01-01T00:00:00.000Z',
      skills: [
        { id: 'taken', name: 'Taken', description: 'x', content: SAMPLE },
        { id: 'fresh', name: 'Fresh', description: 'x', content: SAMPLE },
      ],
    });
    expect(r.imported).toEqual(['fresh']);
    expect(r.skipped[0]).toMatchObject({ id: 'taken' });
  });
});

describe('bookmarks', () => {
  it('pins and unpins, and surfaces on the listing', async () => {
    await upload(SAMPLE, { id: 'mine' });
    expect((await listSkillStatus(repo)).find((s) => s.id === 'mine')?.bookmarked).toBe(false);

    await bookmarkSkill(repo, 'mine', true);
    expect((await listSkillStatus(repo)).find((s) => s.id === 'mine')?.bookmarked).toBe(true);

    await bookmarkSkill(repo, 'mine', false);
    expect((await listSkillStatus(repo)).find((s) => s.id === 'mine')?.bookmarked).toBe(false);
  });

  it('works on bundled skills too — pinning is not ownership', async () => {
    await bookmarkSkill(repo, 'bug-fix', true);
    expect((await listSkillStatus(repo)).find((s) => s.id === 'bug-fix')?.bookmarked).toBe(true);
  });

  it('refuses an id that is not in the catalog, so typos cannot accumulate', async () => {
    await expect(bookmarkSkill(repo, 'no-such-skill', true)).rejects.toThrow(SkillNotFoundError);
  });

  it('survives a corrupt bookmarks file instead of breaking the catalog', async () => {
    await mkdir(join(home, '.baton'), { recursive: true });
    await writeFile(bookmarksPath(), '{ not json', 'utf-8');
    expect(await loadBookmarks()).toEqual(new Set());
    await expect(listSkillStatus(repo)).resolves.toBeInstanceOf(Array);
  });

  it('drops the bookmark when the skill it pinned is deleted', async () => {
    await upload(SAMPLE, { id: 'doomed' });
    await bookmarkSkill(repo, 'doomed', true);
    expect(await loadBookmarks()).toContain('doomed');
    await removeSkill(repo, 'doomed');
    expect(await loadBookmarks()).not.toContain('doomed');
  });
});

describe('removeSkill', () => {
  it('deletes a skill of the user\'s own', async () => {
    await upload(SAMPLE, { id: 'mine' });
    const r = await removeSkill(repo, 'mine');
    expect(r.removed).toBe(true);
    expect(existsSync(join(globalSkillsDir(), 'mine.md'))).toBe(false);
    expect((await loadCatalog(repo)).some((s) => s.id === 'mine')).toBe(false);
  });

  it('refuses to delete a bundled skill', async () => {
    await expect(removeSkill(repo, 'bug-fix')).rejects.toThrow(SkillImportError);
    expect((await loadCatalog(repo)).some((s) => s.id === 'bug-fix')).toBe(true);
  });

  it('404s on an unknown id', async () => {
    await expect(removeSkill(repo, 'nope')).rejects.toThrow(SkillNotFoundError);
  });
});
