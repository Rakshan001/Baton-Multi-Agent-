// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import {
  parseSkillSource,
  parseGitHubUrl,
  findSkillCandidates,
  filesForSkill,
  fetchGitHubSkill,
  MAX_ASSET_BYTES,
} from '../src/skills/github.js';
import { executableFiles } from '../src/skills/install.js';

describe('parseSkillSource', () => {
  it('takes the URL out of a pasted npx command, with the skill flag', () => {
    expect(parseSkillSource('npx skills add https://github.com/nextlevelbuilder/ui-ux-pro-max-skill --skill ui-ux-pro-max'))
      .toEqual({ url: 'https://github.com/nextlevelbuilder/ui-ux-pro-max-skill', skill: 'ui-ux-pro-max' });
  });

  it('accepts a bare URL', () => {
    expect(parseSkillSource('  https://github.com/o/r  ')).toEqual({ url: 'https://github.com/o/r' });
  });

  it('accepts --skill=name and -s name', () => {
    expect(parseSkillSource('npx skills add https://x.dev/r --skill=foo')?.skill).toBe('foo');
    expect(parseSkillSource('npx skills add https://x.dev/r -s bar')?.skill).toBe('bar');
  });

  it('drops trailing punctuation from a quoted URL', () => {
    expect(parseSkillSource('see https://github.com/o/r.')?.url).toBe('https://github.com/o/r');
    expect(parseSkillSource('(https://github.com/o/r)')?.url).toBe('https://github.com/o/r');
  });

  it('returns null when there is no URL at all', () => {
    expect(parseSkillSource('npx skills add')).toBeNull();
    expect(parseSkillSource('')).toBeNull();
  });
});

