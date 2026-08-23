// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `baton member add|list|revoke` — who may reach this daemon over a network.
 *
 * Only relevant once `baton serve --host` is used; a loopback-only daemon needs
 * no members and this registry stays empty.
 */
import { activeMembers, addMember, loadMembers, membersPath, revokeMember, type MemberRole } from '../members.js';
import { revokeIssuedKeysFor } from '../endpoints/enrollment.js';
import { activeBatonRoot } from '../store.js';
import { findTeam, loadTeams, teamId } from '../teams.js';

const age = (iso: string): string => {
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(d)) return '?';
  return d <= 0 ? 'today' : d === 1 ? '1d ago' : `${d}d ago`;
};

export async function memberAddCmd(name: string, opts: { role?: string; team?: string } = {}): Promise<void> {
  const root = await activeBatonRoot();
  const role: MemberRole | undefined = opts.role === 'owner' ? 'owner' : opts.role === 'member' ? 'member' : undefined;
  // Checked before the token is minted: a typo'd team would otherwise cost a
  // rotation to correct, since the token is shown exactly once.
  if (opts.team) {
    const wanted = teamId(opts.team);
    const teams = await loadTeams(root);
    if (!wanted || !findTeam(teams, wanted)) {
      const known = teams.map((t) => t.id).join(', ') || '(none yet — `baton team add "<name>"`)';
      throw new Error(`no team '${opts.team}' — existing teams: ${known}`);
    }
  }
  const { member, token } = await addMember(root, name, role, opts.team ? { team: opts.team } : {});

  console.log(`✓ ${member.name} (${member.id}) added as ${member.role}${member.team ? ` in ${member.team}` : ''}`);
  console.log('\n  Their token — shown ONCE, and only a hash is stored:\n');
  console.log(`      ${token}\n`);
  console.log('  They use it as:  Authorization: Bearer <token>');
  console.log('  Send it over a private channel; anyone holding it has this member\'s access.');
  console.log(`  Revoke any time:  baton member revoke ${member.id}`);
}

export async function memberListCmd(): Promise<void> {
  const root = await activeBatonRoot();
  const reg = await loadMembers(root);
  if (!reg.members.length) {
    console.log('No members. The daemon is loopback-only until you add one:');
    console.log('    baton member add "<your name>"');
    console.log(`  (registry would live at ${membersPath(root)})`);
    return;
  }
  const teams = await loadTeams(root);
  console.log('ID                    ROLE    STATUS    ADDED      TEAM');
  for (const m of reg.members) {
    const status = m.revokedAt ? 'revoked' : 'active';
    // A team that has since been deleted prints as nothing, matching the
    // dashboard: the pointer is stale, not the member.
    const team = findTeam(teams, m.team)?.id ?? '';
    console.log(`${m.id.padEnd(21)} ${m.role.padEnd(7)} ${status.padEnd(9)} ${age(m.createdAt).padEnd(10)} ${team}`);
  }
  console.log(`\n  ${activeMembers(reg).length} active. Tokens are stored hashed and cannot be re-displayed.`);
}

export async function memberRevokeCmd(idOrName: string): Promise<void> {
  const root = await activeBatonRoot();
  const m = await revokeMember(root, idOrName);
  console.log(`✓ ${m.id} revoked — their token stops working on the next request.`);

  // P18-E2 — the member token is only half of it. If this host issued them a
  // gateway credential, that credential keeps working until the gateway is told
  // otherwise, and nothing else in this flow tells it.
  const outcomes = await revokeIssuedKeysFor(root, m.id);
  for (const o of outcomes) {
    console.log(o.revoked
      ? `  ✓ their credential for '${o.endpointId}' was revoked at the gateway`
      // Never printed as done when it is not: an admin who reads "revoked" over
      // a failed call believes a leaver is locked out when they are not.
      : `  ! could NOT revoke their credential for '${o.endpointId}' — it may still work. Retry, or revoke key ${o.keyId} in the gateway's own UI.`);
  }
  console.log('  Note: this blocks FUTURE access only. Anything already cloned or read stays on their machine.');
}
