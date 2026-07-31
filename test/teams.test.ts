import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_TEAMS, TeamError, addTeam, cleanProjectIds, cleanTeams, findTeam, loadTeams, removeTeam,
  saveTeams, teamCovers, teamId, teamsPath, updateTeam, type Team,
} from '../src/teams.js';
import {
  addMember, cleanRegistry, clearTeamAssignments, loadMembers, memberId, setMemberTeam,
} from '../src/members.js';
import { decideAccess, requiresOwner } from '../src/access.js';
import { slugify } from '../src/util/slug.js';

/**
 * Teams group members. The tests that matter here are the ones that pin what a
 * team is NOT: it must never become a permission, and it must never be able to
 * hide a claim conflict. Both are one edit away from being true, which is
 * exactly why they are asserted rather than only commented.
 */
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'baton-teams-'));
  await mkdir(join(root, '.baton'), { recursive: true });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const team = (over: Partial<Team> = {}): Team => ({
  id: 'platform', name: 'Platform', projects: [], createdAt: new Date().toISOString(), ...over,
});

/* ---------------- the slug both ids share ---------------- */

describe('slugify', () => {
  it('is idempotent even when the cap cuts mid-word', () => {
    // The bug this prevents: a name cut at a separator yields an id ending in
    // `-`, which the next pass strips — one identity, two spellings, depending
    // on how many times it had been round-tripped.
    const name = `${'a'.repeat(39)} tail`;
    const once = slugify(name, 40);
    expect(once).toBe(slugify(once, 40));
    expect(once.endsWith('-')).toBe(false);
  });

  it('leaves ordinary member ids exactly as they were', () => {
    expect(memberId('Priya Sharma')).toBe('priya-sharma');
    expect(memberId('  --Sam!!  ')).toBe('sam');
    expect(memberId('...')).toBe('');
  });
});

/* ---------------- project scope ---------------- */

describe('cleanProjectIds', () => {
  it('keeps the charset src/federation.ts assumes, and nothing else', () => {
    // keyOf() relies on a project id never containing NUL, `/` or a space.
    expect(cleanProjectIds(['api', 'web-ui', 'a.b_c'])).toEqual(['api', 'web-ui', 'a.b_c']);
    expect(cleanProjectIds(['a/b', 'a b', 'a\u0000b', '', 'x'.repeat(81)])).toEqual([]);
  });

  it('lowercases and de-duplicates', () => {
    expect(cleanProjectIds(['API', 'api', 'Web'])).toEqual(['api', 'web']);
  });

  it('is empty for anything that is not an array of strings', () => {
    expect(cleanProjectIds(null)).toEqual([]);
    expect(cleanProjectIds('api')).toEqual([]);
    expect(cleanProjectIds([1, {}, null])).toEqual([]);
  });
});

describe('teamCovers', () => {
  it('treats an empty scope as the whole hub, never as nothing', () => {
    // A team scoped to no project would be a team nobody could use, so the
    // empty list has to mean the opposite of what it looks like.
    expect(teamCovers(team({ projects: [] }), 'api')).toBe(true);
    expect(teamCovers(null, 'api')).toBe(true);
  });

  it('covers a single-repo hub, which has no project to be scoped away from', () => {
    expect(teamCovers(team({ projects: ['api'] }), null)).toBe(true);
  });

  it('matches by exact id, not by prefix', () => {
    const t = team({ projects: ['api'] });
    expect(teamCovers(t, 'api')).toBe(true);
    expect(teamCovers(t, 'API')).toBe(true);
    expect(teamCovers(t, 'api-v2')).toBe(false);
    expect(teamCovers(t, 'web')).toBe(false);
  });
});

/* ---------------- reading a file we did not write ---------------- */

