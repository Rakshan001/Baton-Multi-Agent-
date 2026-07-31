/**
 * The team endpoints over HTTP, end to end against a real daemon.
 *
 * These run over loopback, which `decideAccess` treats as owner — someone with
 * shell access to the host has nothing left to be protected from. The
 * non-owner refusal is a property of `requiresOwner` and is unit-tested in
 * test/members.test.ts; every endpoint below consults exactly that function.
 * What is pinned HERE is the allowed path: that grouping a member changes the
 * roster and nothing else, and that deleting a team cannot cost anyone access.
 *
 * Gated on dist/cli.js being built (run `npm run build` first).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa, type ResultPromise } from 'execa';

const DIST_CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const hasDist = existsSync(DIST_CLI);
const PORT = 7398;
const BASE = `http://127.0.0.1:${PORT}`;

interface Json { status: number; body: any }

async function api(path: string, init?: RequestInit): Promise<Json> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(5000),
    ...init,
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

const post = (path: string, body?: unknown): Promise<Json> =>
  api(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe.runIf(hasDist)('team endpoints', () => {
  let dir = '';
  let child: ResultPromise | null = null;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'baton-teamapi-'));
    await execa('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    await execa('git', ['config', 'user.email', 't@t.dev'], { cwd: dir });
    await execa('git', ['config', 'user.name', 't'], { cwd: dir });
    await execa('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
    await execa('node', [DIST_CLI, 'member', 'add', 'Priya'], { cwd: dir });
    await execa('node', [DIST_CLI, 'member', 'add', 'Sam'], { cwd: dir });

    child = execa('node', [DIST_CLI, 'serve', '--write', '--port', String(PORT)], { cwd: dir, reject: false });
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/meta`, { signal: AbortSignal.timeout(1000) })).ok) break;
      } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error('daemon did not start');
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 40_000);

  afterAll(async () => {
    child?.kill('SIGTERM');
    await child?.catch(() => undefined);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('starts with no teams and every member ungrouped', async () => {
    const { body } = await api('/api/members');
    expect(body.teams).toEqual([]);
    expect(body.members.every((m: any) => m.team === null)).toBe(true);
  });

  it('creates a team, and the roster carries it in the same payload', async () => {
    // One poll drives the whole screen; a second endpoint for teams would be a
    // second thing to keep in step with the roster.
    const created = await post('/api/teams', { name: 'Platform Team', projects: ['api', 'API', 'web'] });
    expect(created.status).toBe(200);
    expect(created.body.team).toMatchObject({ id: 'platform-team', name: 'Platform Team', projects: ['api', 'web'] });

    const { body } = await api('/api/members');
    expect(body.teams.map((t: any) => t.id)).toEqual(['platform-team']);
  });

  it('refuses a duplicate and a nameless team with the server\'s own words', async () => {
    expect((await post('/api/teams', { name: 'platform team' })).status).toBe(409);
    const blank = await post('/api/teams', { name: '   ' });
    expect(blank.status).toBe(400);
    expect(blank.body.error).toMatch(/needs a name/);
  });

  it('assigns a member and reports it on the roster', async () => {
    const r = await post('/api/members/sam/team', { team: 'platform-team' });
    expect(r.status).toBe(200);
    const { body } = await api('/api/members');
    expect(body.members.find((m: any) => m.id === 'sam').team).toBe('platform-team');
    expect(body.members.find((m: any) => m.id === 'priya').team).toBeNull();
  });

  it('refuses to file someone under a team that does not exist', async () => {
    // Stored, it would put them in no group and in no filter — indistinguishable
    // from a write that silently failed.
    const r = await post('/api/members/sam/team', { team: 'ghost' });
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/no team/);
    const { body } = await api('/api/members');
    expect(body.members.find((m: any) => m.id === 'sam').team).toBe('platform-team');
  });

  it('renames without moving the id members point at', async () => {
    const r = await post('/api/teams/platform-team', { name: 'Infrastructure' });
    expect(r.body.team).toMatchObject({ id: 'platform-team', name: 'Infrastructure' });
    const { body } = await api('/api/members');
    expect(body.members.find((m: any) => m.id === 'sam').team).toBe('platform-team');
  });

  it('changes a scope, and an empty list means the whole hub', async () => {
    expect((await post('/api/teams/platform-team', { projects: ['web'] })).body.team.projects).toEqual(['web']);
    expect((await post('/api/teams/platform-team', { projects: [] })).body.team.projects).toEqual([]);
  });

  it('takes a member out of every team with null', async () => {
    expect((await post('/api/members/sam/team', { team: null })).status).toBe(200);
    const { body } = await api('/api/members');
    expect(body.members.find((m: any) => m.id === 'sam').team).toBeNull();
    await post('/api/members/sam/team', { team: 'platform-team' }); // put it back
  });

  /*
   * The property the delete dialog promises in bold. A team is a grouping; if
   * removing one could cost someone access, it would be a permission after all.
   */
  it('deleting a team unassigns its members and touches no credential', async () => {
    const before = JSON.parse(await readFile(join(dir, '.baton', 'members.json'), 'utf-8'));
    const hashes = before.members.map((m: any) => m.tokenHash);

    const r = await api('/api/teams/platform-team', { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(r.body.unassigned).toBe(1);
    expect(r.body.note).toMatch(/Nobody lost access/);

    const after = JSON.parse(await readFile(join(dir, '.baton', 'members.json'), 'utf-8'));
    expect(after.members.map((m: any) => m.tokenHash)).toEqual(hashes);
    expect(after.members.every((m: any) => m.revokedAt === undefined)).toBe(true);

    const { body } = await api('/api/members');
    expect(body.teams).toEqual([]);
    expect(body.members.every((m: any) => m.team === null)).toBe(true);
  });

  it('refuses to delete a team that is not there', async () => {
    expect((await api('/api/teams/ghost', { method: 'DELETE' })).status).toBe(409);
  });

  it('never leaks a token hash through the roster, teams and all', async () => {
    await post('/api/teams', { name: 'Product' });
    const { body } = await api('/api/members');
    expect(JSON.stringify(body)).not.toMatch(/tokenHash/);
  });
});

