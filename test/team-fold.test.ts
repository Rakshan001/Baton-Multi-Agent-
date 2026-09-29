// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The deterministic Team Sync fold (§5, §7, §9) and the §15 invariants 1–5.
 *
 * Property tests are hand-rolled (seeded PRNG + shuffles, no dependencies): the
 * same set of events in any delivery order must fold to byte-identical state,
 * including forks, revokes, mutual revokes and concurrent task conflicts.
 */
import { describe, it, expect } from 'vitest';
import { fold, stateHash, sortTasks } from '../src/team/fold.js';
import { canonicalize } from '../src/team/canonical.js';
import { makeForkProof, decodeEvent, type TeamEvent } from '../src/team/envelope.js';
import type { TeamState } from '../src/team/types.js';
import {
  Dev, World, admitBody, genesis, keypair, recoveryBody, rng, shuffle, standardTeam, sync, PRJ, PRJ2,
} from './team-helpers.js';

const F = (w: World, extra: { lines?: string[] } = {}) => fold({ team: w.team, lines: extra.lines ?? w.lineSet() });
const note = (s: TeamState, hash: string) =>
  s.unauthorized.find((n) => n.hash === hash)?.reason ?? s.rejected.find((n) => n.hash === hash)?.reason;

/** A revoke body cutting `d` off after its current head (seq 0 if it has authored nothing). */
const cut = (d: Dev) => ({ device: d.device, cutoffSeq: d.head?.seq ?? 0, cutoffHash: d.head?.hash ?? null });

async function newTask(lead: Dev, fields: Record<string, unknown> = {}) {
  const id = `${lead.device}-${lead.seq + 1}`;
  const hash = await lead.emit('task.upsert', { task: id, fields: { title: 'Admin table', project: PRJ, ...fields } });
  return { id, hash };
}

describe('org chain', () => {
  it('genesis, admits, roles and projects fold into the org view', async () => {
    const { w, owner, sec, lead, relay } = await standardTeam();
    const s = F(w);
    expect(s.team).toBe(w.team);
    expect(s.org.members.owner.roles).toEqual(['*:custodian', '*:lead']);
    expect(s.org.members.lead.roles).toEqual([`${PRJ}:lead`]);
    expect(s.org.devices[relay.device].member).toBe('relay');
    expect(s.org.custodians).toEqual([owner.device, sec.device].sort());
    expect(s.org.recoveryMode).toBe(false);
    expect(Object.keys(s.org.projects).sort()).toEqual([PRJ2, PRJ].sort());
    expect(s.unauthorized).toEqual([]);
    expect(s.rejected).toEqual([]);
    expect(s.pending).toEqual([]);
    expect(lead.device in s.org.devices).toBe(true);
  });

  it('a device.admit whose device is not id(spki) is ignored (invariant 6)', async () => {
    const { w, owner } = await standardTeam();
    const k = keypair();
    const other = keypair();
    const h = await owner.emit('device.admit', { device: k.device, spki: other.spki, member: 'x', label: 'x', model: 'x', sas: 'x' });
    const s = F(w);
    expect(k.device in s.org.devices).toBe(false);
    expect(note(s, h)).toBeDefined();
  });

  it('authority is judged at the author\'s deps, not the reader\'s now (§5.3)', async () => {
    const w = new World();
    const owner = new Dev(w, 'owner');
    const lead = new Dev(w, 'lead');
    const devA = new Dev(w, 'deva');
    await genesis(w, owner);
    await owner.emit('device.admit', admitBody(lead));
    await owner.emit('device.admit', admitBody(devA));
    await owner.emit('project.define', { key: PRJ, name: 'web', remotes: [], rootCommits: [] });
    sync(owner, lead, devA);
    // Owner grants lead AFTER lead has synced; lead acts before seeing the grant.
    await owner.emit('role.grant', { member: 'lead', project: PRJ, role: 'lead' });
    const early = await lead.emit('role.grant', { member: 'deva', project: PRJ, role: 'developer' });
    sync(owner, lead);
    const late = await lead.emit('role.grant', { member: 'deva', project: PRJ, role: 'designer' });
    const s = F(w);
    expect(note(s, early)).toBeDefined();
    expect(note(s, late)).toBeUndefined();
    expect(s.org.members.deva.roles).toEqual([`${PRJ}:designer`]);
  });

  it('a device must have seen its own admission', async () => {
    const w = new World();
    const owner = new Dev(w, 'owner');
    const d = new Dev(w, 'd');
    await genesis(w, owner);
    await owner.emit('device.admit', admitBody(d));
    const blind = await d.emit('member.profile', { name: 'D', jobRole: 'Web', timezone: 'UTC' });
    const s = F(w);
    expect(note(s, blind)).toBeDefined();
    expect(s.org.members.d.profile).toBeNull();
  });

  it('leads cannot promote to lead or touch custodians', async () => {
    const { w, lead } = await standardTeam();
    const a = await lead.emit('role.grant', { member: 'dev', project: PRJ, role: 'lead' });
    const b = await lead.emit('role.revoke', { member: 'owner', project: '*', role: 'lead' });
    const c = await lead.emit('role.grant', { member: 'dev', project: PRJ2, role: 'developer' });
    const s = F(w);
    for (const h of [a, b, c]) expect(note(s, h)).toBeDefined();
  });

  it('custodian changes need a quorum once two custodians exist (§5.4)', async () => {
    const { w, owner, sec, lead, all } = await standardTeam();
    const direct = await owner.emit('role.grant', { member: 'lead', project: '*', role: 'custodian' });
    const prop = await owner.emit('role.proposal', { action: 'grant', member: 'lead', role: 'custodian' });
    const selfCosign = await owner.emit('role.cosign', { proposal: prop });
    let s = F(w);
    expect(note(s, direct)).toBeDefined();
    expect(note(s, selfCosign)).toBeDefined();
    expect(s.org.members.lead.roles).not.toContain('*:custodian');
    sync(...all);
    await sec.emit('role.cosign', { proposal: prop });
    s = F(w);
    expect(s.org.members.lead.roles).toContain('*:custodian');
    expect(s.org.custodians).toContain(lead.device);
  });
});

