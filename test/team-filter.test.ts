// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The dashboard's team grouping and filter (web/src/lib/teams.ts).
 *
 * One of these tests is the reason the file exists: a team filter must not be
 * able to hide a same-branch conflict. Everything else on the Team screen is a
 * convenience; that one is the signal two people are about to overwrite each
 * other, and a filter that swallowed it would turn a loud warning into silence
 * exactly when someone had narrowed the view to concentrate.
 */
import { describe, it, expect } from 'vitest';
import { groupMembersByTeam, parseProjects, teamCovers, visibleGroups } from '../web/src/lib/teams';
import type { MemberRow, Team } from '../web/src/types';

const team = (id: string, projects: string[] = []): Team =>
  ({ id, name: id[0].toUpperCase() + id.slice(1), projects, createdAt: '2026-07-01T00:00:00.000Z' });

const member = (id: string, t: string | null): MemberRow => ({
  id, name: id, role: 'member', registered: true, team: t,
  createdAt: '2026-07-01T00:00:00.000Z', online: true, device: null, sessions: 1,
  since: null, lastSeen: null, claims: 0, warnings: [],
});

const group = (projectId: string | null, memberIds: string[], sameBranch: boolean | null = null) => ({
  projectId,
  claims: memberIds.map((memberId) => ({ memberId })),
  overlap: sameBranch === null ? null : { sameBranch },
});

const PLATFORM = team('platform');
const PRODUCT = team('product');
const TEAM_OF = new Map<string, string | null>([['priya', 'platform'], ['sam', 'platform'], ['jules', 'product']]);

describe('visibleGroups', () => {
  it('shows everything when no team is selected', () => {
    const groups = [group(null, ['priya']), group(null, ['jules'])];
    expect(visibleGroups(groups, null, TEAM_OF)).toHaveLength(2);
  });

  it('keeps only the selected team\'s files', () => {
    const groups = [group(null, ['priya']), group(null, ['jules'])];
    const out = visibleGroups(groups, PLATFORM, TEAM_OF);
    expect(out).toHaveLength(1);
    expect(out[0].claims[0].memberId).toBe('priya');
  });

  /*
   * The one that must never regress. Priya and Jules are in different teams and
   * are on the same file on the same branch. Filtering to either team still
   * shows it — the conflict passes before the team is consulted at all.
   */
  it('NEVER hides a same-branch conflict, whichever team is selected', () => {
    const conflict = group(null, ['priya', 'jules'], true);
    expect(visibleGroups([conflict], PLATFORM, TEAM_OF)).toHaveLength(1);
    expect(visibleGroups([conflict], PRODUCT, TEAM_OF)).toHaveLength(1);
    // …including a team with nobody involved in it at all.
    expect(visibleGroups([conflict], team('design'), TEAM_OF)).toHaveLength(1);
    // …and even when the file is outside that team's project scope.
    expect(visibleGroups([{ ...conflict, projectId: 'web' }], team('api-only', ['api']), TEAM_OF)).toHaveLength(1);
  });

  it('DOES hide a cross-branch overlap, which is information rather than a warning', () => {
    // Divergent branches meet at merge, not in a working tree. Treating this
    // like a conflict would train people to ignore the real ones.
    const shared = group(null, ['priya', 'jules'], false);
    expect(visibleGroups([shared], PRODUCT, TEAM_OF)).toHaveLength(1); // jules is in it
    expect(visibleGroups([shared], team('design'), TEAM_OF)).toHaveLength(0);
  });

  it('applies the project scope on top of membership', () => {
    const apiOnly = team('platform', ['api']);
    const groups = [group('api', ['priya']), group('web', ['priya'])];
    const out = visibleGroups(groups, apiOnly, TEAM_OF);
    expect(out).toHaveLength(1);
    expect(out[0].projectId).toBe('api');
  });

  it('does not scope away a single-repo hub', () => {
    // projectId null means there IS no project — a scope has nothing to bite on.
    expect(visibleGroups([group(null, ['priya'])], team('platform', ['api']), TEAM_OF)).toHaveLength(1);
  });

  it('drops a claim whose holder is in no team', () => {
    const orphan = new Map<string, string | null>([['dana', null]]);
    expect(visibleGroups([group(null, ['dana'])], PLATFORM, orphan)).toHaveLength(0);
  });
});

describe('groupMembersByTeam', () => {
  it('keeps team order and buckets the rest', () => {
    const rows = [member('priya', 'platform'), member('jules', 'product'), member('dana', null)];
    const out = groupMembersByTeam(rows, [PLATFORM, PRODUCT]);
    expect(out.map((g) => g.team?.id ?? null)).toEqual(['platform', 'product', null]);
    expect(out[2].members.map((m) => m.id)).toEqual(['dana']);
  });

  it('gives an empty team a heading anyway', () => {
    // Otherwise creating a team looks like it did nothing.
    const out = groupMembersByTeam([member('priya', 'platform')], [PLATFORM, PRODUCT]);
    expect(out.find((g) => g.team?.id === 'product')?.members).toEqual([]);
  });

  it('omits the ungrouped heading when nobody is ungrouped', () => {
    const out = groupMembersByTeam([member('priya', 'platform')], [PLATFORM]);
    expect(out).toHaveLength(1);
  });

  it('never loses a member pointing at a team that does not exist', () => {
    // The server resolves these to null; this is the belt to that braces. A
    // roster may render someone in the wrong place, but never nowhere.
    const out = groupMembersByTeam([member('ghosty', 'deleted-team')], [PLATFORM]);
    expect(out.flatMap((g) => g.members).map((m) => m.id)).toEqual(['ghosty']);
    expect(out.find((g) => g.team === null)?.members).toHaveLength(1);
  });

  it('returns one group per team on an empty roster', () => {
    expect(groupMembersByTeam([], [PLATFORM])).toEqual([{ team: PLATFORM, members: [] }]);
    expect(groupMembersByTeam([], [])).toEqual([]);
  });
});

describe('teamCovers', () => {
  it('matches src/teams.ts exactly — empty scope is the whole hub', () => {
    expect(teamCovers(PLATFORM, 'api')).toBe(true);
    expect(teamCovers(null, 'api')).toBe(true);
    expect(teamCovers(team('t', ['api']), 'api-v2')).toBe(false);
    expect(teamCovers(team('t', ['api']), null)).toBe(true);
  });
});

describe('parseProjects', () => {
  it('reads what someone types into the scope field', () => {
    expect(parseProjects(' api , Web ,, api ')).toEqual(['api', 'web']);
    expect(parseProjects('')).toEqual([]);
    expect(parseProjects('   ')).toEqual([]);
  });
});
