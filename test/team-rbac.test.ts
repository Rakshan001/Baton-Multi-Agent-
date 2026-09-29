// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Team Sync §5.2 permission matrix, checked as pure functions of an org state.
 * (The fold decides *which* org state applies — the author's deps — and is
 * covered in team-fold.test.ts.)
 */
import { describe, it, expect } from 'vitest';
import {
  emptyOrg,
  grantVerdict,
  canAdmit,
  canRevokeDevice,
  canLead,
  canWork,
  canRead,
  canDefineProject,
  canAcceptSkill,
  custodianMembers,
  deviceRevokeVerdict,
  inRecovery,
  liveCustodianDevices,
} from '../src/team/rbac.js';
import type { OrgState, Role } from '../src/team/types.js';

const W = 'prj_web1';
const A = 'prj_api1';

function org(grants: Record<string, string[]>, revoked: string[] = []): OrgState {
  const o = emptyOrg();
  o.genesis = 'f'.repeat(64);
  for (const [member, roles] of Object.entries(grants)) {
    const device = (member + 'aaaaaaaaaaaaaaaa').slice(0, 16).replace(/[^a-z2-7]/g, 'a');
    o.devices[device] = {
      member, spki: 'x', label: '', model: '', admittedBy: 'f'.repeat(64),
      cutoffSeq: revoked.includes(member) ? 3 : null, inventory: [],
    };
    o.members[member] = { roles: [...roles].sort(), devices: [device], profile: null };
  }
  return o;
}

const dev = (m: string) => (m + 'aaaaaaaaaaaaaaaa').slice(0, 16).replace(/[^a-z2-7]/g, 'a');

const team = () => org({
  owner: ['*:custodian', '*:lead'],
  lead: [`${W}:lead`],
  devA: [`${W}:developer`],
  des: [`${W}:designer`],
  view: [`${W}:viewer`],
  relay: ['*:relay'],
});

describe('§5.2 matrix', () => {
  it('only custodians admit devices', () => {
    const o = team();
    expect(canAdmit(o, 'owner')).toBe(true);
    for (const m of ['lead', 'devA', 'des', 'view', 'relay']) expect(canAdmit(o, m)).toBe(false);
  });

  it('custodians revoke any device; others only themselves', () => {
    const o = team();
    expect(canRevokeDevice(o, dev('owner'), dev('lead'))).toBe(true);
    expect(canRevokeDevice(o, dev('lead'), dev('devA'))).toBe(false);
    expect(canRevokeDevice(o, dev('devA'), dev('devA'))).toBe(true);
  });

  it('a custodian grants any project role', () => {
    const o = team();
    for (const r of ['lead', 'developer', 'designer', 'viewer'] as Role[]) {
      expect(grantVerdict(o, 'owner', 'grant', 'devA', A, r)).toBe('allow');
    }
    expect(grantVerdict(o, 'owner', 'grant', 'relay', '*', 'relay')).toBe('allow');
  });

  it('a lead grants and revokes ≤ Developer, in its own projects only', () => {
    const o = team();
    expect(grantVerdict(o, 'lead', 'grant', 'devA', W, 'designer')).toBe('allow');
    expect(grantVerdict(o, 'lead', 'grant', 'view', W, 'developer')).toBe('allow');
    expect(grantVerdict(o, 'lead', 'revoke', 'devA', W, 'developer')).toBe('allow');
    expect(grantVerdict(o, 'lead', 'grant', 'devA', W, 'lead')).toBe('deny');
    expect(grantVerdict(o, 'lead', 'grant', 'devA', A, 'developer')).toBe('deny');
    expect(grantVerdict(o, 'lead', 'grant', 'devA', '*', 'developer')).toBe('deny');
    expect(grantVerdict(o, 'lead', 'revoke', 'owner', W, 'lead')).toBe('deny');
    expect(grantVerdict(o, 'lead', 'grant', 'devA', '*', 'custodian')).toBe('deny');
    expect(grantVerdict(o, 'lead', 'grant', 'devA', '*', 'relay')).toBe('deny');
  });

  it('developers, designers, viewers and relays grant nothing', () => {
    const o = team();
    for (const m of ['devA', 'des', 'view', 'relay']) {
      expect(grantVerdict(o, m, 'grant', 'view', W, 'viewer')).toBe('deny');
    }
  });

  it('custodian changes are direct with one custodian and need a quorum with two', () => {
    const one = team();
    expect(grantVerdict(one, 'owner', 'grant', 'lead', '*', 'custodian')).toBe('allow');
    const two = org({ owner: ['*:custodian'], sec: ['*:custodian'], lead: [`${W}:lead`] });
    expect(grantVerdict(two, 'owner', 'grant', 'lead', '*', 'custodian')).toBe('quorum');
    expect(grantVerdict(two, 'owner', 'revoke', 'sec', '*', 'custodian')).toBe('quorum');
    expect(grantVerdict(two, 'owner', 'grant', 'lead', W, 'custodian')).toBe('deny'); // team-wide only
  });

  it('project define/alias: custodian, or a lead of that project', () => {
    const o = team();
    expect(canDefineProject(o, 'owner', A)).toBe(true);
    expect(canDefineProject(o, 'lead', W)).toBe(true);
    expect(canDefineProject(o, 'lead', A)).toBe(false);
    expect(canDefineProject(o, 'devA', W)).toBe(false);
  });

  it('lead / work / read capabilities follow the matrix', () => {
    const o = team();
    expect(canLead(o, 'owner', A)).toBe(true);
    expect(canLead(o, 'lead', W)).toBe(true);
    expect(canLead(o, 'lead', A)).toBe(false);
    expect(canLead(o, 'devA', W)).toBe(false);
    expect(canWork(o, 'devA', W)).toBe(true);
    expect(canWork(o, 'des', W)).toBe(true);
    expect(canWork(o, 'view', W)).toBe(false);
    expect(canWork(o, 'relay', W)).toBe(false);
    expect(canWork(o, 'devA', A)).toBe(false);
    expect(canRead(o, 'view', W)).toBe(true);
    expect(canRead(o, 'view', A)).toBe(false);
    expect(canRead(o, 'relay', W)).toBe(false);
  });

  it('designer skill acceptance needs a lead co-approval', () => {
    const o = team();
    expect(canAcceptSkill(o, 'devA', W)).toBe('allow');
    expect(canAcceptSkill(o, 'des', W)).toBe('co-approval');
    expect(canAcceptSkill(o, 'view', W)).toBe('deny');
  });
});