describe('strong removal (§5.4, invariant 2)', () => {
  it('voids events past cutoffSeq and everything they authorised, transitively', async () => {
    const { w, owner, sec, lead, dev, all } = await standardTeam();
    // sec is a custodian: revoking its device is a custodian change, so it is first
    // demoted by quorum. That needs a third custodian (lead), promoted with sec's cosign.
    const promote = await owner.emit('role.proposal', { action: 'grant', member: 'lead', role: 'custodian' });
    sync(...all);
    await sec.emit('role.cosign', { proposal: promote });
    sync(...all);
    const trusted = await dev.emit('member.profile', { name: 'Dev', jobRole: 'Web', timezone: 'UTC' });
    // sec (custodian) admits a new device, which then acts; then sec's device is revoked
    // with a cutoff BEFORE that admit — the admit, and the new device's events, are void.
    const cutoff = cut(sec);
    const x = new Dev(w, 'xmember');
    const admitX = await sec.emit('device.admit', admitBody(x));
    const grantX = await sec.emit('role.grant', { member: 'xmember', project: PRJ, role: 'lead' });
    sync(sec, x);
    const xAct = await x.emit('member.profile', { name: 'X', jobRole: 'Web', timezone: 'UTC' });
    const late = await dev.emit('member.profile', { name: 'Dev2', jobRole: 'Web', timezone: 'UTC' });
    sync(...all, x);
    const demote = await owner.emit('role.proposal', { action: 'revoke', member: 'sec', role: 'custodian' });
    sync(owner, lead);
    await lead.emit('role.cosign', { proposal: demote });
    sync(owner, lead);
    await owner.emit('device.revoke', cutoff);
    const devCut = { seq: dev.seq - 1, hash: trusted };
    await owner.emit('device.revoke', { device: dev.device, cutoffSeq: devCut.seq, cutoffHash: devCut.hash });
    const s = F(w);
    expect(s.voided).toEqual(expect.arrayContaining([admitX, grantX, late]));
    expect(x.device in s.org.devices).toBe(false);
    expect(s.org.members.xmember).toBeUndefined();
    expect(note(s, xAct)).toBeDefined(); // not admitted once the admit is void
    expect(s.org.members.dev.profile?.name).toBe('Dev');
    expect(s.org.devices[sec.device].cutoffSeq).toBe(cutoff.cutoffSeq);
    expect(s.org.custodians).toEqual([owner.device, lead.device].sort());
    expect(s.unauthorized.map((u) => u.hash)).toEqual([xAct]); // the quorum steps all took effect
  });

  it('voids by feed position whatever the lamport or deps (a backdated event cannot slip in)', async () => {
    const { w, owner, dev, lead, all } = await standardTeam();
    const c = cut(dev);
    // dev authors while partitioned: it never sees the revoke, so its deps are "old".
    const { id } = await newTask(lead, {});
    sync(lead, dev);
    const offline = await dev.emit('task.take', { task: id, device: dev.device });
    await owner.emit('device.revoke', c);
    sync(...all);
    const s = F(w);
    expect(s.voided).toContain(offline);
    expect(s.tasks[id].lifecycle.holder).toBeNull();
  });

  it('device.revoke.amend accepts a removed member\'s specific pending work', async () => {
    const { w, owner, dev, lead, all } = await standardTeam();
    const c = cut(dev);
    const keep = await dev.emit('member.profile', { name: 'Keep', jobRole: 'Web', timezone: 'UTC' });
    sync(...all);
    await owner.emit('device.revoke', c);
    let s = F(w);
    expect(s.voided).toContain(keep);
    await owner.emit('device.revoke.amend', { device: dev.device, events: [keep] });
    s = F(w);
    expect(s.voided).not.toContain(keep);
    expect(s.org.members.dev.profile?.name).toBe('Keep');
    void lead;
  });

  it('a revoke with a cutoffHash that does not match the feed is not honoured', async () => {
    const { w, owner, dev } = await standardTeam();
    const h = await owner.emit('device.revoke', { device: dev.device, cutoffSeq: dev.seq, cutoffHash: 'e'.repeat(64) });
    const s = F(w);
    expect(note(s, h)).toBeDefined();
    expect(s.org.devices[dev.device].cutoffSeq).toBeNull();
  });
});

