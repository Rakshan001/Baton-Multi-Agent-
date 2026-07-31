/**
 * Member registry — the identities allowed to reach this daemon over a network.
 *
 * Until now the ONLY access control was "the connection came from 127.0.0.1".
 * That is a perfectly good gate for a local-first tool and it stays the primary
 * one; this module exists solely so a daemon deliberately exposed with `--host`
 * has something better than "whoever can route to the port".
 *
 * Design notes that matter for review:
 *
 * - **The token is shown exactly once, at mint.** Only a SHA-256 of it is
 *   persisted, so a stolen `members.json` yields no working credential.
 * - **SHA-256, not bcrypt/scrypt/argon2, is deliberate.** Slow KDFs exist to
 *   make *low-entropy human-chosen* secrets expensive to guess. These tokens are
 *   32 bytes from `randomBytes` — 256 bits — so brute force is infeasible
 *   regardless of hash speed, and a slow KDF would only add a dependency (the
 *   daemon is zero-dependency by convention) and a per-request cost that is
 *   itself a DoS lever. Comparison is `timingSafeEqual`.
 * - **Roles are enforced server-side.** A hidden button in the dashboard is not
 *   a control; client code is untrusted.
 * - **Authorship (`src/identity.ts`) is NOT authentication.** That field is a
 *   self-declared label. THIS is the thing that decides who may act.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { batonDir } from './store.js';
import { slugify } from './util/slug.js';
import { teamId } from './teams.js';

export const MEMBERS_VERSION = 1;

/** 32 bytes of CSPRNG output. The `baton_` prefix makes a leaked token greppable
 *  (and recognisable to secret scanners) without revealing anything. */
const TOKEN_BYTES = 32;
const TOKEN_RE = /^baton_[0-9a-f]{64}$/;

const MAX_MEMBERS = 100;
const NAME_MAX = 60;
const ID_MAX = 40;

export type MemberRole = 'owner' | 'member';

export interface Member {
  id: string;
  name: string;
  role: MemberRole;
  /** SHA-256 hex of the token. The token itself is never stored. */
  tokenHash: string;
  createdAt: string;
  /** Set on revoke. Revoked members are kept so the audit trail survives. */
  revokedAt?: string;
  /**
   * Deadline for the FIRST use of this token. An invite travels through
   * whatever channel someone happens to use — chat, email, a screenshot — so an
   * un-redeemed one should stop being a key eventually. Cleared on first use:
   * once a member is actually working, expiring their credential mid-session
   * would be a hazard, not a safeguard.
   */
  expiresAt?: string;
  /** Set the first time this token authenticates anything. */
  firstUsedAt?: string;
  /**
   * Team id (src/teams.ts), or absent for "no team".
   *
   * A LABEL, exactly like `name`. Nothing authorizes on it and `decideAccess`
   * never reads it — see the header of src/teams.ts for why that line is drawn
   * where it is. Kept here rather than in teams.json so a member has exactly
   * one home; a team that has since been deleted reads as no team.
   */
  team?: string;
}

export interface MemberRegistry {
  version: number;
  members: Member[];
}

export class MemberError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemberError';
  }
}

export function membersPath(root: string): string {
  return join(batonDir(root), 'members.json');
}

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for tests)                                   */
/* ------------------------------------------------------------------ */

