// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `baton team add|list|rm|assign|scope` — grouping over members.
 *
 * The CLI half of src/teams.ts, and the escape hatch when the dashboard is not
 * reachable: everything here works on a loopback daemon, on a read-only daemon,
 * and with the daemon stopped, because it edits `.baton/teams.json` directly.
 *
 * These commands change how the roster is GROUPED and how the who's-editing
 * view is FILTERED. They change nobody's access — see the header of
 * src/teams.ts. `baton member revoke` is still the only thing that takes access
 * away, and the output here says so wherever someone might hope otherwise.
 */
import { activeMembers, clearTeamAssignments, loadMembers, setMemberTeam } from '../members.js';
import { activeBatonRoot } from '../store.js';
import { addTeam, findTeam, loadTeams, removeTeam, teamId, teamsPath, updateTeam, type Team } from '../teams.js';

/** `--projects a,b` or `--projects "a, b"`. Empty ⇒ the whole hub. */
function parseProjects(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

const scopeOf = (t: Team): string => (t.projects.length ? t.projects.join(', ') : 'whole hub');

export async function teamAddCmd(name: string, opts: { projects?: string } = {}): Promise<void> {
  const root = await activeBatonRoot();
  const team = await addTeam(root, name, parseProjects(opts.projects));
  console.log(`✓ team ${team.name} (${team.id}) created — scope: ${scopeOf(team)}`);
  console.log(`  Put someone in it:  baton team assign <member-id> ${team.id}`);
  if (team.projects.length) {
    // Said at the moment a scope is first set, which is the moment the wrong
    // idea would form.
    console.log('  Scope filters what this team SEES in the dashboard. It is not a permission —');
    console.log('  every member token still reaches every project on this hub.');
  }
}

export async function teamListCmd(): Promise<void> {
  const root = await activeBatonRoot();
  const [teams, reg] = await Promise.all([loadTeams(root), loadMembers(root)]);
  if (!teams.length) {
    console.log('No teams. Members are one flat roster until you add one:');
    console.log('    baton team add "<name>" --projects api,web');
    console.log(`  (would live at ${teamsPath(root)})`);
    return;
  }

  const active = activeMembers(reg);
  console.log('ID                    MEMBERS  SCOPE');
  for (const t of teams) {
    const n = active.filter((m) => m.team === t.id).length;
    console.log(`${t.id.padEnd(21)} ${String(n).padStart(7)}  ${scopeOf(t)}`);
  }
  const loose = active.filter((m) => !m.team || !teams.some((t) => t.id === m.team)).length;
  if (loose) console.log(`\n  ${loose} member${loose === 1 ? '' : 's'} in no team.`);
}

export async function teamRemoveCmd(idOrName: string): Promise<void> {
  const root = await activeBatonRoot();
  const team = await removeTeam(root, idOrName);
  const unassigned = await clearTeamAssignments(root, team.id);
  console.log(`✓ team ${team.id} deleted`);
  console.log(unassigned
    ? `  ${unassigned} member${unassigned === 1 ? '' : 's'} moved to no team. Nobody lost access — a team was only ever a grouping.`
    : '  Nobody was in it.');
}

export async function teamAssignCmd(memberIdOrName: string, teamIdOrNone: string): Promise<void> {
  const root = await activeBatonRoot();
  const wanted = /^(none|-)$/i.test(teamIdOrNone.trim()) ? '' : teamId(teamIdOrNone);
  if (wanted) {
    const teams = await loadTeams(root);
    if (!findTeam(teams, wanted)) {
      // Refusing beats storing a pointer at nothing: the member would appear in
      // no group and in no filter, which looks exactly like a failed write.
      const known = teams.map((t) => t.id).join(', ') || '(none yet)';
      throw new Error(`no team '${wanted}' — existing teams: ${known}`);
    }
  }
  const member = await setMemberTeam(root, memberIdOrName, wanted || null);
  console.log(wanted
    ? `✓ ${member.name} (${member.id}) is now in ${wanted}`
    : `✓ ${member.name} (${member.id}) is now in no team`);
}

export async function teamScopeCmd(idOrName: string, projects: string | undefined): Promise<void> {
  const root = await activeBatonRoot();
  const team = await updateTeam(root, idOrName, { projects: parseProjects(projects) });
  console.log(`✓ ${team.id} scope: ${scopeOf(team)}`);
  console.log('  A view filter, not a permission — it changes what this team sees, not what it can reach.');
}
