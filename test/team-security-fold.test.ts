// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Regression tests for the Team Sync fold security review. Each `describe`
 * names the finding it pins; every test here failed against the pre-fix fold.
 */
import { describe, it, expect } from 'vitest';
import { fold, normalizeProjectRemote, stateHash } from '../src/team/fold.js';
import { normalizeRemote } from '../src/team/projects.js';
import { decodeEvent, signEvent } from '../src/team/envelope.js';
import type { TeamState } from '../src/team/types.js';
import {
  Dev, World, admitBody, emitBlind, genesis, recoveryBody, rng, shuffle, standardTeam, sync, PRJ,
} from './team-helpers.js';

const F = (w: World) => fold({ team: w.team, lines: w.lineSet() });
const note = (s: TeamState, hash: string) =>
  s.unauthorized.find((n) => n.hash === hash)?.reason ?? s.rejected.find((n) => n.hash === hash)?.reason;
const seqOf = (w: World, hash: string) => decodeEvent(w.lines.find((l) => decodeEvent(l).hash === hash)!).event.seq;
const lamportOf = (w: World, hash: string) => decodeEvent(w.lines.find((l) => decodeEvent(l).hash === hash)!).event.lamport;

/** Sign an arbitrary envelope as `d` (any seq/fork/prev/deps/lamport) and add it to the world. */
async function signAt(w: World, d: Dev, e: { seq: number; fork: number; prev: string | null; deps: string[]; lamport: number; type: string; body: Record<string, unknown> }) {
  const r = await signEvent(d, { v: 1, team: w.team, device: d.device, ts: '2026-09-29T10:00:00.000Z', ...e });
  w.lines.push(r.line);
  return r.hash;
}

const cut = (d: Dev) => ({ device: d.device, cutoffSeq: d.head?.seq ?? 0, cutoffHash: d.head?.hash ?? null });

/** standardTeam plus `lead` promoted to a third custodian (owner proposes, sec cosigns). */
async function threeCustodians() {
  const t = await standardTeam();
  const p = await t.owner.emit('role.proposal', { action: 'grant', member: 'lead', role: 'custodian' });
  sync(...t.all);
  await t.sec.emit('role.cosign', { proposal: p });
  sync(...t.all);
  return t;
}

/** Demote `member` from custodian by quorum: `by` proposes, `cosigner` cosigns; both then sync. */
async function demote(by: Dev, cosigner: Dev, member: string) {
  const p = await by.emit('role.proposal', { action: 'revoke', member, role: 'custodian' });
  sync(by, cosigner);
  await cosigner.emit('role.cosign', { proposal: p });
  sync(by, cosigner);
}

