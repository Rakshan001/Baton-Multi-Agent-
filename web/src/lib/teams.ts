/**
 * The pure half of teams — grouping and filtering, with no React in it.
 *
 * Separated from features/TeamsPanel.tsx so these can be tested directly. The
 * one they exist for is `visibleGroups`: it decides what a team filter hides,
 * and the rule it must never lose is that a same-branch conflict is not
 * hideable. See the header of src/teams.ts for why.
 */
import type { MemberRow, Team } from "../types";

/** `a, b` → `["a","b"]`, matching `--projects` on the CLI. */
export function parseProjects(raw: string): string[] {
  return [...new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

/**
 * Does this team's scope cover a claim on `projectId`?
 * Mirrors `teamCovers` in src/teams.ts — an empty scope covers the whole hub,
 * and a single-repo hub (`projectId: null`) has nothing to be scoped away from.
 */
export function teamCovers(team: Team | null, projectId: string | null): boolean {
  if (!team || team.projects.length === 0) return true;
  if (projectId === null) return true;
  return team.projects.includes(projectId.toLowerCase());
}

export interface MemberGroup {
  team: Team | null;
  members: MemberRow[];
}

/**
 * Roster split by team: named teams first in their stored order, then whoever
 * is left.
 *
 * A team with nobody in it still gets a heading. An owner who has just created
 * a team and sees no trace of it on the roster reasonably concludes the click
 * failed — an empty group says "made it, now put someone in it".
 *
 * A member pointing at a team that no longer exists lands in the ungrouped
 * bucket rather than vanishing. The server already resolves those to null; this
 * handles the case where it did not, because a dropped row is the one failure
 * mode a roster must not have.
 */
export function groupMembersByTeam(members: MemberRow[], teams: Team[]): MemberGroup[] {
  const groups: MemberGroup[] = teams.map((t) => ({ team: t, members: [] }));
  const byId = new Map(groups.map((g) => [g.team!.id, g]));
  const loose: MemberRow[] = [];
  for (const m of members) {
    const g = m.team ? byId.get(m.team) : undefined;
    if (g) g.members.push(m);
    else loose.push(m);
  }
  // The ungrouped bucket is drawn only when it holds someone: on a hub with no
  // teams at all, a lone "No team" heading over the entire roster is noise.
  return loose.length ? [...groups, { team: null, members: loose }] : groups;
}

/** The shape `visibleGroups` needs — a subset of the Team screen's FileGroup. */
export interface FilterableGroup {
  projectId: string | null;
  claims: Array<{ memberId: string }>;
  overlap: { sameBranch: boolean } | null;
}

/**
 * Narrow a list of claim groups to one team.
 *
 * The ORDER of the two conditions is the point: a same-branch conflict passes
 * before the team is consulted at all. Two members on one file on one branch is
 * the whole reason the federation plane exists, and a filter able to hide one
 * would be a filter that costs data rather than noise.
 *
 * Everything else must be held by a member of the team AND fall inside that
 * team's project scope.
 */
export function visibleGroups<T extends FilterableGroup>(
  groups: T[],
  team: Team | null,
  memberTeam: Map<string, string | null>,
): T[] {
  if (!team) return groups;
  return groups.filter((g) => {
    if (g.overlap?.sameBranch) return true;
    if (!teamCovers(team, g.projectId)) return false;
    return g.claims.some((c) => memberTeam.get(c.memberId) === team.id);
  });
}