describe('mutual custodian revocation ⇒ recovery mode (§5.4, invariant 4)', () => {
  async function mutual() {
    const t = await standardTeam();
    const { owner, sec } = t;
    const ownerCut = cut(owner);
    const secCut = cut(sec);
    // concurrent: neither has seen the other's revoke
    const r1 = await owner.emit('device.revoke', secCut);
    const r2 = await sec.emit('device.revoke', ownerCut);
    sync(...t.all);
    return { ...t, r1, r2 };
  }

  it('both revokes apply and the team enters recovery mode', async () => {
    const { w, owner, sec } = await mutual();
    const s = F(w);
    expect(s.org.devices[owner.device].cutoffSeq).not.toBeNull();
    expect(s.org.devices[sec.device].cutoffSeq).not.toBeNull();
    expect(s.org.custodians).toEqual([]);
    expect(s.org.recoveryMode).toBe(true);
  });

  it('in recovery, grants and admissions are refused but work continues', async () => {
    const { w, lead, dev } = await mutual();
    const g = await lead.emit('role.grant', { member: 'dev', project: PRJ, role: 'designer' });
    const { id } = await newTask(lead);
    sync(lead, dev);
    await dev.emit('task.take', { task: id, device: dev.device });
    const s = F(w);
    expect(note(s, g)).toBeDefined();
    expect(s.tasks[id].lifecycle.state).toBe('active');
  });

  it('only the recovery key can restore custodians; replays of an old epoch are ignored', async () => {
    const t = await mutual();
    const { w, lead, all } = t;
    const fresh = new Dev(w, 'owner');
    const forged = recoveryBody(w, 1, [fresh]);
    const bad = await lead.emit('recovery.restore', { ...forged, recoverySig: forged.recoverySig.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) });
    let s = F(w);
    expect(note(s, bad)).toBeDefined();
    expect(s.org.recoveryMode).toBe(true);
    await lead.emit('recovery.restore', recoveryBody(w, 1, [fresh]));
    s = F(w);
    expect(s.org.recoveryMode).toBe(false);
    expect(s.org.custodians).toEqual([fresh.device]);
    sync(...all, fresh);
    const replay = await lead.emit('recovery.restore', recoveryBody(w, 1, [new Dev(w, 'mallory')]));
    s = F(w);
    expect(note(s, replay)).toBeDefined();
  });
});