describe('finding 1 (critical): a revoked custodian cannot nuke the team', () => {
  it('a blind counter-revoke of the genesis device at cutoff 0 only removes liveness (poc-fold S1)', async () => {
    const { w, owner, sec, lead, all } = await standardTeam();
    const genesisHash = decodeEvent(w.lines[0]).hash;
    const id = `${owner.device}-${owner.seq + 1}`;
    await owner.emit('task.upsert', { task: id, fields: { project: PRJ, title: 'T' } });
    const s1 = await sec.emit('member.profile', { name: 's', jobRole: 'x', timezone: 'UTC' });
    sync(...all);
    const rO = await owner.emit('device.revoke', { device: sec.device, cutoffSeq: 1, cutoffHash: s1 });
    const rS = await emitBlind(sec, 'device.revoke', { device: owner.device, cutoffSeq: 0, cutoffHash: null });
    const s = F(w);
    expect(s.org.genesis).toBe(genesisHash);
    expect(s.org.recoveryPub).toBe(w.recovery.spki);
    expect(Object.keys(s.org.devices)).toHaveLength(7);
    expect(Object.keys(s.tasks)).toEqual([id]);
    expect(s.org.projects[PRJ]).toBeDefined();
    // A mutual pair: both apply, but the counter-revoke can't reach below the revoker's own revoke.
    expect(note(s, rO)).toBeUndefined();
    expect(note(s, rS)).toBeUndefined();
    expect(s.org.devices[owner.device].cutoffSeq).toBe(seqOf(w, rO) - 1);
    expect(s.org.devices[sec.device].cutoffSeq).toBe(1);
    expect(s.voided).toEqual([]);
    expect(s.org.recoveryMode).toBe(true);
    // ...and the recovery key still restores the team.
    sync(lead, owner, sec);
    const fresh = new Dev(w, 'owner');
    await lead.emit('recovery.restore', recoveryBody(w, 1, [fresh]));
    const r = F(w);
    expect(r.org.recoveryMode).toBe(false);
    expect(r.org.custodians).toEqual([fresh.device]);
  });

  it('the genesis device never gets a cutoff below 1, even revoking itself at 0', async () => {
    const w = new World();
    const owner = new Dev(w, 'owner');
    const g = await genesis(w, owner);
    await owner.emit('member.profile', { name: 'o', jobRole: 'x', timezone: 'UTC' });
    await owner.emit('device.revoke', { device: owner.device, cutoffSeq: 0, cutoffHash: null });
    const s = F(w);
    expect(s.org.genesis).toBe(g);
    expect(s.org.devices[owner.device].cutoffSeq).toBe(1);
    expect(s.org.recoveryPub).toBe(w.recovery.spki);
    expect(s.org.recoveryMode).toBe(true);
    const fresh = new Dev(w, 'owner');
    sync(owner, fresh);
    await fresh.emit('recovery.restore', recoveryBody(w, 1, [fresh]));
    expect(F(w).org.custodians).toEqual([fresh.device]);
  });

  it('pins are recomputed each pass: a revoke that is itself voided releases its target', async () => {
    const { w, owner, sec, lead, dev, all } = await threeCustodians();
    const secTrusted = cut(sec);
    await dev.emit('member.profile', { name: 'keep', jobRole: 'x', timezone: 'UTC' });
    sync(...all);
    // sec (about to be removed) revokes dev from seq 0, after its last trusted event.
    const bad = await sec.emit('device.revoke', { device: dev.device, cutoffSeq: 0, cutoffHash: null });
    sync(...all);
    await demote(owner, lead, 'sec');
    await owner.emit('device.revoke', secTrusted);
    const s = F(w);
    expect(s.voided).toContain(bad);
    expect(s.org.devices[dev.device].cutoffSeq).toBeNull();
    expect(s.org.members.dev.profile?.name).toBe('keep');
    expect(s.org.devices[sec.device].cutoffSeq).toBe(secTrusted.cutoffSeq);
  });

  it('the attack folds identically in any delivery order', async () => {
    const { w, owner, sec, all } = await standardTeam();
    const s1 = await sec.emit('member.profile', { name: 's', jobRole: 'x', timezone: 'UTC' });
    sync(...all);
    await owner.emit('device.revoke', { device: sec.device, cutoffSeq: 1, cutoffHash: s1 });
    await emitBlind(sec, 'device.revoke', { device: owner.device, cutoffSeq: 0, cutoffHash: null });
    await emitBlind(sec, 'role.grant', { member: 'sec', project: '*', role: 'lead' });
    const lines = w.lineSet();
    const base = stateHash(fold({ team: w.team, lines }));
    const rand = rng(11);
    for (let i = 0; i < 10; i++) expect(stateHash(fold({ team: w.team, lines: shuffle(lines, rand) }))).toBe(base);
  });
});

describe('finding 2 (high): a voided amend no longer un-voids', () => {
  it('an amend by a custodian later cut off before it has no effect (poc-fold S2)', async () => {
    const { w, owner, sec, lead, dev, all } = await threeCustodians();
    const d1 = await dev.emit('member.profile', { name: 'good', jobRole: 'x', timezone: 'UTC' });
    sync(...all);
    await owner.emit('device.revoke', { device: dev.device, cutoffSeq: seqOf(w, d1), cutoffHash: d1 });
    const evil = await dev.emit('member.profile', { name: 'EVIL', jobRole: 'x', timezone: 'UTC' });
    const s1 = await sec.emit('member.profile', { name: 's', jobRole: 'x', timezone: 'UTC' });
    sync(...all);
    const amend = await sec.emit('device.revoke.amend', { device: dev.device, events: [evil] });
    sync(...all);
    expect(F(w).org.members.dev.profile?.name).toBe('EVIL'); // the amend works while sec is trusted
    await demote(owner, lead, 'sec');
    await owner.emit('device.revoke', { device: sec.device, cutoffSeq: seqOf(w, s1), cutoffHash: s1 });
    const s = F(w);
    expect(s.voided).toEqual(expect.arrayContaining([amend, evil]));
    expect(s.org.members.dev.profile?.name).toBe('good');
  });
});

