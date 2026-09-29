// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/util/exec.js';
import {
  inspectRepo,
  listRemotes,
  matchProjects,
  normalizeRemote,
  resolveProjects,
  rootCommits,
  scanRoots,
  type ProjectDef,
  type ProjectResolution,
} from '../src/team/projects.js';

describe('normalizeRemote', () => {
  it('maps scp-like ssh, ssh://, and https to one canonical form', () => {
    const forms = [
      'git@github.com:acme/api.git',
      'git@github.com:acme/api',
      'ssh://git@github.com/acme/api.git',
      'ssh://git@github.com:22/acme/api.git',
      'git+ssh://git@github.com/acme/api',
      'https://github.com/acme/api',
      'https://github.com/acme/api.git',
      'https://github.com/acme/api/',
      'https://github.com/acme/api.git/',
      'https://ghp_secret@github.com/acme/api.git',
      'https://alice:hunter2@github.com/acme/api',
      'HTTPS://GitHub.COM/acme/api.git',
      'http://github.com:443/acme/api',
      '  https://github.com/acme/api  ',
    ];
    for (const f of forms) expect(normalizeRemote(f), f).toBe('github.com/acme/api');
  });

  it('keeps owner/repo case and nested groups (only the host is lowercased)', () => {
    expect(normalizeRemote('git@GitLab.com:Acme/Platform/Web.git')).toBe('gitlab.com/Acme/Platform/Web');
  });

  it('never keeps credentials in the output', () => {
    expect(normalizeRemote('https://user:ghp_abc@github.com/acme/api')).not.toMatch(/ghp_|user/);
  });

  it('rejects local paths, unsafe schemes and malformed input', () => {
    const bad = [
      '',
      '/srv/git/api.git',
      './api',
      '../api',
      'file:///srv/git/api.git',
      'C:\\repos\\api',
      'C:/repos/api',
      'ext::sh -c touch% /tmp/pwned',
      'https://github.com/acme',
      'https://github.com/',
      'git@github.com:',
      'https://github.com/acme/../api',
      'https://github.com/acme//api',
      'https://git hub.com/acme/api',
      'https://github.com/acme/api\nx',
      'git@:acme/api',
    ];
    for (const b of bad) expect(normalizeRemote(b), JSON.stringify(b)).toBeNull();
  });

  it('drops query strings and fragments', () => {
    expect(normalizeRemote('https://github.com/acme/api.git?x=1#frag')).toBe('github.com/acme/api');
  });
});

