/**
 * Teams — a grouping over members.
 *
 * A team is two things and no more: a label a member carries, and a list of hub
 * projects that team works on. It sorts the roster and it narrows the
 * who's-editing view. That is the whole feature.
 *
 * What a team is NOT, and must not quietly become:
 *
 * - **A permission.** A team's `projects` list is a VIEW SCOPE. Every member
 *   token already reaches every endpoint on this hub, and every member has a
 *   full clone of every repo the workspace manifest names — edge case E7 says
 *   in bold that revoking someone does not take the code back, and a filter in
 *   a dashboard takes back even less. A real per-project boundary would have to
 *   run through the KB, tasks, memory and history at once; that is a phase of
 *   its own. Shipping the filter and *calling* it a permission would be worse
 *   than either, so every surface says "filters what this team sees" in those
 *   words. Nothing in this file is ever consulted by `decideAccess`.
 * - **A claim boundary.** Overlap and conflict detection (src/federation.ts)
 *   never reads a team. Two teams editing one file on one branch is precisely
 *   the collision the whole plane exists to shout about, and a filter able to
 *   hide it would be a filter that costs data. The dashboard filter is applied
 *   to the browse list only, never to conflicts.
 *
 * Stored in its own file rather than in members.json: teams hold no credential
 * material, and a member's `team` is only a slug — so a deleted team reads as
 * "no team" instead of requiring two files to stay in agreement.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { batonDir } from './store.js';
import { withLock } from './util/lock.js';
import { slugify } from './util/slug.js';

export const TEAMS_VERSION = 1;

/** Small caps, deliberately. A hub with 20 teams has a different problem than
 *  the one this file solves, and an unbounded list read from disk is an
 *  unbounded list rendered in a browser. */
export const MAX_TEAMS = 20;
export const TEAM_ID_MAX = 32;
export const TEAM_NAME_MAX = 60;
export const MAX_TEAM_PROJECTS = 50;

/** Matches the charset assumed by `keyOf` in src/federation.ts, which relies on
 *  a project id never containing NUL or `/`. */
const PROJECT_ID_RE = /^[a-z0-9._-]{1,80}$/;

export interface Team {
  id: string;
  name: string;
  /** Hub project ids this team works on. **Empty means the whole hub** — an
   *  empty list is "unscoped", never "scoped to nothing", because a team that
   *  could see no project would be a team nobody could use. */
  projects: string[];
  createdAt: string;
}

export interface TeamRegistry {
  version: number;
  teams: Team[];
}

export class TeamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamError';
  }
}

export function teamsPath(root: string): string {
  return join(batonDir(root), 'teams.json');
}

export function teamId(name: string): string {
  return slugify(name, TEAM_ID_MAX);
}

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for tests)                                   */
/* ------------------------------------------------------------------ */

/**
 * Bound and normalise a requested project scope.
 *
 * Unknown ids are kept rather than rejected: the KB's project list changes when
 * someone adds a repo, and a scope that silently dropped the project you are
 * about to add would be a scope that quietly stopped matching. The dashboard
 * flags an id it does not recognise instead — a warning the owner can act on
 * beats a write the owner never sees.
 */
export function cleanProjectIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const id = v.trim().toLowerCase();
    if (!PROJECT_ID_RE.test(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_TEAM_PROJECTS) break;
  }
  return out;
}

export function cleanTeams(raw: unknown): Team[] {
  if (!raw || typeof raw !== 'object') return [];
  const r = raw as Partial<TeamRegistry>;
  if (r.version !== TEAMS_VERSION || !Array.isArray(r.teams)) return [];
  const out: Team[] = [];
  // The cap counts teams KEPT, not rows scanned: a duplicate or malformed row
  // must not consume a slot a real team behind it needed.
  for (const t of r.teams) {
    if (out.length >= MAX_TEAMS) break;
    const id = typeof t?.id === 'string' ? teamId(t.id) : '';
    // A duplicate id would make "which team is this member in" ambiguous, and
    // the answer would depend on array order. Last write does not win; first
    // one does, because that is the one existing members already point at.
    if (!id || out.some((e) => e.id === id)) continue;
    out.push({
      id,
      name: (typeof t.name === 'string' && t.name.trim() ? t.name.trim() : id).slice(0, TEAM_NAME_MAX),
      projects: cleanProjectIds(t.projects),
      createdAt: typeof t.createdAt === 'string' ? t.createdAt : new Date(0).toISOString(),
    });
  }
  return out;
}