export function mintToken(): string {
  return `baton_${randomBytes(TOKEN_BYTES).toString('hex')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf-8').digest('hex');
}

/** Slug id from a display name; `''` when nothing usable survives. */
export function memberId(name: string): string {
  return slugify(name, ID_MAX);
}

/**
 * Pull a bearer token out of an Authorization header. Returns '' for anything
 * that is not exactly `Bearer <token>` — no cookie fallback and no query-string
 * fallback, because both leak credentials into logs and Referer headers.
 */
export function bearerFrom(authorization: string | undefined | null): string {
  if (!authorization) return '';
  const m = /^Bearer[ \t]+([A-Za-z0-9_-]+)[ \t]*$/.exec(authorization);
  return m ? m[1] : '';
}

export const EMPTY_REGISTRY = (): MemberRegistry => ({ version: MEMBERS_VERSION, members: [] });

export function cleanRegistry(raw: unknown): MemberRegistry {
  if (!raw || typeof raw !== 'object') return EMPTY_REGISTRY();
  const r = raw as Partial<MemberRegistry>;
  if (r.version !== MEMBERS_VERSION || !Array.isArray(r.members)) return EMPTY_REGISTRY();
  const members: Member[] = [];
  for (const m of r.members.slice(0, MAX_MEMBERS)) {
    const id = typeof m?.id === 'string' ? memberId(m.id) : '';
    const tokenHash = typeof m?.tokenHash === 'string' ? m.tokenHash.trim().toLowerCase() : '';
    // A malformed hash can never match a presented token, but dropping it here
    // keeps the verify loop free of entries that can only ever be dead weight.
    if (!id || !/^[0-9a-f]{64}$/.test(tokenHash)) continue;
    members.push({
      id,
      name: (typeof m.name === 'string' ? m.name : id).slice(0, NAME_MAX),
      role: m.role === 'owner' ? 'owner' : 'member',
      tokenHash,
      createdAt: typeof m.createdAt === 'string' ? m.createdAt : new Date(0).toISOString(),
      ...(typeof m.revokedAt === 'string' ? { revokedAt: m.revokedAt } : {}),
      ...(typeof m.expiresAt === 'string' ? { expiresAt: m.expiresAt } : {}),
      ...(typeof m.firstUsedAt === 'string' ? { firstUsedAt: m.firstUsedAt } : {}),
      // Re-slugged, not trusted: this value is rendered as a group heading and
      // used as a lookup key. Existence of the team is NOT checked here —
      // teams.json is a separate file, so a pointer at a deleted team resolves
      // to "no team" at read time rather than being repaired on every load.
      ...(typeof m.team === 'string' && teamId(m.team) ? { team: teamId(m.team) } : {}),
    });
  }
  return { version: MEMBERS_VERSION, members };
}

export function activeMembers(reg: MemberRegistry): Member[] {
  return reg.members.filter((m) => !m.revokedAt);
}

/** True when at least one usable credential exists — the `--host` precondition. */
export function hasActiveMembers(reg: MemberRegistry): boolean {
  return activeMembers(reg).length > 0;
}

/**
 * The member a presented token belongs to, or null.
 *
 * Deliberately does NOT return early on a match: the loop does the same work
 * whichever entry matches, so response time carries no information about where
 * in the registry a token sits. Revoked members are skipped, so revocation takes
 * effect on the very next request with no session to invalidate.
 */
/**
 * An invite that was never redeemed and whose deadline has passed.
 *
 * Once `firstUsedAt` is set the deadline stops applying: expiry exists to limit
 * how long a credential sitting in someone's chat history stays live, not to
 * cut off a member who is in the middle of working.
 */
export function isExpiredInvite(m: Member, now = Date.now()): boolean {
  if (!m.expiresAt || m.firstUsedAt) return false;
  const t = Date.parse(m.expiresAt);
  return Number.isFinite(t) && now > t;
}

export function verifyToken(reg: MemberRegistry, token: string, now = Date.now()): Member | null {
  if (!TOKEN_RE.test(token)) return null;
  const presented = Buffer.from(hashToken(token), 'hex');
  let found: Member | null = null;
  for (const m of reg.members) {
    if (m.revokedAt) continue;
    const stored = Buffer.from(m.tokenHash, 'hex');
    if (stored.length !== presented.length) continue;
    if (timingSafeEqual(stored, presented)) found = m;
  }
  // Checked AFTER the loop, on the matched member only. Doing it inside would
  // vary the work per entry and hand back the timing signal the loop is shaped
  // to avoid; out here it can only tell a caller something about the token they
  // already hold.
  if (found && isExpiredInvite(found, now)) return null;
  return found;
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

export async function loadMembers(root: string): Promise<MemberRegistry> {
  try {
    return cleanRegistry(JSON.parse(await readFile(membersPath(root), 'utf-8')));
  } catch {
    return EMPTY_REGISTRY(); // absent or corrupt → nobody is authorized
  }
}

/** Atomic write at 0600 — the hashes are not secrets, but the file is not public either. */
export async function saveMembers(root: string, reg: MemberRegistry): Promise<void> {
  const path = membersPath(root);
  await mkdir(batonDir(root), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(reg, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export interface AddedMember {
  member: Member;
  /** Shown once by the caller, then unrecoverable. */
  token: string;
}

/**
 * Add a member and mint their token. The FIRST member of an empty registry
 * becomes `owner` regardless of what was asked for — a registry with no owner
 * could never manage itself.
 */
export async function addMember(
  root: string,
  name: string,
  role?: MemberRole,
  opts: { expiresInMs?: number; team?: string } = {},
): Promise<AddedMember> {
  const reg = await loadMembers(root);
  const display = name.trim().slice(0, NAME_MAX);
  const id = memberId(display);
  if (!id) throw new MemberError(`'${name}' has no usable letters or digits for an id`);
  if (reg.members.some((m) => m.id === id && !m.revokedAt)) {
    throw new MemberError(`member '${id}' already exists — revoke them first, or pick another name`);
  }
  if (activeMembers(reg).length >= MAX_MEMBERS) throw new MemberError(`member cap reached (${MAX_MEMBERS})`);

  const token = mintToken();
  const now = Date.now();
  const member: Member = {
    id,
    name: display,
    role: reg.members.length === 0 ? 'owner' : (role ?? 'member'),
    tokenHash: hashToken(token),
    createdAt: new Date(now).toISOString(),
    ...(opts.expiresInMs ? { expiresAt: new Date(now + opts.expiresInMs).toISOString() } : {}),
    ...(opts.team && teamId(opts.team) ? { team: teamId(opts.team) } : {}),
  };
  // A re-added id replaces its revoked tombstone rather than accumulating them.
  reg.members = [...reg.members.filter((m) => m.id !== id), member];
  await saveMembers(root, reg);
  return { member, token };
}

/**
 * Mint a fresh token for an existing member, invalidating the old one.
 *
 * The reissue path for a leaked or lost invite. It is deliberately a REPLACE
 * rather than an additional credential: two live tokens for one identity means
 * revoking the leaked one is guesswork.
 */
export async function rotateMember(
  root: string,
  idOrName: string,
  opts: { expiresInMs?: number } = {},
): Promise<AddedMember> {
  const reg = await loadMembers(root);
  const id = memberId(idOrName);
  const target = reg.members.find((m) => m.id === id && !m.revokedAt);
  if (!target) throw new MemberError(`no active member '${idOrName}'`);

  const token = mintToken();
  const now = Date.now();
  target.tokenHash = hashToken(token);
  // Back to being an un-redeemed invite: a rotated token has never been used,
  // so the same deadline that protects a fresh one should protect this one.
  delete target.firstUsedAt;
  if (opts.expiresInMs) target.expiresAt = new Date(now + opts.expiresInMs).toISOString();
  else delete target.expiresAt;
  await saveMembers(root, reg);
  return { member: target, token };
}

/**
 * Record that a token has been redeemed, which stops its invite deadline
 * applying. Returns false when there was nothing to change, so the caller can
 * skip the write on the overwhelmingly common already-used path.
 */
export async function markTokenUsed(root: string, id: string): Promise<boolean> {
  const reg = await loadMembers(root);
  const target = reg.members.find((m) => m.id === id && !m.revokedAt);
  if (!target || target.firstUsedAt) return false;
  target.firstUsedAt = new Date().toISOString();
  await saveMembers(root, reg);
  return true;
}

/**
 * Revoke a member's token. Refuses to remove the last active owner: a hub with
 * no owner can never add a member or revoke anyone again, which is a
 * self-inflicted lockout rather than a security improvement.
 */
export async function revokeMember(root: string, idOrName: string): Promise<Member> {
  const reg = await loadMembers(root);
  const id = memberId(idOrName);
  const target = reg.members.find((m) => m.id === id && !m.revokedAt);
  if (!target) throw new MemberError(`no active member '${idOrName}'`);
  const owners = activeMembers(reg).filter((m) => m.role === 'owner');
  if (target.role === 'owner' && owners.length === 1) {
    throw new MemberError(`'${target.id}' is the only owner — promote someone else before revoking them`);
  }
  target.revokedAt = new Date().toISOString();
  await saveMembers(root, reg);
  return target;
}

/* ------------------------------------------------------------------ */
/* Team membership                                                     */
/*                                                                     */
/* The team itself lives in src/teams.ts; only the pointer lives here. */
/* These two functions exist so that the `team` field is written in    */
/* exactly one place, and so removing a team is one registry write     */
/* rather than one per affected member.                                */
/* ------------------------------------------------------------------ */

/**
 * Put a member in a team, or take them out of one with `null`.
 *
 * Does not verify the team exists — the caller holds teams.json and can say
 * something better than this module could. A member is in at most one team;
 * assigning replaces, so there is no "remove from team X" to get wrong.
 */
export async function setMemberTeam(root: string, idOrName: string, team: string | null): Promise<Member> {
  const reg = await loadMembers(root);
  const id = memberId(idOrName);
  const target = reg.members.find((m) => m.id === id && !m.revokedAt);
  if (!target) throw new MemberError(`no active member '${idOrName}'`);
  const next = team ? teamId(team) : '';
  if (team && !next) throw new MemberError(`'${team}' is not a usable team id`);
  if (next) target.team = next;
  else delete target.team;
  await saveMembers(root, reg);
  return target;
}

/** Take every member out of a team — the second half of deleting one.
 *  Returns how many rows changed so the caller can report it honestly. */
export async function clearTeamAssignments(root: string, team: string): Promise<number> {
  const reg = await loadMembers(root);
  const id = teamId(team);
  let changed = 0;
  for (const m of reg.members) {
    if (m.team !== id) continue;
    delete m.team;
    changed++;
  }
  if (changed) await saveMembers(root, reg);
  return changed;
}