describe('finding 3 (high): recovery.restore cannot be replayed', () => {
  async function recovered() {
    const t = await standardTeam();
    const { w, owner, sec, lead, all } = t;
    const cO = cut(owner);
    const cS = cut(sec);
    await owner.emit('device.revoke', cS);
    await sec.emit('device.revoke', cO);
    sync(...all); // every device has seen the mutual revoke: all are in recovery mode
    const alice = new Dev(w, 'alice');
    const bob = new Dev(w, 'bob');
    const carol = new Dev(w, 'carol');
    const R1 = recoveryBody(w, 1, [alice, bob, carol]);
    const orig = await lead.emit('recovery.restore', R1);
    sync(lead, alice, bob, carol);
    const p = await bob.emit('role.proposal', { role: 'custodian', action: 'revoke', member: 'alice' });
    sync(alice, bob, carol);
    await carol.emit('role.cosign', { proposal: p });
    return { ...t, alice, bob, carol, R1, orig };
  }

  it('a lamport-padded replay by devices that never saw the restore cannot undo a later demotion', async () => {
    const { w, alice, bob, carol, dev, des, view, relay, R1, orig } = await recovered();
    let s = F(w);
    expect(s.org.members.alice.roles).not.toContain('*:custodian');
    expect(s.org.custodians).toEqual([bob.device, carol.device].sort());
    const replays: string[] = [];
    for (const d of [dev, des, view, relay]) {
      for (let i = 0; i < 25; i++) await d.emit('member.profile', { name: `pad${i}`, jobRole: 'x', timezone: 'UTC' });
      replays.push(await d.emit('recovery.restore', R1));
    }
    s = F(w);
    expect(note(s, orig)).toBeUndefined();
    expect(s.org.members.alice.roles).not.toContain('*:custodian');
    expect(s.org.custodians).toEqual([bob.device, carol.device].sort());
    expect(s.org.recoveryEpoch).toBe(1);
    expect(s.org.devices[alice.device].admittedBy).toBe(orig);
    void replays;
  });

  it('a restore outside recovery mode is refused (poc-fold S3 as written)', async () => {
    const w = new World();
    const owner = new Dev(w, 'owner');
    const alice = new Dev(w, 'alice');
    const v = new Dev(w, 'view');
    await genesis(w, owner);
    await owner.emit('device.admit', admitBody(v));
    sync(owner, v);
    const R1 = recoveryBody(w, 1, [alice]);
    const r = await owner.emit('recovery.restore', R1);
    for (let i = 0; i < 20; i++) await emitBlind(v, 'member.profile', { name: `v${i}`, jobRole: 'x', timezone: 'UTC' });
    const replay = await emitBlind(v, 'recovery.restore', R1);
    const s = F(w);
    expect(note(s, r)).toBe('not-in-recovery');
    expect(note(s, replay)).toBe('not-in-recovery');
    expect(s.org.members.alice).toBeUndefined();
  });

  it('a second statement for an epoch signed after that epoch was applied never takes effect', async () => {
    const { w, lead, bob } = await recovered();
    sync(lead, bob);
    const mallory = new Dev(w, 'mallory');
    const late = await lead.emit('recovery.restore', recoveryBody(w, 1, [mallory]));
    const s = F(w);
    expect(note(s, late)).toBeDefined();
    expect(s.org.members.mallory).toBeUndefined();
  });
});