describe('tasks (§7)', () => {
  it('task.upsert creates <device>-<seq> ids and applies per-field LWW patches', async () => {
    const { w, owner, lead, all } = await standardTeam();
    const { id } = await newTask(lead, { priority: 1 });
    sync(...all);
    // concurrent: two leads edit different fields — both land
    await lead.emit('task.upsert', { task: id, fields: { title: 'Admin table v2' } });
    await owner.emit('task.upsert', { task: id, fields: { priority: 0, urgent: true } });
    let s = F(w);
    expect(s.tasks[id]).toMatchObject({ title: 'Admin table v2', priority: 0, urgent: true, project: PRJ, briefRev: 0 });
    // concurrent same-field edits: higher (lamport, device) wins, deterministically
    sync(...all);
    await lead.emit('task.upsert', { task: id, fields: { title: 'L' } });
    await owner.emit('task.upsert', { task: id, fields: { title: 'O' } });
    s = F(w);
    expect(['L', 'O']).toContain(s.tasks[id].title);
    const winner = lead.device > owner.device ? 'L' : 'O';
    expect(s.tasks[id].title).toBe(winner);
    await lead.emit('task.upsert', { task: id, fields: { brief: { goal: 'x', inScope: ['a'], acceptance: ['b'] } } });
    expect(F(w).tasks[id].briefRev).toBe(1);
  });

  it('a mismatched task id or an unknown project is refused', async () => {
    const { w, lead } = await standardTeam();
    const a = await lead.emit('task.upsert', { task: 'aaaaaaaaaaaaaaaa-1', fields: { title: 'x', project: PRJ } });
    const b = await lead.emit('task.upsert', { task: `${lead.device}-${lead.seq + 1}`, fields: { title: 'x', project: 'prj_nope' } });
    const c = await lead.emit('task.upsert', { task: `${lead.device}-${lead.seq + 1}`, fields: { title: 'x', project: PRJ2 } });
    const s = F(w);
    for (const h of [a, b, c]) expect(note(s, h)).toBeDefined();
    expect(Object.keys(s.tasks)).toEqual([]);
  });

  it('runs the full lifecycle: assign → ack → take → review → changes → review → approve → push → merged → done', async () => {
    const { w, lead, dev, all } = await standardTeam();
    const { id } = await newTask(lead);
    await lead.emit('task.assign', { task: id, member: 'dev', agent: 'claude' });
    sync(...all);
    expect(F(w).tasks[id].lifecycle).toMatchObject({ state: 'assigned', assignee: 'dev', acked: false });
    await dev.emit('task.ack', { task: id });
    expect(F(w).tasks[id].lifecycle.state).toBe('acknowledged');
    await dev.emit('task.take', { task: id, device: dev.device });
    await dev.emit('task.transition', { task: id, to: 'review', sha: 'abc1234' });
    sync(lead, dev);
    await lead.emit('review.decide', { task: id, decision: 'changes', sha: 'abc1234' });
    sync(lead, dev);
    expect(F(w).tasks[id].lifecycle.state).toBe('changes');
    await dev.emit('task.transition', { task: id, to: 'active' });
    await dev.emit('task.transition', { task: id, to: 'review', sha: 'def5678' });
    sync(lead, dev);
    await lead.emit('review.decide', { task: id, decision: 'approve', sha: 'def5678' });
    await lead.emit('push.request', { task: id, sha: 'def5678' });
    sync(lead, dev);
    await dev.emit('task.transition', { task: id, to: 'pushed', sha: 'def5678' });
    sync(lead, dev);
    await lead.emit('task.transition', { task: id, to: 'merged' });
    await lead.emit('task.transition', { task: id, to: 'done' });
    const s = F(w);
    expect(s.tasks[id].lifecycle).toMatchObject({ state: 'done', approvedSha: 'def5678', holder: dev.device });
    expect(s.unauthorized).toEqual([]);
  });

  it('only the device holding the take moves the task; move-device hands it over', async () => {
    const { w, lead, dev, all } = await standardTeam();
    const dev2 = new Dev(w, 'dev');
    await lead.emit('task.assign', { task: (await newTask(lead)).id, member: 'dev' });
    const id = `${lead.device}-${lead.seq - 1}`;
    sync(...all);
    const owner = all[0];
    await owner.emit('device.admit', admitBody(dev2, 'MacBook Air'));
    sync(...all, dev2);
    await dev.emit('task.take', { task: id, device: dev.device });
    sync(dev, dev2);
    const wrong = await dev2.emit('task.transition', { task: id, to: 'paused' });
    let s = F(w);
    expect(note(s, wrong)).toBeDefined();
    await dev.emit('task.move-device', { task: id, device: dev2.device });
    sync(dev, dev2);
    await dev2.emit('task.transition', { task: id, to: 'paused' });
    s = F(w);
    expect(s.tasks[id].lifecycle).toMatchObject({ holder: dev2.device, state: 'paused' });
  });

  it('reminders raise effective priority by at most 2; ack resets; ignored on done/cancelled (§7.3–7.4)', async () => {
    const { w, lead, dev, all } = await standardTeam();
    const { id } = await newTask(lead, { priority: 3 });
    await lead.emit('task.assign', { task: id, member: 'dev' });
    for (let i = 0; i < 5; i++) await lead.emit('task.remind', { task: id });
    let s = F(w);
    expect(s.tasks[id].lifecycle.reminders).toBe(5);
    expect(s.tasks[id].effectivePriority).toBe(1);
    sync(...all);
    await dev.emit('task.ack', { task: id });
    s = F(w);
    expect(s.tasks[id].lifecycle.reminders).toBe(0);
    expect(s.tasks[id].effectivePriority).toBe(3);
    const devRemind = await dev.emit('task.remind', { task: id });
    expect(note(F(w), devRemind)).toBeDefined();
    sync(lead, dev);
    await lead.emit('task.transition', { task: id, to: 'cancelled' });
    const late = await lead.emit('task.remind', { task: id });
    s = F(w);
    expect(s.tasks[id].lifecycle.state).toBe('cancelled');
    expect(note(s, late)).toBeDefined();
  });

  it('an ack from someone who is not the assignee is ignored', async () => {
    const { w, lead, des, all } = await standardTeam();
    const { id } = await newTask(lead);
    await lead.emit('task.assign', { task: id, member: 'dev' });
    sync(...all);
    const h = await des.emit('task.ack', { task: id });
    const s = F(w);
    expect(note(s, h)).toBeDefined();
    expect(s.tasks[id].lifecycle.acked).toBe(false);
  });

  it('concurrent takes of an open task: lowest (lamport, device) wins, the loser gets a lost claim (§7.6)', async () => {
    const { w, lead, dev, des, all } = await standardTeam();
    const { id } = await newTask(lead);
    sync(...all);
    const a = await dev.emit('task.take', { task: id, device: dev.device });
    const b = await des.emit('task.take', { task: id, device: des.device });
    const s = F(w);
    const [win, lose] = dev.device < des.device ? [dev, des] : [des, dev];
    expect(s.tasks[id].lifecycle.holder).toBe(win.device);
    expect(s.tasks[id].lostClaims).toEqual([
      { device: lose.device, member: lose.member, event: lose === dev ? a : b, winner: lose === dev ? b : a },
    ]);
  });

  it('a viewer cannot take work', async () => {
    const { w, lead, view, all } = await standardTeam();
    const { id } = await newTask(lead);
    sync(...all);
    const h = await view.emit('task.take', { task: id, device: view.device });
    expect(note(F(w), h)).toBeDefined();
  });

  it('a reassign concurrent with the assignee\'s work ⇒ needs-owner, then conflict.resolve picks a side', async () => {
    const { w, lead, dev, all } = await standardTeam();
    const { id } = await newTask(lead);
    await lead.emit('task.assign', { task: id, member: 'dev' });
    sync(...all);
    await dev.emit('task.take', { task: id, device: dev.device });
    await dev.emit('task.transition', { task: id, to: 'review', sha: 'abc1234' });
    const reassign = await lead.emit('task.assign', { task: id, member: 'des' }); // partitioned
    let s = F(w);
    expect(s.tasks[id].lifecycle.state).toBe('needs-owner');
    const sides = s.tasks[id].conflict!.sides;
    expect(sides).toHaveLength(2);
    const devSide = sides.find((x) => x.event !== reassign)!;
    expect(sides.map((x) => x.lifecycle.assignee).sort()).toEqual(['des', 'dev']);
    // a further event before resolution doesn't silently pick a side
    sync(lead, dev);
    await lead.emit('conflict.resolve', { task: id, pick: devSide.event });
    s = F(w);
    expect(s.tasks[id].conflict).toBeNull();
    expect(s.tasks[id].lifecycle).toMatchObject({ assignee: 'dev', holder: dev.device });
  });

  it('developers may create subtasks of their own tasks only', async () => {
    const { w, lead, dev, all } = await standardTeam();
    const { id } = await newTask(lead);
    await lead.emit('task.assign', { task: id, member: 'dev' });
    sync(...all);
    const sub = `${dev.device}-${dev.seq + 1}`;
    await dev.emit('task.upsert', { task: sub, fields: { title: 'sub', project: PRJ, parent: id } });
    const free = await dev.emit('task.upsert', { task: `${dev.device}-${dev.seq + 1}`, fields: { title: 'free', project: PRJ } });
    const s = F(w);
    expect(s.tasks[sub]).toMatchObject({ parent: id, createdBy: 'dev' });
    expect(note(s, free)).toBeDefined();
  });

  it('sortTasks: held first, then urgent, effective priority, assign lamport, id (§7.3)', async () => {
    const { w, lead, dev, all } = await standardTeam();
    const t1 = await newTask(lead, { priority: 1 });
    const t2 = await newTask(lead, { priority: 3, urgent: true });
    const t3 = await newTask(lead, { priority: 2 });
    const t4 = await newTask(lead, { priority: 3 });
    for (const t of [t1, t2, t3, t4]) await lead.emit('task.assign', { task: t.id, member: 'dev' });
    await lead.emit('task.remind', { task: t3.id });
    await lead.emit('task.remind', { task: t3.id });
    sync(...all);
    await dev.emit('task.take', { task: t4.id, device: dev.device });
    const s = F(w);
    const order = sortTasks(Object.values(s.tasks), dev.device).map((t) => t.id);
    expect(order).toEqual([t4.id, t2.id, t3.id, t1.id]);
  });
});