describe('recovery mode (§5.4)', () => {
  it('no live custodian device ⇒ recovery mode; grants and admissions stop', () => {
    const o = org({ owner: ['*:custodian', '*:lead'], lead: [`${W}:lead`], devA: [`${W}:developer`] }, ['owner']);
    expect(liveCustodianDevices(o)).toEqual([]);
    expect(inRecovery(o)).toBe(true);
    expect(canAdmit(o, 'owner')).toBe(false);
    expect(grantVerdict(o, 'lead', 'grant', 'devA', W, 'designer')).toBe('deny');
    // work continues
    expect(canLead(o, 'lead', W)).toBe(true);
    expect(canWork(o, 'devA', W)).toBe(true);
  });
});

describe('custodian quorum is counted by role (security finding 4)', () => {
  it('revoking another custodian member\'s device needs a quorum once two custodians exist', () => {
    const two = org({ owner: ['*:custodian'], sec: ['*:custodian'], lead: [`${W}:lead`] });
    expect(deviceRevokeVerdict(two, dev('owner'), dev('sec'))).toBe('quorum');
    expect(canRevokeDevice(two, dev('owner'), dev('sec'))).toBe(false);
    expect(deviceRevokeVerdict(two, dev('owner'), dev('lead'))).toBe('allow');
    expect(deviceRevokeVerdict(two, dev('sec'), dev('sec'))).toBe('allow');
    expect(deviceRevokeVerdict(two, dev('lead'), dev('owner'))).toBe('deny');
    const one = team();
    expect(deviceRevokeVerdict(one, dev('owner'), dev('lead'))).toBe('allow');
  });

  it('a custodian whose devices are all revoked still counts toward the quorum', () => {
    const o = org({ owner: ['*:custodian'], sec: ['*:custodian'], lead: [`${W}:lead`] }, ['sec']);
    expect(liveCustodianDevices(o)).toEqual([dev('owner')]);
    expect(custodianMembers(o)).toEqual(['owner', 'sec']);
    expect(grantVerdict(o, 'owner', 'grant', 'lead', '*', 'custodian')).toBe('quorum');
    expect(grantVerdict(o, 'owner', 'revoke', 'sec', '*', 'custodian')).toBe('quorum');
  });
});