describe('finding 4 (high): revoking devices is not a quorum bypass', () => {
  it('one custodian cannot revoke another custodian member\'s devices, nor then act alone', async () => {
    const { w, owner, sec, lead, all } = await standardTeam();
    const sec2 = new Dev(w, 'sec');
    await owner.emit('device.admit', admitBody(sec2, 'second Mac'));
    sync(...all, sec2);
    const r1 = await owner.emit('device.revoke', cut(sec));
    const r2 = await owner.emit('device.revoke', cut(sec2));
    const g = await owner.emit('role.grant', { member: 'lead', project: '*', role: 'custodian' });
    const s = F(w);
    expect(note(s, r1)).toBe('needs-quorum');
    expect(note(s, r2)).toBe('needs-quorum');
    expect(note(s, g)).toBe('needs-quorum');
    expect(s.org.custodians).toEqual([owner.device, sec.device, sec2.device].sort());
    void lead;
  });

  it('quorum is counted by role: a custodian with no live device still has to consent', async () => {
    const { w, owner, sec, all } = await standardTeam();
    await sec.emit('device.revoke', cut(sec)); // sec retires its only device
    sync(...all);
    const g = await owner.emit('role.grant', { member: 'lead', project: '*', role: 'custodian' });
    const r = await owner.emit('role.revoke', { member: 'sec', project: '*', role: 'custodian' });
    const s = F(w);
    expect(s.org.custodians).toEqual([owner.device]);
    expect(note(s, g)).toBe('needs-quorum');
    expect(note(s, r)).toBe('needs-quorum');
  });

  it('a member may still revoke its own other device', async () => {
    const { w, owner, sec, all } = await standardTeam();
    const sec2 = new Dev(w, 'sec');
    await owner.emit('device.admit', admitBody(sec2, 'second Mac'));
    sync(...all, sec2);
    const r = await sec.emit('device.revoke', cut(sec2));
    expect(note(F(w), r)).toBeUndefined();
  });
});

describe('C9: happened-before compares the hash, not only (device, seq)', () => {
  it('a cutoffHash on the fork branch the revoker never saw is refused', async () => {
    const { w, owner, dev, all } = await standardTeam();
    await dev.emit('member.profile', { name: 'base', jobRole: 'x', timezone: 'UTC' });
    sync(...all);
    const clone = dev.cloneForFork();
    const a = await dev.emit('member.profile', { name: 'A', jobRole: 'x', timezone: 'UTC' });
    const b = await clone.emit('member.profile', { name: 'B', jobRole: 'x', timezone: 'UTC' });
    sync(owner, dev); // owner sees branch A only
    const bad = await owner.emit('device.revoke', { device: dev.device, cutoffSeq: seqOf(w, b), cutoffHash: b });
    const good = await owner.emit('device.revoke', { device: dev.device, cutoffSeq: seqOf(w, a), cutoffHash: a });
    const s = F(w);
    expect(note(s, bad)).toBe('cutoff-unseen');
    expect(note(s, good)).toBeUndefined();
  });
});

describe('finding 8 (low): keys are learned only from effective admits', () => {
  it('a self-admitted outsider stays pending, however much it writes (poc-dos)', async () => {
    const w = new World();
    const owner = new Dev(w, 'owner');
    await genesis(w, owner);
    const out = new Dev(w, 'outsider');
    await out.emit('device.admit', admitBody(out), { deps: [], lamport: 1 });
    for (let i = 0; i < 300; i++) {
      await emitBlind(out, 'device.revoke', { device: owner.device, cutoffSeq: 0, cutoffHash: null });
    }
    const s = F(w);
    expect(s.org.genesis).not.toBeNull();
    expect(s.org.devices[owner.device].cutoffSeq).toBeNull();
    expect(s.unauthorized).toEqual([]);
    expect(s.pending).toHaveLength(301);
    expect(s.pending.every((p) => p.missing.join() === `device:${out.device}`)).toBe(true);
  });

  it('a device admitted without authority stays pending too', async () => {
    const { w, dev } = await standardTeam();
    const x = new Dev(w, 'x');
    const admit = await dev.emit('device.admit', admitBody(x));
    sync(dev, x);
    const act = await x.emit('member.profile', { name: 'x', jobRole: 'x', timezone: 'UTC' });
    const s = F(w);
    expect(note(s, admit)).toBe('not-custodian');
    expect(s.pending.find((p) => p.hash === act)?.missing).toEqual([`device:${x.device}`]);
  });
});