describe('envelope rules inside the fold (invariant 3)', () => {
  it('a chosen lamport never takes effect; unknown deps stay pending', async () => {
    const { w, owner, lead } = await standardTeam();
    const bad = await lead.emit('task.upsert', { task: `${lead.device}-${lead.seq + 1}`, fields: { title: 'x', project: PRJ } }, { lamport: 1000 });
    const s1 = F(w);
    expect(s1.rejected.map((r) => r.hash)).toContain(bad);
    expect(Object.keys(s1.tasks)).toEqual([]);
    const w2 = w.lineSet();
    const hidden = await owner.emit('project.define', { key: 'prj_hidden', name: 'h', remotes: [], rootCommits: [] });
    const hiddenLine = w.lines[w.lines.length - 1];
    const lead2 = new Dev(w, 'x');
    void lead2;
    // an event depending on a line the reader doesn't hold is pending, not applied
    const dependent = await owner.emit('project.alias', { key: 'prj_hidden', remote: 'github.com/acme/h' });
    const lines = w.lineSet().filter((l) => l !== hiddenLine);
    const s2 = fold({ team: w.team, lines });
    expect(s2.pending.map((p) => p.hash)).toContain(dependent);
    expect(s2.pending.find((p) => p.hash === dependent)!.missing).toEqual([hidden]);
    expect(s2.org.projects.prj_hidden).toBeUndefined();
    void w2;
  });

  it('unknown types are ignored; higher versions are counted, not folded', async () => {
    const { w, lead } = await standardTeam();
    await lead.emit('some.future-thing', { x: 1 });
    await lead.emit('task.upsert', { task: `${lead.device}-${lead.seq + 1}`, fields: { title: 'v2', project: PRJ } }, { v: 2 });
    const s = F(w);
    expect(s.newerVersion).toBe(1);
    expect(Object.keys(s.tasks)).toEqual([]);
  });

  it('events for another team, malformed or badly signed lines are rejected', async () => {
    const { w, lead } = await standardTeam();
    const other = await lead.emit('member.profile', { name: 'x', jobRole: 'y', timezone: 'z' }, { team: 'b'.repeat(64) });
    const s = fold({ team: w.team, lines: [...w.lineSet(), 'not json'] });
    expect(s.rejected.map((r) => r.reason)).toEqual(expect.arrayContaining(['malformed']));
    expect(note(s, other)).toBeDefined();
  });
});

describe('forks (§9, invariant 5)', () => {
  async function forked() {
    const t = await standardTeam();
    const { dev, all } = t;
    const base = await dev.emit('member.profile', { name: 'base', jobRole: 'Web', timezone: 'UTC' });
    const clone = dev.cloneForFork();
    const a = await dev.emit('member.profile', { name: 'A', jobRole: 'Web', timezone: 'UTC' });
    const a2 = await dev.emit('member.profile', { name: 'A2', jobRole: 'Web', timezone: 'UTC' });
    const b = await clone.emit('member.profile', { name: 'B', jobRole: 'Web', timezone: 'UTC' });
    const lineOf = (h: string) => t.w.lines.find((l) => decodeEvent(l).hash === h)!;
    sync(...all);
    return { ...t, base, a, a2, b, clone, lineOf };
  }

  it('both branches in the set ⇒ the feed truncates to the common prefix', async () => {
    const { w, base, a, a2, b } = await forked();
    const s = F(w);
    expect(s.voided).toEqual(expect.arrayContaining([a, a2, b]));
    expect(s.voided).not.toContain(base);
    expect(s.org.members.dev.profile?.name).toBe('base');
    expect(Object.values(s.org.forks)).toEqual([decodeEvent(w.lines.find((l) => decodeEvent(l).hash === a)!).event.seq]);
  });

  it('peers holding different branches plus the proof reach the same prefix', async () => {
    const { w, a, a2, b, lineOf } = await forked();
    const proof = makeForkProof(lineOf(a), lineOf(b));
    const all = w.lineSet();
    const peer1 = all.filter((l) => l !== lineOf(b));
    const peer2 = all.filter((l) => l !== lineOf(a) && l !== lineOf(a2));
    const s1 = fold({ team: w.team, lines: peer1, forkProofs: [proof] });
    const s2 = fold({ team: w.team, lines: peer2, forkProofs: [proof] });
    expect(canonicalize(s1.org)).toBe(canonicalize(s2.org));
    expect(canonicalize(s1.tasks)).toBe(canonicalize(s2.tasks));
    expect(s1.org.members.dev.profile?.name).toBe('base');
  });

  it('a gossiped fork.proof event carries the proof to a peer that has only one branch', async () => {
    const { w, owner, a, b, lineOf } = await forked();
    const proof = makeForkProof(lineOf(a), lineOf(b));
    await owner.emit('fork.proof', { device: proof.device, seq: proof.seq, eventA: proof.eventA, eventB: proof.eventB });
    const onlyA = w.lineSet().filter((l) => l !== lineOf(b));
    const s = fold({ team: w.team, lines: onlyA });
    expect(s.voided).toContain(a);
    expect(s.org.members.dev.profile?.name).toBe('base');
  });
});