describe('matchProjects (pure)', () => {
  const defs: ProjectDef[] = [
    { key: 'prj_api', remotes: ['git@github.com:acme/api.git'], rootCommits: ['aaa'] },
    { key: 'prj_web', remotes: ['https://github.com/acme/web'], rootCommits: ['bbb'] },
  ];
  const repo = (top: string, urls: string[], roots: string[]) => ({
    gitToplevel: top,
    remotes: urls.map((u, i) => ({ name: `r${i}`, url: u, normalized: normalizeRemote(u) })),
    rootCommits: roots,
  });

  it('remote beats root commit, and root-commit-only is flagged', () => {
    const out = matchProjects(defs, [repo('/x/api', ['https://github.com/acme/api'], ['zzz']), repo('/x/web2', [], ['bbb'])]);
    expect(out.prj_api).toMatchObject({ match: 'remote', gitToplevel: '/x/api', needsChoice: false });
    expect(out.prj_web).toMatchObject({ match: 'root-commit-needs-confirm', gitToplevel: '/x/web2', needsChoice: true });
  });

  it('a repo claimed by remote for one key is not also claimed by root commit for another', () => {
    const out = matchProjects(
      [
        { key: 'prj_a', remotes: ['github.com/acme/a'], rootCommits: [] },
        { key: 'prj_b', remotes: ['github.com/acme/b'], rootCommits: ['same'] },
      ],
      [repo('/x/a', ['https://github.com/acme/a'], ['same'])],
    );
    expect(out.prj_a.match).toBe('remote');
    expect(out.prj_b).toMatchObject({ match: 'unmatched', gitToplevel: null, candidates: [] });
  });

  it('rejects an unsafe subpath from a definition instead of returning it', () => {
    const out = matchProjects(
      [{ key: 'prj_evil', remotes: ['github.com/acme/api'], rootCommits: [], subpath: '../../.ssh' }],
      [repo('/x/api', ['git@github.com:acme/api.git'], [])],
    );
    expect(out.prj_evil.match).toBe('unmatched');
    expect(out.prj_evil.subpath).toBeUndefined();
  });

  it('a checkout matched by two keys is never silently claimed by both', () => {
    const out = matchProjects(
      [
        { key: 'prj_a', remotes: ['github.com/acme/api'], rootCommits: [] },
        { key: 'prj_b', remotes: ['https://github.com/acme/api.git'], rootCommits: [] },
      ],
      [repo('/x/api', ['git@github.com:acme/api.git'], [])],
    );
    for (const k of ['prj_a', 'prj_b']) {
      expect(out[k]).toMatchObject({ match: 'remote', gitToplevel: null, candidates: ['/x/api'], needsChoice: true });
    }
  });

  it('a whole-repo key and a package key on one checkout also need a choice', () => {
    const out = matchProjects(
      [
        { key: 'prj_all', remotes: ['github.com/acme/mono'], rootCommits: [] },
        { key: 'prj_pkg', remotes: ['github.com/acme/mono'], rootCommits: [], subpath: 'packages/web' },
      ],
      [repo('/x/mono', ['https://github.com/acme/mono'], [])],
    );
    expect(out.prj_all.needsChoice).toBe(true);
    expect(out.prj_pkg.needsChoice).toBe(true);
  });

  it('distinct monorepo packages in one checkout resolve without a choice', () => {
    const out = matchProjects(
      [
        { key: 'prj_web', remotes: ['github.com/acme/mono'], rootCommits: [], subpath: 'packages/web' },
        { key: 'prj_api', remotes: ['github.com/acme/mono'], rootCommits: [], subpath: 'packages/api' },
      ],
      [repo('/x/mono', ['https://github.com/acme/mono'], [])],
    );
    expect(out.prj_web).toMatchObject({ gitToplevel: '/x/mono', subpath: 'packages/web', needsChoice: false });
    expect(out.prj_api).toMatchObject({ gitToplevel: '/x/mono', subpath: 'packages/api', needsChoice: false });
  });

  it('two keys naming the same package are a double claim', () => {
    const out = matchProjects(
      [
        { key: 'prj_1', remotes: ['github.com/acme/mono'], rootCommits: [], subpath: 'packages/web' },
        { key: 'prj_2', remotes: ['github.com/acme/mono'], rootCommits: [], subpath: 'packages/web' },
      ],
      [repo('/x/mono', ['https://github.com/acme/mono'], [])],
    );
    expect(out.prj_1).toMatchObject({ gitToplevel: null, needsChoice: true });
    expect(out.prj_2).toMatchObject({ gitToplevel: null, needsChoice: true });
  });
});

describe('normalizeRemote — authority confusion (security #6)', () => {
  it.each([
    ['https://evil.com#@github.com/acme/api'],
    ['https://evil.com?@github.com/acme/api'],
    ['git@evil.com#@github.com:acme/api'],
    ['git@evil.com?@github.com:acme/api'],
    ['https://evil.com\\@github.com/acme/api'],
    ['https://evil.com%23@github.com/acme/api'],
    ['ssh://git@evil.com%2F@github.com/acme/api'],
    ['evil.com\\@github.com:acme/api'],
  ])('rejects %s', (url) => {
    expect(normalizeRemote(url)).toBeNull();
  });

  it('still accepts ordinary userinfo and strips it', () => {
    expect(normalizeRemote('https://x-token:abc@github.com/acme/api.git')).toBe('github.com/acme/api');
    expect(normalizeRemote('git@github.com:acme/api.git')).toBe('github.com/acme/api');
  });
});

/* ------------------------------------------------------------------ */
/* Real git repositories                                               */
/* ------------------------------------------------------------------ */

const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];

async function initRepo(dir: string, file = 'README.md'): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(['init', '-q', '-b', 'main', dir]);
  await writeFile(join(dir, file), `# ${dir}\n`);
  await git(['-C', dir, 'add', '.']);
  await git([...ID, '-C', dir, 'commit', '-q', '-m', 'root']);
}