describe('C2 (critical): a differing fork counter is equivocation, never an adoption', () => {
  it('a thief re-forking a revoked device at seq 1 voids the feed; its forged history never applies (r2-refork A)', async () => {
    const { w, owner, dev, all } = await standardTeam();
    const t = await owner.emit('task.upsert', { task: `${owner.device}-${owner.seq + 1}`, fields: { project: PRJ, title: 'T' } });
    sync(...all);
    const d1 = await dev.emit('member.profile', { name: 'honest', jobRole: 'x', timezone: 'UTC' });
    sync(...all);
    await owner.emit('device.revoke', { device: dev.device, cutoffSeq: 1, cutoffHash: d1 });
    const forged = await signAt(w, dev, { seq: 1, fork: 1, prev: null, deps: [t], lamport: lamportOf(w, t) + 1, type: 'member.profile', body: { name: 'FORGED', jobRole: 'x', timezone: 'UTC' } });
    const s = F(w);
    expect(s.org.forks[dev.device]).toBe(1);
    expect(s.voided).toContain(forged);
    expect(s.org.members.dev.profile?.name).not.toBe('FORGED');
  });

  it('a re-forked genesis cannot replace the team or admit a device (r2-refork B)', async () => {
    const { w, owner, sec } = await standardTeam();
    const g = decodeEvent(w.lines[0]);
    const g2 = await signAt(w, owner, { seq: 1, fork: 1, prev: null, deps: [], lamport: 1, type: 'team.genesis', body: g.event.body });
    const mallory = new Dev(w, 'mallory');
    const a = await signAt(w, owner, { seq: 2, fork: 1, prev: g2, deps: [], lamport: 2, type: 'device.admit', body: admitBody(mallory) });
    const b = await signAt(w, owner, { seq: 1, fork: 2, prev: null, deps: [g.hash], lamport: 2, type: 'device.admit', body: admitBody(new Dev(w, 'eve')) });
    const s = F(w);
    expect(s.org.genesis).toBe(g.hash); // a genesis carries fork 0; the copy is refused
    expect(note(s, g2)).toBe('genesis-not-root');
    expect(s.org.recoveryPub).toBe(w.recovery.spki);
    expect(s.voided).toEqual(expect.arrayContaining([a, b]));
    expect(Object.values(s.org.devices).map((d) => d.member)).toEqual(['owner']);
    expect(s.org.forks[owner.device]).toBe(2);
    expect(s.org.devices[owner.device].cutoffSeq).toBe(1);
    // the forked genesis device is dead, so the recovery key can restore the team
    expect(s.org.recoveryMode).toBe(true);
    const fresh = new Dev(w, 'owner');
    sync(fresh, sec);
    const rr = await fresh.emit('recovery.restore', recoveryBody(w, 1, [fresh]), { deps: [g.hash, g2].sort(), lamport: 2 });
    const after = F(w);
    expect(note(after, rr)).toBeUndefined();
    expect(after.org.custodians).toEqual([fresh.device]);
  });

  it('the fork counter never decreases along a chain', async () => {
    const { w, dev } = await standardTeam();
    await dev.emit('member.profile', { name: 'a', jobRole: 'x', timezone: 'UTC' }, { fork: 1 });
    const back = await dev.emit('member.profile', { name: 'b', jobRole: 'x', timezone: 'UTC' }, { fork: 0 });
    expect(note(F(w), back)).toBe('fork-counter-decreased');
  });
});