// ── property tests: §15 invariants 1–5 under any delivery order ────────────

/** Revoke body as the revoker saw the target: cutoff at the head it holds for it. */
const seenCut = (by: Dev, target: Dev) => {
  const h = by === target ? target.head : by.seen.get(target.device);
  return { device: target.device, cutoffSeq: h?.seq ?? 0, cutoffHash: h?.hash ?? null };
};

/**
 * A random team run. Actors choose plausible actions from the globally folded
 * state but author them with only their own causal knowledge, and sync only
 * sometimes — so concurrent reassigns, double takes, reviews racing rework,
 * revokes (including a mutual one), a fork and chosen-lamport events all occur.
 */
async function randomScenario(seed: number) {
  const rand = rng(seed);
  const t = await standardTeam();
  const { w, owner, sec, lead, dev, des, all } = t;
  const noisy = new Dev(w, 'noisy');
  await owner.emit('device.admit', admitBody(noisy));
  await owner.emit('role.grant', { member: 'noisy', project: PRJ, role: 'developer' });
  sync(...all, noisy);
  const leads = [owner, lead];
  const workers = [dev, des];
  const actors = [owner, sec, lead, dev, des, noisy];
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const creator = new Map<string, Dev>();
  let forked = false;
  let mutualDone = false;
  let restored = false;
  let admits = 0;
  const learnTask = (d: Dev, id: string) => {
    const c = creator.get(id);
    if (c && c !== d && rand() < 0.85) d.learn(c);
  };
  for (let step = 0; step < 70; step++) {
    const r = rand();
    if (r < 0.1) { const a = pick(actors); const b = pick(actors); if (a !== b) sync(a, b); continue; }
    if (r < 0.14) { sync(...actors); continue; }
    const g = fold({ team: w.team, lines: w.lineSet() });
    const tasks = Object.values(g.tasks);
    const k = rand();
    if (k < 0.12 || tasks.length === 0) {
      const a = pick(leads);
      const id = `${a.device}-${a.seq + 1}`;
      await a.emit('task.upsert', { task: id, fields: { title: `t${step}`, project: PRJ, priority: Math.floor(rand() * 4) } });
      creator.set(id, a);
      continue;
    }
    const task = pick(tasks);
    const L = task.lifecycle;
    if (k < 0.24) {
      const a = pick(leads); learnTask(a, task.id);
      await a.emit('task.assign', { task: task.id, member: pick(workers).member });
    } else if (k < 0.5) {
      // a worker takes the natural next step on a task it believes is its own (or open)
      const wk = (L.assignee && workers.find((x) => x.member === L.assignee)) || pick(workers);
      learnTask(wk, task.id);
      if (L.state === 'unassigned' && rand() < 0.5) {
        // both workers grab the open task without hearing about each other's take
        for (const x of workers) { learnTask(x, task.id); await x.emit('task.take', { task: task.id, device: x.device }); }
      } else if (L.state === 'unassigned' || L.state === 'assigned' || L.state === 'acknowledged') {
        if (rand() < 0.3) await wk.emit('task.ack', { task: task.id });
        else await wk.emit('task.take', { task: task.id, device: wk.device });
      } else if (L.state === 'active') {
        await wk.emit('task.transition', { task: task.id, to: pick(['review', 'review', 'paused', 'blocked']), sha: 'abc1234' });
      } else if (['paused', 'blocked', 'changes'].includes(L.state)) {
        await wk.emit('task.transition', { task: task.id, to: 'active' });
      } else if (L.state === 'approved') {
        await wk.emit('task.transition', { task: task.id, to: 'pushed', sha: 'abc1234' });
      }
    } else if (k < 0.62) {
      const a = pick(leads); learnTask(a, task.id);
      if (L.state === 'review') await a.emit('review.decide', { task: task.id, decision: pick(['approve', 'changes']), sha: 'abc1234' });
      else if (L.state === 'approved') await a.emit('push.request', { task: task.id, sha: 'abc1234' });
      else if (L.state === 'needs-owner' && task.conflict) {
        sync(a, ...workers);
        await a.emit('conflict.resolve', { task: task.id, pick: pick(task.conflict.sides).event });
      } else await a.emit('task.remind', { task: task.id });
    } else if (k < 0.7) {
      const a = pick(leads); learnTask(a, task.id);
      await a.emit('task.upsert', { task: task.id, fields: pick([{ title: `e${step}` }, { urgent: rand() < 0.5 }, { priority: Math.floor(rand() * 4) }]) });
    } else if (k < 0.74) {
      await owner.emit('device.revoke', seenCut(owner, pick([dev, des, noisy])));
    } else if (k < 0.77 && !mutualDone) {
      mutualDone = true;
      await owner.emit('device.revoke', seenCut(owner, sec));
      await sec.emit('device.revoke', seenCut(sec, owner));
    } else if (k < 0.785 && mutualDone && !restored) {
      // the recovery key restores a fresh custodian; grants after this are legitimate again
      restored = true;
      const rec = new Dev(w, 'rec');
      await lead.emit('recovery.restore', recoveryBody(w, 1, [rec]));
    } else if (k < 0.8 && !forked) {
      forked = true;
      const clone = pick(workers).cloneForFork();
      await clone.emit('member.profile', { name: 'fork', jobRole: 'x', timezone: 'UTC' });
    } else if (k < 0.83) {
      // a chosen lamport (invariant 3): never takes effect, nor anything built on it
      await noisy.emit('task.take', { task: task.id, device: noisy.device }, { lamport: (noisy.head?.lamport ?? 0) + 50 });
    } else if (k < 0.87) {
      await pick(leads).emit('role.grant', { member: pick(workers).member, project: PRJ, role: pick(['developer', 'designer']) });
    } else if (k < 0.9) {
      // an admission by a custodian (or ex-custodian): must not take effect in recovery mode
      const nd = new Dev(w, `new${admits++}`);
      await pick([owner, sec]).emit('device.admit', admitBody(nd));
    } else {
      await pick(actors).emit('member.profile', { name: `p${step}`, jobRole: 'x', timezone: 'UTC' });
    }
  }
  return { w, rand };
}