describe('cleanTeams', () => {
  it('refuses a registry of the wrong version rather than guessing', () => {
    expect(cleanTeams({ version: 99, teams: [team()] })).toEqual([]);
    expect(cleanTeams({ teams: [team()] })).toEqual([]);
    expect(cleanTeams(null)).toEqual([]);
  });

  it('keeps the FIRST of a duplicated id — the one members already point at', () => {
    const out = cleanTeams({ version: 1, teams: [team({ name: 'First' }), team({ name: 'Second' })] });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('First');
  });

  it('caps the list and falls back to the id when a name is unusable', () => {
    const many = Array.from({ length: MAX_TEAMS + 5 }, (_, i) => team({ id: `t${i}`, name: '   ' }));
    const out = cleanTeams({ version: 1, teams: many });
    expect(out).toHaveLength(MAX_TEAMS);
    expect(out[0].name).toBe('t0');
  });

  it('drops an entry whose id slugs to nothing', () => {
    expect(cleanTeams({ version: 1, teams: [team({ id: '...' })] })).toEqual([]);
  });
});

describe('loadTeams', () => {
  it('is empty when the file is absent or corrupt — never throws into the roster', async () => {
    expect(await loadTeams(root)).toEqual([]);
    await writeFile(teamsPath(root), '{ not json');
    expect(await loadTeams(root)).toEqual([]);
  });
});

/* ---------------- CRUD ---------------- */

describe('addTeam', () => {
  it('round-trips through disk', async () => {
    const t = await addTeam(root, 'Platform Team', ['api', 'API', 'web']);
    expect(t.id).toBe('platform-team');
    expect(t.projects).toEqual(['api', 'web']);
    expect(await loadTeams(root)).toEqual([t]);
  });

  it('refuses a duplicate id and an unusable name', async () => {
    await addTeam(root, 'Platform');
    await expect(addTeam(root, 'platform')).rejects.toThrow(TeamError);
    await expect(addTeam(root, '...')).rejects.toThrow(/no usable letters/);
  });

  it('refuses past the cap', async () => {
    await saveTeams(root, Array.from({ length: MAX_TEAMS }, (_, i) => team({ id: `t${i}` })));
    await expect(addTeam(root, 'one more')).rejects.toThrow(/cap reached/);
  });
});

describe('updateTeam', () => {
  it('keeps the id when the display name changes', async () => {
    // Members point at the id. Renaming by minting a new one would silently
    // empty the team.
    const created = await addTeam(root, 'Platform');
    const renamed = await updateTeam(root, 'platform', { name: 'Infrastructure' });
    expect(renamed.id).toBe(created.id);
    expect(renamed.name).toBe('Infrastructure');
  });

  it('replaces the scope wholesale and refuses an empty name', async () => {
    await addTeam(root, 'Platform', ['api']);
    expect((await updateTeam(root, 'platform', { projects: ['web'] })).projects).toEqual(['web']);
    expect((await updateTeam(root, 'platform', { projects: [] })).projects).toEqual([]);
    await expect(updateTeam(root, 'platform', { name: '   ' })).rejects.toThrow(/needs a name/);
    await expect(updateTeam(root, 'nope', { name: 'x' })).rejects.toThrow(/no team/);
  });
});

describe('removeTeam', () => {
  it('deletes the team but leaves the member file to the caller', async () => {
    await addTeam(root, 'Platform');
    const { member } = await addMember(root, 'Priya', 'owner', { team: 'platform' });
    await removeTeam(root, 'platform');

    // Still pointing at it on disk — deliberately. The two files are written
    // separately, and a stale pointer already reads as "no team".
    expect((await loadMembers(root)).members.find((m) => m.id === member.id)?.team).toBe('platform');
    const cleared = await clearTeamAssignments(root, 'platform');
    expect(cleared).toBe(1);
    expect((await loadMembers(root)).members[0].team).toBeUndefined();
  });

  it('refuses a team that does not exist', async () => {
    await expect(removeTeam(root, 'ghost')).rejects.toThrow(/no team/);
  });
});

/* ---------------- the member's side ---------------- */