describe('finding 9: project remotes are normalised and claimed once', () => {
  it('the fold normaliser agrees with projects.ts and is idempotent', () => {
    const samples = [
      'git@github.com:acme/api.git', 'https://github.com/acme/api', 'ssh://git@GitHub.com:22/acme/api.git',
      'https://x-token:abc@github.com/acme/api.git', 'git@GitLab.com:Acme/Platform/Web.git',
      'https://evil.com#@github.com/acme/api', 'https://evil.com?@github.com/acme/api', 'git@evil.com#@github.com:acme/api',
      'https://evil.com\\@github.com/acme/api', 'https://evil.com%23@github.com/acme/api', 'evil.com\\@github.com:acme/api',
      'file:///tmp/x', '/local/path', 'C:\\repos\\x', '', 'https://github.com/acme/api.git?x=1#frag',
    ];
    for (const u of samples) {
      const n = normalizeRemote(u);
      expect(normalizeProjectRemote(u), u).toBe(n);
      if (n) expect(normalizeProjectRemote(n)).toBe(n);
    }
  });

  it('project.define and project.alias store canonical remotes; bad authorities are refused', async () => {
    const { w, owner } = await standardTeam();
    await owner.emit('project.define', { key: 'prj_mob1', name: 'm', remotes: ['git@GitHub.com:acme/mobile.git'], rootCommits: [] });
    await owner.emit('project.alias', { key: 'prj_mob1', remote: 'https://github.com/acme/mobile' });
    const bad = await owner.emit('project.define', { key: 'prj_bad1', name: 'b', remotes: ['https://evil.com#@github.com/acme/x'], rootCommits: [] });
    const badAlias = await owner.emit('project.alias', { key: 'prj_mob1', remote: 'https://evil.com%40@github.com/acme/y' });
    const s = F(w);
    expect(s.org.projects.prj_mob1.remotes).toEqual(['github.com/acme/mobile']);
    expect(note(s, bad)).toBe('invalid-remote');
    expect(note(s, badAlias)).toBe('invalid-remote');
  });

  it('a remote already claimed by another project is refused; concurrent claims: first in fold order wins', async () => {
    const { w, owner, lead, all } = await standardTeam();
    const dup = await owner.emit('project.define', { key: 'prj_dup1', name: 'd', remotes: ['git@github.com:acme/web.git'], rootCommits: [] });
    const alias = await owner.emit('project.alias', { key: 'prj_api1', remote: 'https://github.com/acme/web' });
    sync(...all);
    await owner.emit('role.grant', { member: 'lead', project: '*', role: 'lead' });
    sync(owner, lead);
    const a = await owner.emit('project.define', { key: 'prj_one1', name: '1', remotes: ['github.com/acme/shared'], rootCommits: [] });
    const b = await lead.emit('project.define', { key: 'prj_two1', name: '2', remotes: ['git@github.com:acme/shared.git'], rootCommits: [] });
    const s = F(w);
    expect(note(s, dup)).toBe('remote-claimed');
    expect(note(s, alias)).toBe('remote-claimed');
    const [first, second] = [a, b].sort((x, y) => {
      const ex = decodeEvent(w.lines.find((l) => decodeEvent(l).hash === x)!).event;
      const ey = decodeEvent(w.lines.find((l) => decodeEvent(l).hash === y)!).event;
      return ex.lamport - ey.lamport || (ex.device < ey.device ? -1 : 1);
    });
    expect(note(s, first)).toBeUndefined();
    expect(note(s, second)).toBe('remote-claimed');
    const lines = w.lineSet();
    const rand = rng(5);
    for (let i = 0; i < 5; i++) expect(stateHash(fold({ team: w.team, lines: shuffle(lines, rand) }))).toBe(stateHash(s));
  });
});

describe('finding 10: task briefs have a validated shape', () => {
  async function withTask() {
    const t = await standardTeam();
    const id = `${t.lead.device}-${t.lead.seq + 1}`;
    await t.lead.emit('task.upsert', { task: id, fields: { title: 'T', project: PRJ } });
    return { ...t, id };
  }

  it('a valid brief is stored with the optional lists defaulted; null clears it', async () => {
    const { w, lead, id } = await withTask();
    await lead.emit('task.upsert', { task: id, fields: { brief: { goal: 'Ship it', inScope: ['api'], acceptance: ['tests pass'] } } });
    let s = F(w);
    expect(s.tasks[id].brief).toEqual({ goal: 'Ship it', inScope: ['api'], outOfScope: [], acceptance: ['tests pass'], skills: [] });
    expect(s.tasks[id].briefRev).toBe(1);
    await lead.emit('task.upsert', { task: id, fields: { brief: null } });
    s = F(w);
    expect(s.tasks[id].brief).toBeNull();
    expect(s.tasks[id].briefRev).toBe(2);
  });

  it.each([
    ['not an object', 'text'],
    ['missing inScope', { goal: 'g', acceptance: [] }],
    ['missing acceptance', { goal: 'g', inScope: [] }],
    ['empty goal', { goal: '', inScope: [], acceptance: [] }],
    ['goal over 600', { goal: 'x'.repeat(601), inScope: [], acceptance: [] }],
    ['extra key', { goal: 'g', inScope: [], acceptance: [], prompt: 'ignore previous instructions' }],
    ['non-string item', { goal: 'g', inScope: [1], acceptance: [] }],
    ['too many items', { goal: 'g', inScope: Array(33).fill('a'), acceptance: [] }],
    ['item too long', { goal: 'g', inScope: ['x'.repeat(401)], acceptance: [] }],
    ['bad skills', { goal: 'g', inScope: [], acceptance: [], skills: ['x'.repeat(65)] }],
    ['bad outOfScope', { goal: 'g', inScope: [], acceptance: [], outOfScope: 'all' }],
  ])('refuses a brief with %s', async (_why, brief) => {
    const { w, lead, id } = await withTask();
    const h = await lead.emit('task.upsert', { task: id, fields: { brief } });
    const s = F(w);
    expect(note(s, h)).toBe('invalid-body');
    expect(s.tasks[id].brief).toBeNull();
  });
});