/** hash → the set of hashes in its causal past (itself included), over prev + deps. */
function ancestry(byHash: Map<string, TeamEvent>): (h: string) => Set<string> {
  const memo = new Map<string, Set<string>>();
  const go = (h: string): Set<string> => {
    let out = memo.get(h);
    if (out) return out;
    out = new Set([h]);
    memo.set(h, out);
    const ev = byHash.get(h);
    if (ev) for (const p of ev.prev ? [ev.prev, ...ev.deps] : ev.deps) if (byHash.has(p)) for (const x of go(p)) out.add(x);
    return out;
  };
  return go;
}

describe('§15 invariants 1–5: any delivery order ⇒ identical fold', () => {
  it('a hand-built scenario (needs-owner, mutual revoke, fork) folds identically under 25 shuffles', async () => {
    const t = await standardTeam();
    const { lead, dev, owner, sec, all } = t;
    const { id } = await newTask(lead);
    await lead.emit('task.assign', { task: id, member: 'dev' });
    sync(...all);
    await dev.emit('task.take', { task: id, device: dev.device });
    await lead.emit('task.assign', { task: id, member: 'des' }); // → needs-owner
    const cutO = cut(owner); const cutS = cut(sec);
    await owner.emit('device.revoke', cutS);
    await sec.emit('device.revoke', cutO);
    const clone = dev.cloneForFork();
    await clone.emit('member.profile', { name: 'fork', jobRole: 'x', timezone: 'UTC' });
    await dev.emit('member.profile', { name: 'main', jobRole: 'x', timezone: 'UTC' });
    const lines = t.w.lineSet();
    const base = fold({ team: t.w.team, lines });
    expect(base.org.recoveryMode).toBe(true);
    expect(base.tasks[id].lifecycle.state).toBe('needs-owner');
    expect(Object.keys(base.org.forks)).toEqual([dev.device]);
    const rand = rng(7);
    for (let i = 0; i < 25; i++) {
      const s = fold({ team: t.w.team, lines: shuffle(lines, rand) });
      expect(stateHash(s)).toBe(stateHash(base));
    }
  });

  it('random multi-device runs fold identically in any order, and reach every hard case', async () => {
    const seen = {
      needsOwner: 0, resolve: 0, lostClaim: 0, fork: 0, voided: 0, recovery: 0, review: 0, chosenLamport: 0,
      refusedInRecovery: 0, grantAfterRestore: 0,
    };
    for (let seed = 1; seed <= 16; seed++) {
      const { w, rand } = await randomScenario(seed);
      const lines = w.lineSet();
      const base = fold({ team: w.team, lines });
      const h = stateHash(base);
      // invariant 1 (incl. forks and revokes): any delivery order ⇒ identical fold
      for (let i = 0; i < 6; i++) {
        const s = fold({ team: w.team, lines: shuffle(lines, rand) });
        if (stateHash(s) !== h) expect(canonicalize(s)).toBe(canonicalize(base));
      }
      // invariants 2, 3, 5: void, rejected and pending events never surface as effects
      const dead = new Set([...base.voided, ...base.rejected.map((r) => r.hash), ...base.pending.map((p) => p.hash)]);
      for (const task of Object.values(base.tasks)) {
        expect(dead.has(task.lastEvent)).toBe(false);
        expect(dead.has(task.createdEvent)).toBe(false);
        if (task.lifecycle.ackEvent) expect(dead.has(task.lifecycle.ackEvent)).toBe(false);
      }
      for (const d of Object.values(base.org.devices)) expect(dead.has(d.admittedBy)).toBe(false);
      const decodedLines = lines.map((l) => decodeEvent(l));
      const lineOf = new Map(decodedLines.map((d) => [d.hash, d.line]));
      for (const [device, seq] of Object.entries(base.org.forks)) {
        for (const { event, hash } of decodedLines) {
          if (event.device === device && event.seq >= seq) expect(dead.has(hash)).toBe(true);
        }
      }
      const byHash = new Map(decodedLines.map((d) => [d.hash, d.event]));
      const past = ancestry(byHash);
      const unauth = new Set(base.unauthorized.map((u) => u.hash));
      const effective = (h: string) => !dead.has(h) && !unauth.has(h);
      const concurrent = (a: string, b: string) => !past(a).has(b) && !past(b).has(a);
      for (const [device, info] of Object.entries(base.org.devices)) {
        if (info.cutoffSeq === null) continue;
        for (const { event, hash } of decodedLines) {
          if (event.device !== device || event.seq <= info.cutoffSeq) continue;
          // invariant 2: past the cutoff nothing applies, except the one genuine exemption —
          // a revoke that is half of a concurrent mutual pair whose other half also applied.
          const mutualHalf =
            event.type === 'device.revoke' &&
            decodedLines.some((o) =>
              o.event.type === 'device.revoke' && o.event.device === event.body.device && o.event.body.device === device &&
              effective(o.hash) && concurrent(o.hash, hash));
          if (!mutualHalf) expect(dead.has(hash), `${event.type} past cutoff`).toBe(true);
        }
      }
      // invariant 4: recovery mode iff no live custodian, and once the team is in recovery
      // no role.grant or device.admit takes effect until a recovery.restore is in its past.
      expect(base.org.recoveryMode).toBe(base.org.custodians.length === 0);
      for (const { event, hash } of decodedLines) {
        if ((event.type !== 'role.grant' && event.type !== 'device.admit') || !effective(hash)) continue;
        const before = [...past(hash)].filter((h) => h !== hash).map((h) => lineOf.get(h)!);
        const S = fold({ team: w.team, lines: before });
        expect(S.org.recoveryMode, `${event.type} took effect in recovery mode`).toBe(false);
        seen.grantAfterRestore += before.some((l) => decodeEvent(l).event.type === 'recovery.restore') ? 1 : 0;
      }
      for (const u of base.unauthorized) if (u.reason === 'recovery-mode') seen.refusedInRecovery++;
      const ts = Object.values(base.tasks);
      seen.needsOwner += ts.filter((x) => x.lifecycle.state === 'needs-owner').length;
      seen.lostClaim += ts.reduce((a, x) => a + x.lostClaims.length, 0);
      seen.fork += Object.keys(base.org.forks).length;
      seen.voided += base.voided.length;
      seen.recovery += base.org.recoveryMode ? 1 : 0;
      seen.review += ts.filter((x) => ['review', 'approved', 'changes', 'pushed'].includes(x.lifecycle.state)).length;
      seen.chosenLamport += base.rejected.filter((r) => r.reason === 'lamport-not-derived').length;
      seen.resolve += decodedLines.filter((d) => d.event.type === 'conflict.resolve' && !dead.has(d.hash)
        && !base.unauthorized.some((u) => u.hash === d.hash)).length;
    }
    // The generator must reach the hard cases, or the property is vacuous.
    for (const [k, v] of Object.entries(seen)) expect(v, k).toBeGreaterThan(0);
  }, 120_000);

  it('convergence: partial views per device fold, and their union folds to the full set (pending → resolved)', async () => {
    let sawPending = 0;
    let resolved = 0;
    for (let seed = 201; seed <= 206; seed++) {
      const { w, rand } = await randomScenario(seed);
      const all = w.lineSet();
      const full = fold({ team: w.team, lines: all });
      const fullHash = stateHash(full);
      const fullPending = new Set(full.pending.map((p) => p.hash));
      // Four simulated devices: each holds a prefix of authoring order (a causally
      // closed history) plus a random subset of later lines (gossip in any order).
      const views: string[][] = [];
      for (let d = 0; d < 4; d++) {
        const mine = new Set(w.lines.slice(0, Math.floor(rand() * w.lines.length)));
        for (const l of all) if (rand() < 0.25) mine.add(l);
        views.push([...mine]);
      }
      const covered = new Set(views.flat());
      views[0].push(...all.filter((l) => !covered.has(l)));
      for (const v of views) {
        const s = fold({ team: w.team, lines: shuffle(v, rand) });
        expect(stateHash(fold({ team: w.team, lines: shuffle(v, rand) }))).toBe(stateHash(s));
        sawPending += s.pending.length;
        for (const p of s.pending) if (!fullPending.has(p.hash)) resolved++;
      }
      // merging views in any order, with duplicates, reaches the full-set fold
      expect(stateHash(fold({ team: w.team, lines: shuffle(views.flat(), rand) }))).toBe(fullHash);
      const ab = fold({ team: w.team, lines: [...views[0], ...views[1]] });
      const ba = fold({ team: w.team, lines: [...views[1], ...views[0]].reverse() });
      expect(stateHash(ab)).toBe(stateHash(ba));
      expect(stateHash(fold({ team: w.team, lines: [...views[2], ...views[3], ...views[0], ...views[1]] }))).toBe(fullHash);
    }
    expect(sawPending).toBeGreaterThan(0);
    expect(resolved).toBeGreaterThan(0);
  }, 120_000);

  it('duplicated lines do not change the fold', async () => {
    const { w } = await randomScenario(99);
    const lines = w.lineSet();
    const base = stateHash(fold({ team: w.team, lines }));
    expect(stateHash(fold({ team: w.team, lines: [...lines, ...lines.slice(0, 10)] }))).toBe(base);
  });
});