async function clone(src: string, dest: string, originUrl: string): Promise<void> {
  await git(['clone', '-q', src, dest]);
  await git(['-C', dest, 'remote', 'set-url', 'origin', originUrl]);
}

const REPOS = ['web', 'api', 'mobile', 'admin', 'infra'] as const;
const SSH = (r: string) => `git@github.com:acme/${r}.git`;
const HTTPS = (r: string) => `https://github.com/acme/${r}`;

describe('resolution across the four §1 setups (invariant 13)', () => {
  let base: string;
  let sources: string;
  const defs: ProjectDef[] = [];

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'baton-team-projects-')));
    sources = join(base, 'sources');
    // The "server" copies: one real history per repo so every clone shares root commits.
    for (const r of REPOS) await initRepo(join(sources, r));
    // Owner hub: 5 repos, SSH remotes. This is where `project.define` would be minted.
    for (const r of REPOS) await clone(join(sources, r), join(base, 'owner-hub', r), SSH(r));
    // Owner's hub also carries a Baton worktree and an ordinary linked worktree — neither is a project.
    await git(['-C', join(base, 'owner-hub', 'api'), 'worktree', 'add', '-q', '-b', 'baton/x', join(base, 'owner-hub', 'api', '.baton', 'wt', 'x')]);
    await git(['-C', join(base, 'owner-hub', 'web'), 'worktree', 'add', '-q', '-b', 'side', join(base, 'owner-hub', 'web-side')]);
    // Dev A: single repo, HTTPS with an embedded token.
    await clone(join(sources, 'api'), join(base, 'dev-a', 'backend'), 'https://ghp_token@github.com/acme/api.git');
    // Dev B: 2 repos; web is a FORK (origin = own fork, upstream = acme over SSH).
    await clone(join(sources, 'web'), join(base, 'dev-b', 'frontend'), 'https://github.com/devb/web.git');
    await git(['-C', join(base, 'dev-b', 'frontend'), 'remote', 'add', 'upstream', SSH('web')]);
    await clone(join(sources, 'api'), join(base, 'dev-b', 'acme-api'), HTTPS('api') + '/');
    // Dev C (designer): only web, HTTPS.
    await clone(join(sources, 'web'), join(base, 'dev-c', 'site'), HTTPS('web'));

    // Define projects from the owner's hub, as `project.define` would.
    const hub = await scanRoots([join(base, 'owner-hub')]);
    for (const top of hub) {
      const info = await inspectRepo(top);
      if (!info) continue;
      const name = top.split('/').pop()!;
      defs.push({
        key: `prj_${name}`, // stand-in for a random key; resolution never reads it from a folder
        remotes: info.remotes.map((x) => x.url),
        rootCommits: info.rootCommits,
      });
    }
  }, 60_000);

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('scanRoots finds the 5 hub repos and skips worktrees', async () => {
    const hub = await scanRoots([join(base, 'owner-hub')]);
    expect(hub).toEqual(REPOS.map((r) => join(base, 'owner-hub', r)).sort());
    expect(defs.map((d) => d.key).sort()).toEqual(REPOS.map((r) => `prj_${r}`).sort());
  });

  it('scanRoots treats a single-repo root as the repo itself', async () => {
    expect(await scanRoots([join(base, 'dev-a', 'backend')])).toEqual([join(base, 'dev-a', 'backend')]);
    // From a subdirectory too.
    await mkdir(join(base, 'dev-a', 'backend', 'src'), { recursive: true });
    expect(await scanRoots([join(base, 'dev-a', 'backend', 'src')])).toEqual([join(base, 'dev-a', 'backend')]);
  });

  async function resolveFor(root: string): Promise<Record<string, ProjectResolution>> {
    return resolveProjects(defs, await scanRoots([root]));
  }

  it('owner hub resolves all five keys by remote', async () => {
    const out = await resolveFor(join(base, 'owner-hub'));
    for (const r of REPOS) {
      expect(out[`prj_${r}`]).toMatchObject({ match: 'remote', gitToplevel: join(base, 'owner-hub', r), needsChoice: false });
    }
  });

  it('dev A (single repo, HTTPS + token, different folder name) resolves prj_api', async () => {
    const out = await resolveFor(join(base, 'dev-a', 'backend'));
    expect(out.prj_api).toMatchObject({ match: 'remote', gitToplevel: join(base, 'dev-a', 'backend') });
    expect(out.prj_web.match).toBe('unmatched');
  });

  it('dev B (2 repos, fork via upstream) resolves prj_web and prj_api', async () => {
    const out = await resolveFor(join(base, 'dev-b'));
    expect(out.prj_web).toMatchObject({ match: 'remote', gitToplevel: join(base, 'dev-b', 'frontend') });
    expect(out.prj_api).toMatchObject({ match: 'remote', gitToplevel: join(base, 'dev-b', 'acme-api') });
    expect(out.prj_mobile.match).toBe('unmatched');
  });

  it('designer (only web) resolves prj_web', async () => {
    const out = await resolveFor(join(base, 'dev-c', 'site'));
    expect(out.prj_web).toMatchObject({ match: 'remote', gitToplevel: join(base, 'dev-c', 'site') });
    expect(Object.values(out).filter((r) => r.match !== 'unmatched')).toHaveLength(1);
  });

  it('excludes linked worktrees and .baton/wt even when passed directly', async () => {
    const out = await resolveProjects(defs, [
      join(base, 'owner-hub', 'api', '.baton', 'wt', 'x'),
      join(base, 'owner-hub', 'web-side'),
    ]);
    expect(out.prj_api.match).toBe('unmatched');
    expect(out.prj_web.match).toBe('unmatched');
  });

  it('duplicate clones report every candidate and pick none', async () => {
    const out = await resolveProjects(defs, [join(base, 'dev-a', 'backend'), join(base, 'dev-b', 'acme-api')]);
    expect(out.prj_api).toMatchObject({
      match: 'remote',
      gitToplevel: null,
      needsChoice: true,
      candidates: [join(base, 'dev-a', 'backend'), join(base, 'dev-b', 'acme-api')].sort(),
    });
  });

  it('a clone with no remote falls back to root commit, flagged for confirmation', async () => {
    const bare = join(base, 'no-remote', 'mobile-copy');
    await git(['clone', '-q', join(sources, 'mobile'), bare]);
    await git(['-C', bare, 'remote', 'remove', 'origin']);
    expect(await listRemotes(bare)).toEqual([]);
    const out = await resolveFor(join(base, 'no-remote'));
    expect(out.prj_mobile).toMatchObject({ match: 'root-commit-needs-confirm', gitToplevel: bare, needsChoice: true });
  });

  it('an unrelated repo with no remote stays unmatched', async () => {
    const lone = join(base, 'lonely', 'scratch');
    await initRepo(lone, 'notes.txt');
    const out = await resolveFor(join(base, 'lonely'));
    expect(Object.values(out).every((r) => r.match === 'unmatched')).toBe(true);
  });

  it('empty repo (no commits) has no root commits and does not throw', async () => {
    const empty = join(base, 'empty-repo');
    await git(['init', '-q', empty]);
    expect(await rootCommits(empty)).toEqual([]);
  });

  it('monorepo subpath resolves to the package inside the matched repo', async () => {
    const out = await resolveProjects(
      [{ key: 'prj_web_pkg', remotes: [HTTPS('web')], rootCommits: [], subpath: 'packages/web' }],
      [join(base, 'dev-c', 'site')],
    );
    expect(out.prj_web_pkg).toMatchObject({ match: 'remote', gitToplevel: join(base, 'dev-c', 'site'), subpath: 'packages/web' });
  });

  it('listRemotes returns every remote with its normalized form', async () => {
    const r = await listRemotes(join(base, 'dev-b', 'frontend'));
    expect(r).toEqual([
      { name: 'origin', url: 'https://github.com/devb/web.git', normalized: 'github.com/devb/web' },
      { name: 'upstream', url: SSH('web'), normalized: 'github.com/acme/web' },
    ]);
  });

  it('scans nested repos up to depth 3 but not deeper', async () => {
    const deep = join(base, 'deep');
    await initRepo(join(deep, 'a', 'b', 'c'));
    await initRepo(join(deep, 'a', 'b', 'c2', 'd'));
    expect(await scanRoots([deep])).toEqual([join(deep, 'a', 'b', 'c')]);
  });
});