describe('parseGitHubUrl', () => {
  it('reads a bare repo URL', () => {
    expect(parseGitHubUrl('https://github.com/owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('strips a .git suffix', () => {
    expect(parseGitHubUrl('https://github.com/owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('reads tree and blob URLs, keeping ref and path', () => {
    expect(parseGitHubUrl('https://github.com/o/r/tree/main/.claude/skills/foo'))
      .toEqual({ owner: 'o', repo: 'r', ref: 'main', path: '.claude/skills/foo' });
    expect(parseGitHubUrl('https://github.com/o/r/blob/v2/skills/foo/SKILL.md'))
      .toEqual({ owner: 'o', repo: 'r', ref: 'v2', path: 'skills/foo/SKILL.md' });
  });

  it('declines raw.githubusercontent and other hosts, which import directly', () => {
    expect(parseGitHubUrl('https://raw.githubusercontent.com/o/r/main/SKILL.md')).toBeNull();
    expect(parseGitHubUrl('https://gitlab.com/o/r')).toBeNull();
    expect(parseGitHubUrl('not a url')).toBeNull();
  });
});

/** The real shape of nextlevelbuilder/ui-ux-pro-max-skill: seven skills, each
 *  present twice — the canonical .claude/skills copy and a cli/assets copy. */
const REPO = [
  '.claude/skills/banner-design/SKILL.md',
  '.claude/skills/brand/SKILL.md',
  '.claude/skills/design/SKILL.md',
  '.claude/skills/design-system/SKILL.md',
  '.claude/skills/slides/SKILL.md',
  '.claude/skills/ui-styling/SKILL.md',
  '.claude/skills/ui-ux-pro-max/SKILL.md',
  '.claude/skills/ui-ux-pro-max/references/pro-rules.md',
  '.claude/skills/ui-ux-pro-max/references/quick-reference.md',
  '.claude/skills/ui-ux-pro-max/scripts/search.py',
  '.claude/skills/ui-ux-pro-max/data/google-fonts.csv',
  'cli/assets/skills/banner-design/SKILL.md',
  'cli/assets/skills/ui-styling/SKILL.md',
  'README.md',
  'screenshots/website.png',
];

describe('findSkillCandidates', () => {
  it('finds every skill once, preferring the canonical copy over the packaging copy', () => {
    const found = findSkillCandidates(REPO);
    expect(found.map((c) => c.id).sort()).toEqual(
      ['banner-design', 'brand', 'design', 'design-system', 'slides', 'ui-styling', 'ui-ux-pro-max'],
    );
    expect(found.find((c) => c.id === 'banner-design')!.dir).toBe('.claude/skills/banner-design');
  });

  it('narrows to the named skill', () => {
    expect(findSkillCandidates(REPO, 'ui-ux-pro-max')).toEqual([
      { id: 'ui-ux-pro-max', dir: '.claude/skills/ui-ux-pro-max' },
    ]);
  });

  it('falls back to every candidate when the name matches nothing', () => {
    expect(findSkillCandidates(REPO, 'no-such-skill')).toHaveLength(7);
  });

  it('handles a SKILL.md at the repo root', () => {
    expect(findSkillCandidates(['SKILL.md', 'README.md'])).toEqual([{ id: '', dir: '' }]);
  });

  it('ignores SKILL.md inside node_modules and .git', () => {
    expect(findSkillCandidates(['node_modules/x/SKILL.md', '.git/SKILL.md'])).toEqual([]);
  });
});

describe('filesForSkill', () => {
  it('takes only that skill\'s subtree, SKILL.md first', () => {
    const files = filesForSkill(REPO, '.claude/skills/ui-ux-pro-max');
    expect(files[0]).toBe('.claude/skills/ui-ux-pro-max/SKILL.md');
    expect(files).toHaveLength(5);
    expect(files.some((f) => f.includes('banner-design'))).toBe(false);
  });
});

/* ---- fetch, with the network injected ---- */

const TREE = JSON.stringify({
  tree: REPO.map((path) => ({ path, type: 'blob', size: 100 })),
});

function fakeFetch(overrides: Record<string, string | Error> = {}) {
  const calls: string[] = [];
  const fn = async (url: string): Promise<string> => {
    calls.push(url);
    for (const [frag, val] of Object.entries(overrides)) {
      if (url.includes(frag)) { if (val instanceof Error) throw val; return val; }
    }
    if (url.includes('/git/trees/')) return TREE;
    if (url.startsWith('https://api.github.com/repos/')) return JSON.stringify({ default_branch: 'main' });
    return `content of ${url.split('/').pop()}`;
  };
  return { fn, calls };
}

describe('fetchGitHubSkill', () => {
  it('pulls the whole skill directory, not just SKILL.md', async () => {
    const { fn } = fakeFetch({ 'SKILL.md': '---\nname: ui-ux-pro-max\n---\n\n# UI\n' });
    const res = await fetchGitHubSkill({ owner: 'o', repo: 'r' }, 'ui-ux-pro-max', fn, 256 * 1024);
    expect('skill' in res).toBe(true);
    if (!('skill' in res)) return;
    expect(res.skill.id).toBe('ui-ux-pro-max');
    expect(res.skill.files.map((f) => f.rel).sort()).toEqual([
      'SKILL.md', 'data/google-fonts.csv', 'references/pro-rules.md', 'references/quick-reference.md', 'scripts/search.py',
    ]);
    expect(res.skill.origin).toBe('github.com/o/r@main');
  });

  it('asks which one when the repo holds several and none was named', async () => {
    const { fn } = fakeFetch();
    const res = await fetchGitHubSkill({ owner: 'o', repo: 'r' }, undefined, fn, 256 * 1024);
    expect('choices' in res).toBe(true);
    if (!('choices' in res)) return;
    expect(res.choices).toHaveLength(7);
  });

  it('honours a directory named in the URL without a --skill flag', async () => {
    const { fn } = fakeFetch({ 'SKILL.md': '---\nname: brand\n---\n\n# Brand\n' });
    const res = await fetchGitHubSkill(
      { owner: 'o', repo: 'r', ref: 'main', path: '.claude/skills/brand' }, undefined, fn, 256 * 1024,
    );
    expect('skill' in res && res.skill.id).toBe('brand');
  });

  it('skips binary assets and says so instead of storing mojibake', async () => {
    const tree = JSON.stringify({ tree: [
      { path: 's/SKILL.md', type: 'blob', size: 10 },
      { path: 's/logo.png', type: 'blob', size: 10 },
      { path: 's/font.woff2', type: 'blob', size: 10 },
    ] });
    const { fn } = fakeFetch({ '/git/trees/': tree, 'SKILL.md': '# s\n' });
    const res = await fetchGitHubSkill({ owner: 'o', repo: 'r' }, 's', fn, 256 * 1024);
    if (!('skill' in res)) throw new Error('expected a skill');
    expect(res.skill.files.map((f) => f.rel)).toEqual(['SKILL.md']);
    expect(res.skill.skipped).toEqual(['font.woff2 (binary)', 'logo.png (binary)']);
  });

  it('skips an oversized asset but keeps the skill', async () => {
    const tree = JSON.stringify({ tree: [
      { path: 's/SKILL.md', type: 'blob', size: 10 },
      { path: 's/data/huge.csv', type: 'blob', size: MAX_ASSET_BYTES + 1 },
    ] });
    const { fn } = fakeFetch({ '/git/trees/': tree, 'SKILL.md': '# s\n' });
    const res = await fetchGitHubSkill({ owner: 'o', repo: 'r' }, 's', fn, 256 * 1024);
    if (!('skill' in res)) throw new Error('expected a skill');
    expect(res.skill.files.map((f) => f.rel)).toEqual(['SKILL.md']);
    expect(res.skill.skipped[0]).toMatch(/^data\/huge\.csv \(\d+KB\)$/);
  });

  it('survives one unreadable asset but not an unreadable SKILL.md', async () => {
    const tree = JSON.stringify({ tree: [
      { path: 's/SKILL.md', type: 'blob', size: 10 },
      { path: 's/scripts/a.py', type: 'blob', size: 10 },
    ] });
    const ok = fakeFetch({ '/git/trees/': tree, 'SKILL.md': '# s\n', 'a.py': new Error('HTTP 404') });
    const res = await fetchGitHubSkill({ owner: 'o', repo: 'r' }, 's', ok.fn, 256 * 1024);
    if (!('skill' in res)) throw new Error('expected a skill');
    expect(res.skill.skipped).toEqual(['scripts/a.py (HTTP 404)']);

    const bad = fakeFetch({ '/git/trees/': tree, 'SKILL.md': new Error('HTTP 500') });
    await expect(fetchGitHubSkill({ owner: 'o', repo: 'r' }, 's', bad.fn, 256 * 1024)).rejects.toThrow('HTTP 500');
  });

  it('reports a repo with no SKILL.md rather than inventing one', async () => {
    const { fn } = fakeFetch({ '/git/trees/': JSON.stringify({ tree: [{ path: 'README.md', type: 'blob', size: 1 }] }) });
    await expect(fetchGitHubSkill({ owner: 'o', repo: 'r' }, undefined, fn, 256 * 1024))
      .rejects.toThrow(/no SKILL\.md found/);
  });

  it('asks the API for the default branch only when the URL did not name one', async () => {
    const named = fakeFetch({ 'SKILL.md': '# s\n' });
    await fetchGitHubSkill({ owner: 'o', repo: 'r', ref: 'v9' }, 'ui-ux-pro-max', named.fn, 256 * 1024);
    expect(named.calls.some((c) => c === 'https://api.github.com/repos/o/r')).toBe(false);
    expect(named.calls.some((c) => c.includes('/git/trees/v9'))).toBe(true);
  });
});

describe('executableFiles', () => {
  it('names the code a skill brought, so installing it is a decision not a surprise', () => {
    expect(executableFiles([
      { rel: 'references/rules.md' },
      { rel: 'scripts/search.py' },
      { rel: 'data/fonts.csv' },
      { rel: 'bin/run.sh' },
    ])).toEqual(['bin/run.sh', 'scripts/search.py']);
  });

  it('says nothing about a prose-only skill', () => {
    expect(executableFiles([{ rel: 'references/a.md' }, { rel: 'data/b.json' }])).toEqual([]);
  });
});
