// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Team Sync RBAC (docs/system-design/team-sync/README.md §5.2 matrix, §5.4).
 *
 * Pure predicates over an `OrgState`. Which org state applies is the fold's job:
 * authority is always judged at the author's deps (§5.3), never at "now".
 *
 * Roles are stored per member as `"<project|*>:<role>"`. Custodian and Relay are
 * team-wide (`*` only); the rest are per project, with `*` meaning every project.
 */
import { BELOW_LEAD, TEAM_ROLES, type OrgState, type Role } from './types.js';

export function emptyOrg(): OrgState {
  return { genesis: null, recoveryPub: null, recoveryEpoch: 0, devices: {}, members: {}, projects: {}, proposals: {} };
}

export function hasRole(org: OrgState, member: string, project: string, role: Role): boolean {
  const roles = org.members[member]?.roles;
  if (!roles) return false;
  return roles.includes(`*:${role}`) || (project !== '*' && roles.includes(`${project}:${role}`));
}

export function isCustodian(org: OrgState, member: string): boolean {
  return hasRole(org, member, '*', 'custodian');
}

/** Admitted and not revoked. */
export function isLiveDevice(org: OrgState, device: string): boolean {
  const d = org.devices[device];
  return !!d && d.cutoffSeq === null;
}

export function liveCustodianDevices(org: OrgState): string[] {
  return Object.keys(org.devices)
    .filter((id) => isLiveDevice(org, id) && isCustodian(org, org.devices[id].member))
    .sort();
}

export function liveCustodianMembers(org: OrgState): string[] {
  return [...new Set(liveCustodianDevices(org).map((id) => org.devices[id].member))].sort();
}

/**
 * Members holding Custodian by ROLE, live devices or not. Quorum is decided on
 * this count: revoking a custodian's devices must not be a way to shrink the
 * quorum (a custodian with no live device still has to consent, or be demoted
 * by quorum first).
 */
export function custodianMembers(org: OrgState): string[] {
  return Object.keys(org.members)
    .filter((m) => isCustodian(org, m))
    .sort();
}

/** §5.4: the team has a genesis but no live custodian device. */
export function inRecovery(org: OrgState): boolean {
  return org.genesis !== null && liveCustodianDevices(org).length === 0;
}

/** Custodian, or Lead of the project (or of `*`). Assign, remind, review, merge, push.request. */
export function canLead(org: OrgState, member: string, project: string): boolean {
  return isCustodian(org, member) || hasRole(org, member, project, 'lead');
}

/** May hold and move work in the project: acknowledge, take, transition (as assignee). */
export function canWork(org: OrgState, member: string, project: string): boolean {
  return (
    canLead(org, member, project) ||
    hasRole(org, member, project, 'developer') ||
    hasRole(org, member, project, 'designer')
  );
}

/** May read the project's events and blobs in the clear (a Relay only stores ciphertext, §13.3). */
export function canRead(org: OrgState, member: string, project: string): boolean {
  return canWork(org, member, project) || hasRole(org, member, project, 'viewer');
}

export function canAdmit(org: OrgState, member: string): boolean {
  return isCustodian(org, member) && !inRecovery(org);
}

/**
 * May `actorDevice` revoke `target`?
 * - any device may revoke itself, and a member its own other devices;
 * - otherwise only a Custodian;
 * - a device of ANOTHER custodian member, while the team has ≥ 2 custodian
 *   members by role, is a custodian change: `quorum` (demote the member with
 *   role.proposal + role.cosign first). The fold allows the one exception, the
 *   concurrent mutual revoke (§5.4), which only removes liveness.
 */
export function deviceRevokeVerdict(org: OrgState, actorDevice: string, target: string): GrantVerdict {
  if (actorDevice === target) return 'allow';
  const actor = org.devices[actorDevice];
  if (!actor) return 'deny';
  const t = org.devices[target];
  if (t && t.member === actor.member) return 'allow';
  if (!isCustodian(org, actor.member)) return 'deny';
  if (t && isCustodian(org, t.member) && custodianMembers(org).length >= 2) return 'quorum';
  return 'allow';
}

/** `deviceRevokeVerdict` is `allow` (no quorum needed). */
export function canRevokeDevice(org: OrgState, actorDevice: string, target: string): boolean {
  return deviceRevokeVerdict(org, actorDevice, target) === 'allow';
}

/** `project.define` / `project.alias` / `project.rekey`: Custodian, or Lead of that project. */
export function canDefineProject(org: OrgState, member: string, project: string): boolean {
  return canLead(org, member, project);
}

/** Spec C / §5.2: Designers need a Lead co-approval to accept a skill. */
export function canAcceptSkill(org: OrgState, member: string, project: string): 'allow' | 'co-approval' | 'deny' {
  if (canLead(org, member, project) || hasRole(org, member, project, 'developer')) return 'allow';
  if (hasRole(org, member, project, 'designer')) return 'co-approval';
  return 'deny';
}

export type GrantVerdict = 'allow' | 'deny' | 'quorum';

/**
 * May `actor` grant/revoke `role` on `project` for `member`?
 * - Custodian role: team-wide only; direct while ≤ 1 custodian member (by
 *   role, not by live devices — see `custodianMembers`), otherwise `quorum`
 *   (role.proposal + role.cosign by another custodian). The last custodian
 *   can't be revoked.
 * - Relay: team-wide, custodians only.
 * - Lead/Developer/Designer/Viewer: custodians anywhere; a Lead only ≤ Developer
 *   and only where it is Lead (a `*` grant needs Lead on `*`).
 * - Nothing is granted or revoked in recovery mode.
 */
export function grantVerdict(
  org: OrgState,
  actor: string,
  op: 'grant' | 'revoke',
  member: string,
  project: string,
  role: Role,
): GrantVerdict {
  if (inRecovery(org)) return 'deny';
  if (TEAM_ROLES.includes(role) && project !== '*') return 'deny';
  if (!org.members[member]) return 'deny';
  const custodian = isCustodian(org, actor);
  if (role === 'custodian') {
    if (!custodian) return 'deny';
    const count = custodianMembers(org).length;
    // Never revoke the last custodian: that would be an owner-less team outside recovery.
    if (op === 'revoke' && count < 2) return 'deny';
    return count >= 2 ? 'quorum' : 'allow';
  }
  if (custodian) return 'allow';
  if (role === 'relay' || role === 'lead') return 'deny';
  if (!BELOW_LEAD.includes(role)) return 'deny';
  return hasRole(org, actor, project, 'lead') ? 'allow' : 'deny';
}