/**
 * The same operations from the CLI, which is the path that still works when the
 * dashboard cannot be reached — a read-only daemon, a stopped daemon, or a hub
 * bound to loopback on a machine you are SSH'd into.
 */
describe.runIf(hasDist)('baton team CLI', () => {
  let dir = '';

  const cli = async (args: string[]) => {
    const r = await execa('node', [DIST_CLI, ...args], { cwd: dir, reject: false });
    return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'baton-teamcli-'));
    await execa('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    await execa('git', ['config', 'user.email', 't@t.dev'], { cwd: dir });
    await execa('git', ['config', 'user.name', 't'], { cwd: dir });
    await execa('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  }, 40_000);

  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it('creates, assigns, lists and deletes — and says what a scope is not', async () => {
    const added = await cli(['team', 'add', 'Platform', '--projects', 'api,web']);
    expect(added.exitCode).toBe(0);
    // The correction has to arrive at the moment a scope is first set, which is
    // the moment the wrong idea would otherwise form.
    expect(added.stdout).toMatch(/not a permission/);

    await cli(['member', 'add', 'Priya']);
    const assigned = await cli(['team', 'assign', 'priya', 'platform']);
    expect(assigned.exitCode).toBe(0);

    const listed = await cli(['team', 'list']);
    expect(listed.stdout).toMatch(/platform/);
    expect(listed.stdout).toMatch(/api, web/);

    // `member list` grows a TEAM column rather than a second command to run.
    expect((await cli(['member', 'list'])).stdout).toMatch(/priya\s+owner\s+active\s+\S+\s+platform/);

    const removed = await cli(['team', 'rm', 'platform']);
    expect(removed.exitCode).toBe(0);
    expect(removed.stdout).toMatch(/Nobody lost access/);
    expect((await cli(['member', 'list'])).stdout).toMatch(/priya/); // still there, still active
  }, 30_000);

  it('refuses an unknown team BEFORE minting a token', async () => {
    // The token is shown exactly once, so a typo'd --team that failed after the
    // mint would cost a rotation to correct.
    const r = await cli(['member', 'add', 'Sam', '--team', 'ghost']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/no team 'ghost'/);
    expect(r.stdout).not.toMatch(/baton_[0-9a-f]{64}/);
    expect((await cli(['member', 'list'])).stdout).not.toMatch(/\bsam\b/);
  }, 30_000);

  it('refuses to assign to a team that does not exist, and names what does', async () => {
    await cli(['team', 'add', 'Product']);
    const r = await cli(['team', 'assign', 'priya', 'ghost']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/existing teams: product/);
  }, 30_000);
});