describe('member team assignment', () => {
  it('is one team at a time — assigning replaces', async () => {
    await addTeam(root, 'Platform');
    await addTeam(root, 'Product');
    const { member } = await addMember(root, 'Sam');
    await setMemberTeam(root, member.id, 'platform');
    const moved = await setMemberTeam(root, member.id, 'product');
    expect(moved.team).toBe('product');
  });

  it('takes a member out with null', async () => {
    await addTeam(root, 'Platform');
    const { member } = await addMember(root, 'Sam', 'member', { team: 'platform' });
    expect((await setMemberTeam(root, member.id, null)).team).toBeUndefined();
  });

  it('refuses an unknown member and an unusable team id', async () => {
    await addMember(root, 'Sam');
    await expect(setMemberTeam(root, 'ghost', null)).rejects.toThrow(/no active member/);
    await expect(setMemberTeam(root, 'sam', '...')).rejects.toThrow(/not a usable team id/);
  });

  it('re-slugs a hand-edited team field on read', async () => {
    const reg = cleanRegistry({
      version: 1,
      members: [{
        id: 'sam', name: 'Sam', role: 'member', tokenHash: 'a'.repeat(64),
        createdAt: new Date().toISOString(), team: 'Platform Team!!',
      }],
    });
    expect(reg.members[0].team).toBe('platform-team');
  });

  it('drops a team field that slugs to nothing rather than storing an empty group', () => {
    const reg = cleanRegistry({
      version: 1,
      members: [{
        id: 'sam', name: 'Sam', role: 'member', tokenHash: 'a'.repeat(64),
        createdAt: new Date().toISOString(), team: '...',
      }],
    });
    expect(reg.members[0].team).toBeUndefined();
  });
});

describe('findTeam', () => {
  it('resolves by id or by display name, and null for nothing', () => {
    const teams = [team({ id: 'platform' })];
    expect(findTeam(teams, 'platform')?.id).toBe('platform');
    expect(findTeam(teams, 'Platform')?.id).toBe('platform');
    expect(findTeam(teams, 'product')).toBeNull();
    expect(findTeam(teams, null)).toBeNull();
    expect(findTeam(teams, '')).toBeNull();
  });
});

/* ---------------- the line that must not move ---------------- */

describe('a team is not a permission', () => {
  /*
   * The whole feature rests on this. A team's project scope is a view filter;
   * if it ever reached the access boundary, a hub owner would believe they had
   * partitioned a repo they had in fact only sorted.
   */
  it('changes nothing about what decideAccess allows', async () => {
    await addTeam(root, 'Platform', ['api']);
    const { token } = await addMember(root, 'Priya', 'owner');
    const { member, token: samToken } = await addMember(root, 'Sam', 'member', { team: 'platform' });
    expect(member.team).toBe('platform');

    const reg = await loadMembers(root);
    const req = (auth: string, path = '/api/kb') => decideAccess(
      { remoteAddr: '192.168.1.9', path, authorization: `Bearer ${auth}` }, reg,
    );

    // A member scoped to `api` still reaches every endpoint, including one for
    // a project their team is not scoped to. That is the honest behaviour, and
    // the UI says so in those words.
    const sam = req(samToken);
    expect(sam.allow).toBe(true);
    expect(req(samToken, '/api/kb?project=web').allow).toBe(true);
    // …and is still not an owner, which is the boundary that IS real.
    expect(requiresOwner(sam)).toBe(true);
    expect(requiresOwner(req(token))).toBe(false);
  });

  it('is not written into the credential material', async () => {
    await addTeam(root, 'Platform');
    await addMember(root, 'Sam', 'member', { team: 'platform' });
    const raw = JSON.parse(await readFile(join(root, '.baton', 'members.json'), 'utf-8'));
    // The team is a label beside the hash, never mixed into it: moving someone
    // between teams must not invalidate their token.
    expect(raw.members[0].team).toBe('platform');
    expect(raw.members[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('survives a team file that has been deleted entirely', async () => {
    await addTeam(root, 'Platform');
    const { token } = await addMember(root, 'Sam', 'member', { team: 'platform' });
    await rm(teamsPath(root));
    const reg = await loadMembers(root);
    // Losing teams.json loses the grouping and nothing else. If it could lock
    // anyone out, a file with no credentials in it would be a credential.
    expect(decideAccess({ remoteAddr: '10.0.0.5', path: '/api/status', authorization: `Bearer ${token}` }, reg).allow).toBe(true);
    expect(await loadTeams(root)).toEqual([]);
  });
});

describe('teamId', () => {
  it('caps shorter than a member id, and stays idempotent there', () => {
    const long = 'x'.repeat(50);
    expect(teamId(long)).toHaveLength(32);
    expect(teamId(teamId(long))).toBe(teamId(long));
  });
});