export function findTeam(teams: Team[], id: string | null | undefined): Team | null {
  if (!id) return null;
  const want = teamId(id);
  return teams.find((t) => t.id === want) ?? null;
}

/**
 * Does this team's scope cover a claim on `projectId`?
 *
 * `null` is a single-repo hub, which every team covers — there is no other
 * project to be scoped away from. An empty scope covers everything.
 */
export function teamCovers(team: Team | null, projectId: string | null): boolean {
  if (!team || team.projects.length === 0) return true;
  if (projectId === null) return true;
  return team.projects.includes(projectId.toLowerCase());
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

export async function loadTeams(root: string): Promise<Team[]> {
  try {
    return cleanTeams(JSON.parse(await readFile(teamsPath(root), 'utf-8')));
  } catch {
    // Absent or corrupt ⇒ no teams, which is exactly how every hub starts. A
    // team file that failed to parse must not take the roster down with it.
    return [];
  }
}

export async function saveTeams(root: string, teams: Team[]): Promise<void> {
  const path = teamsPath(root);
  await mkdir(batonDir(root), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const reg: TeamRegistry = { version: TEAMS_VERSION, teams };
  await writeFile(tmp, `${JSON.stringify(reg, null, 2)}\n`);
  await rename(tmp, path);
}

export function addTeam(root: string, name: string, projects: unknown = []): Promise<Team> {
  // Like every mutator in src/members.ts: the whole load→mutate→save cycle
  // runs inside one lock, so two concurrent creates cannot erase each other.
  return withLock(teamsPath(root), async () => {
    const teams = await loadTeams(root);
    const display = name.trim().slice(0, TEAM_NAME_MAX);
    const id = teamId(display);
    if (!id) throw new TeamError(`'${name}' has no usable letters or digits for an id`);
    if (teams.some((t) => t.id === id)) throw new TeamError(`team '${id}' already exists`);
    if (teams.length >= MAX_TEAMS) throw new TeamError(`team cap reached (${MAX_TEAMS})`);

    const team: Team = {
      id,
      name: display,
      projects: cleanProjectIds(projects),
      createdAt: new Date().toISOString(),
    };
    await saveTeams(root, [...teams, team]);
    return team;
  });
}

/**
 * Rename a team or change its scope. The **id never moves**, even when the
 * display name does: members point at the id, so renaming a team by minting a
 * new id would silently empty it.
 */
export function updateTeam(
  root: string,
  idOrName: string,
  patch: { name?: string; projects?: unknown },
): Promise<Team> {
  return withLock(teamsPath(root), async () => {
    const teams = await loadTeams(root);
    const target = findTeam(teams, idOrName);
    if (!target) throw new TeamError(`no team '${idOrName}'`);
    if (typeof patch.name === 'string') {
      const display = patch.name.trim().slice(0, TEAM_NAME_MAX);
      if (!display) throw new TeamError('a team needs a name');
      target.name = display;
    }
    if (patch.projects !== undefined) target.projects = cleanProjectIds(patch.projects);
    await saveTeams(root, teams);
    return target;
  });
}

/**
 * Delete a team. Members pointing at it are NOT rewritten here — that is the
 * caller's job (`clearTeamAssignments` in src/members.ts), because the two
 * files are written separately and this one must not pretend otherwise. A
 * member left pointing at a deleted team reads as "no team", so the worst
 * outcome of the second write failing is a label that is already correct.
 */
export function removeTeam(root: string, idOrName: string): Promise<Team> {
  return withLock(teamsPath(root), async () => {
    const teams = await loadTeams(root);
    const target = findTeam(teams, idOrName);
    if (!target) throw new TeamError(`no team '${idOrName}'`);
    await saveTeams(root, teams.filter((t) => t.id !== target.id));
    return target;
  });
}
