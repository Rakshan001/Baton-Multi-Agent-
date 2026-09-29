// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Regression tests for the second-pass Team Sync security review (C1, H1–H4,
 * M1, remote case). Each is built from the matching r2-* proof.
 */
import { describe, it, expect } from 'vitest';
import { sign as edSign } from 'node:crypto';
import { fold } from '../src/team/fold.js';
import { canonicalize } from '../src/team/canonical.js';
import {
  RECOVERY_DOMAIN, decodeEvent, domainBytes, isCanonicalBase64url, makeForkProof, sha256Hex, verifyDetached, verifyEvent,
} from '../src/team/envelope.js';
import type { TeamState } from '../src/team/types.js';
import { Dev, World, admitBody, emitBlind, genesis, recoveryBody, standardTeam, sync, PRJ } from './team-helpers.js';

const F = (w: World) => fold({ team: w.team, lines: w.lineSet() });
const note = (s: TeamState, hash: string) =>
  s.unauthorized.find((n) => n.hash === hash)?.reason ?? s.rejected.find((n) => n.hash === hash)?.reason;
const cut = (d: Dev) => ({ device: d.device, cutoffSeq: d.head?.seq ?? 0, cutoffHash: d.head?.hash ?? null });

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** Same bytes, different spelling: flip a spare low bit of the last base64url character. */
const respell = (s: string) => s.slice(0, -1) + B64[B64.indexOf(s[s.length - 1]) ^ 1];

describe('C1 (critical): signatures and keys have one spelling', () => {
  it('a re-spelled signature is not a second event, so it cannot fake a fork of genesis (r2-malleable)', async () => {
    const { w, owner } = await standardTeam();
    const id = `${owner.device}-${owner.seq + 1}`;
    await owner.emit('task.upsert', { task: id, fields: { project: PRJ, title: 'T' } });
    const gLine = w.lines[0];
    const ev = JSON.parse(gLine);
    const mutated = canonicalize({ ...ev, sig: respell(ev.sig) });
    expect(mutated).not.toBe(gLine);
    expect(Buffer.from(ev.sig, 'base64url').equals(Buffer.from(respell(ev.sig), 'base64url'))).toBe(true);
    expect(() => decodeEvent(mutated)).toThrow(/canonical/);
    expect(() => makeForkProof(gLine, mutated)).toThrow();
    const before = F(w);
    const after = fold({ team: w.team, lines: [...w.lineSet(), mutated] });
    expect(after.org.forks).toEqual({});
    expect(after.org.genesis).toBe(before.org.genesis);
    expect(Object.keys(after.tasks)).toEqual([id]);
    expect(after.rejected.map((r) => r.reason)).toEqual(['malformed']);
  });

  it('verifyEvent and verifyDetached refuse a non-canonical signature', async () => {
    const { w, owner } = await standardTeam();
    const e = decodeEvent(w.lines[0]).event;
    expect(verifyEvent(e, owner.spki)).toBe(true);
    expect(verifyEvent({ ...e, sig: respell(e.sig) }, owner.spki)).toBe(false);
    const stmt = { team: w.team, epoch: 1, custodians: [] };
    const sig = edSign(null, domainBytes(RECOVERY_DOMAIN, stmt), w.recovery.priv).toString('base64url');
    expect(verifyDetached(RECOVERY_DOMAIN, stmt, sig, w.recovery.spki)).toBe(true);
    expect(verifyDetached(RECOVERY_DOMAIN, stmt, respell(sig), w.recovery.spki)).toBe(false);
    expect(verifyDetached(RECOVERY_DOMAIN, stmt, sig, respell(w.recovery.spki))).toBe(false);
  });

  it('a re-spelled SPKI is refused, and a re-spelled recovery signature restores nothing', async () => {
    const { w, owner, sec, all } = await standardTeam();
    const x = new Dev(w, 'x');
    const alt = respell(x.spki);
    expect(isCanonicalBase64url(x.spki)).toBe(true);
    expect(isCanonicalBase64url(alt)).toBe(false);
    const cO = cut(owner);
    const cS = cut(sec);
    const admit = await owner.emit('device.admit', { ...admitBody(x), spki: alt });
    await owner.emit('device.revoke', cS);
    await sec.emit('device.revoke', cO);
    sync(...all);
    const fresh = new Dev(w, 'owner');
    const R = recoveryBody(w, 1, [fresh]);
    const bad = await all[2].emit('recovery.restore', { ...R, recoverySig: respell(R.recoverySig) });
    const s = F(w);
    expect(note(s, admit)).toBe('device-not-id-of-spki');
    expect(note(s, bad)).toBe('bad-recovery-signature');
    expect(s.org.recoveryMode).toBe(true);
  });
});

describe('H1: a thief\'s voided revoke no longer disables honest revokes (r2-ban)', () => {
  it('the honest self-member revoke survives the thief\'s revoke that tried to cut it off', async () => {
    const { w, owner, dev, all } = await standardTeam();
    const phone = new Dev(w, 'owner'); // owner's second device, later stolen
    const dev2 = new Dev(w, 'dev'); // dev's second device, later lost
    await owner.emit('device.admit', admitBody(phone));
    await owner.emit('device.admit', admitBody(dev2));
    sync(...all, phone, dev2);
    const p1 = await phone.emit('member.profile', { name: 'o', jobRole: 'x', timezone: 'UTC' });
    const d1 = await dev.emit('member.profile', { name: 'd', jobRole: 'x', timezone: 'UTC' });
    sync(...all, phone, dev2);
    const rA = await owner.emit('device.revoke', { device: phone.device, cutoffSeq: 1, cutoffHash: p1 });
    const r3 = await dev.emit('device.revoke', { device: dev2.device, cutoffSeq: 0, cutoffHash: null });
    sync(dev, phone);
    const r2 = await phone.emit('device.revoke', { device: dev.device, cutoffSeq: 1, cutoffHash: d1 }, { deps: [dev.head!.hash], lamport: dev.head!.lamport + 1 });
    const s = F(w);
    expect(note(s, rA)).toBeUndefined();
    expect(s.voided).toContain(r2);
    expect(s.voided).not.toContain(r3);
    expect(note(s, r3)).toBeUndefined();
    expect(s.org.devices[dev2.device].cutoffSeq).toBe(0);
    expect(s.org.devices[dev.device].cutoffSeq).toBeNull();
  });
});

describe('H2: recovery can\'t be blocked by grinding', () => {
  it('re-spelled recovery signatures never compete (r2-grind)', async () => {
    for (let trial = 0; trial < 4; trial++) {
      const w = new World();
      const o = new Dev(w, 'owner');
      const a = new Dev(w, 'alice');
      const v = new Dev(w, 'view');
      await genesis(w, o);
      await o.emit('device.admit', admitBody(v));
      sync(o, v);
      await v.emit('member.profile', { name: 'v', jobRole: 'x', timezone: 'UTC' });
      await o.emit('device.revoke', cut(o));
      sync(o, a);
      const R1 = recoveryBody(w, 1, [a]);
      await a.emit('recovery.restore', R1);
      for (let x = 0; x < 16; x++) {
        const sig = R1.recoverySig.slice(0, 85) + B64[(B64.indexOf(R1.recoverySig[85]) & ~15) | x];
        if (sig !== R1.recoverySig) await emitBlind(v, 'recovery.restore', { ...R1, recoverySig: sig });
      }
      const s = F(w);
      expect(s.org.recoveryMode).toBe(false);
      expect(s.org.custodians).toEqual([a.device]);
    }
  });

  it('the epoch goes to the lowest statement CONTENT hash among restores that are otherwise valid', async () => {
    const w = new World();
    const o = new Dev(w, 'owner');
    const v = new Dev(w, 'view');
    const lead = new Dev(w, 'lead');
    await genesis(w, o);
    await o.emit('device.admit', admitBody(v));
    await o.emit('device.admit', admitBody(lead));
    sync(o, v, lead);
    await v.emit('member.profile', { name: 'v', jobRole: 'x', timezone: 'UTC' }); // v's past: not in recovery
    await o.emit('device.revoke', cut(o));
    sync(o, lead);
    const content = (b: { epoch: number; custodians: unknown }) => sha256Hex(canonicalize({ team: w.team, epoch: b.epoch, custodians: b.custodians }));
    const honest = new Dev(w, 'alice');
    const R1 = recoveryBody(w, 1, [honest]);
    // a second, lower-content statement for the same epoch, used where the team is NOT in recovery
    let R2 = recoveryBody(w, 1, [new Dev(w, 'mallory')]);
    while (content(R2) >= content(R1)) R2 = recoveryBody(w, 1, [new Dev(w, 'mallory')]);
    const r1 = await lead.emit('recovery.restore', R1);
    const r2 = await v.emit('recovery.restore', R2);
    let s = F(w);
    expect(note(s, r2)).toBe('not-in-recovery');
    expect(note(s, r1)).toBeUndefined();
    expect(s.org.custodians).toEqual([honest.device]);
    // Both valid (in recovery) and concurrent: the lower CONTENT hash wins, whatever the
    // event hashes or fold order. `lead` saw only the revoke; `other` authors R2 too.
    const w2 = new World();
    const o2 = new Dev(w2, 'owner');
    const x = new Dev(w2, 'x');
    const y = new Dev(w2, 'y');
    await genesis(w2, o2);
    await o2.emit('device.admit', admitBody(x));
    await o2.emit('device.admit', admitBody(y));
    await o2.emit('device.revoke', cut(o2));
    sync(o2, x, y);
    const c2 = (b: { epoch: number; custodians: unknown }) => sha256Hex(canonicalize({ team: w2.team, epoch: b.epoch, custodians: b.custodians }));
    const S1 = recoveryBody(w2, 1, [new Dev(w2, 'p')]);
    const S2 = recoveryBody(w2, 1, [new Dev(w2, 'q')]);
    const hx = await x.emit('recovery.restore', S1);
    const hy = await y.emit('recovery.restore', S2);
    const s2 = fold({ team: w2.team, lines: w2.lineSet() });
    const [win, lose] = c2(S1) < c2(S2) ? [hx, hy] : [hy, hx];
    expect(note(s2, win)).toBeUndefined();
    expect(note(s2, lose)).toBe('superseded-epoch');
    expect(s2.org.custodians).toHaveLength(1);
  });
});

describe('H3: key learning is not cubic on an admit chain (r2-chain)', () => {
  it('a 400-device admit chain folds well under a second', async () => {
    const N = 400;
    const w = new World();
    let cur = new Dev(w, 'owner');
    await genesis(w, cur);
    let prev: string | null = null;
    for (let i = 0; i < N; i++) {
      const nx = new Dev(w, 'owner');
      await cur.emit('device.admit', admitBody(nx), { deps: prev ? [prev] : [] });
      prev = cur.head!.hash;
      nx.seen = new Map([[cur.device, cur.head!]]);
      cur = nx;
    }
    const lines = w.lineSet();
    const t = performance.now();
    const s = fold({ team: w.team, lines });
    const ms = performance.now() - t;
    expect(Object.keys(s.org.devices)).toHaveLength(N + 1);
    expect(ms).toBeLessThan(1000); // ~110 ms locally; was cubic (one full refold per learned key)
  }, 30_000);
});

/** A recovery-key vote on removing `target` (a device, or a member for role.revoke). */
function vote(w: World, action: 'device.revoke' | 'role.revoke', target: string, nonce: string) {
  const sig = edSign(null, domainBytes(RECOVERY_DOMAIN, { team: w.team, action, target, nonce }), w.recovery.priv).toString('base64url');
  return { nonce, sig };
}

describe('H4: the recovery key breaks a two-custodian deadlock', () => {
  it('the honest custodian plus the recovery key remove the thief; the thief alone cannot remove the honest one', async () => {
    const { w, owner, sec, all } = await standardTeam();
    const trusted = cut(sec);
    const ownerSeen = cut(owner);
    // sec's key is stolen. Alone, neither side can remove the other:
    const solo = await owner.emit('device.revoke', trusted);
    sync(owner, sec); // not concurrent: each is a lone attempt, not a mutual pair
    const thiefSolo = await sec.emit('device.revoke', ownerSeen);
    const thiefRole = await sec.emit('role.revoke', { member: 'owner', project: '*', role: 'custodian' });
    // a vote for another target, or a forged vote, does not help the thief
    const stolenVote = vote(w, 'device.revoke', sec.device, 'nonce-0001');
    const misuse = await sec.emit('device.revoke', { ...ownerSeen, recovery: stolenVote });
    let s = F(w);
    for (const h of [solo, thiefSolo, thiefRole, misuse]) expect(note(s, h)).toBe('needs-quorum');
    expect(s.org.custodians).toEqual([owner.device, sec.device].sort());
    // with the recovery key as the second vote, owner removes the thief — and a concurrent
    // counter-revoke by the thief is NOT a mutual pair against a key-backed revoke
    const rv = await owner.emit('device.revoke', { ...trusted, recovery: vote(w, 'device.revoke', sec.device, 'nonce-0002') });
    const counter = await emitBlind(sec, 'device.revoke', { device: owner.device, cutoffSeq: 0, cutoffHash: null });
    const demote = await owner.emit('role.revoke', { member: 'sec', project: '*', role: 'custodian', recovery: vote(w, 'role.revoke', 'sec', 'nonce-0003') });
    s = F(w);
    expect(note(s, rv)).toBeUndefined();
    expect(note(s, demote)).toBeUndefined();
    expect(s.voided).toContain(counter);
    expect(s.org.custodians).toEqual([owner.device]);
    expect(s.org.members.sec.roles).not.toContain('*:custodian');
    expect(s.org.recoveryMode).toBe(false);
    sync(...all);
  });

  it('each recovery vote counts once', async () => {
    const { w, owner, sec, all } = await standardTeam();
    const sec2 = new Dev(w, 'sec');
    await owner.emit('device.admit', admitBody(sec2));
    sync(...all, sec2);
    const v = vote(w, 'device.revoke', sec.device, 'nonce-once');
    const first = await owner.emit('device.revoke', { ...cut(sec), recovery: v });
    const again = await owner.emit('device.revoke', { ...cut(sec), recovery: v });
    const other = await owner.emit('device.revoke', { ...cut(sec2), recovery: v }); // wrong target
    const s = F(w);
    expect(note(s, first)).toBeUndefined();
    expect(note(s, again)).toBe('recovery-vote-used');
    expect(note(s, other)).toBe('needs-quorum');
  });
});

describe('M1: a single-custodian restore is not stuck behind dead custodians', () => {
  it('restore strips unlisted custodians; the restored custodian can then add and demote custodians', async () => {
    const { w, owner, sec, lead, dev, all } = await standardTeam();
    const cO = cut(owner);
    const cS = cut(sec);
    await owner.emit('device.revoke', cS);
    await sec.emit('device.revoke', cO);
    sync(...all);
    const fresh = new Dev(w, 'boss');
    await lead.emit('recovery.restore', recoveryBody(w, 1, [fresh]));
    sync(lead, fresh);
    let s = F(w);
    expect(s.org.members.owner.roles).not.toContain('*:custodian');
    expect(s.org.members.sec.roles).not.toContain('*:custodian');
    const g = await fresh.emit('role.grant', { member: 'lead', project: '*', role: 'custodian' });
    sync(fresh, lead, dev);
    const p = await fresh.emit('role.proposal', { action: 'grant', member: 'dev', role: 'custodian' });
    sync(fresh, lead);
    await lead.emit('role.cosign', { proposal: p });
    sync(fresh, lead);
    const d = await fresh.emit('role.proposal', { action: 'revoke', member: 'lead', role: 'custodian' });
    sync(fresh, dev);
    await dev.emit('role.cosign', { proposal: d });
    s = F(w);
    expect(note(s, g)).toBeUndefined();
    expect(s.org.members.dev.roles).toContain('*:custodian');
    expect(s.org.members.lead.roles).not.toContain('*:custodian');
    expect(s.org.members.boss.roles).toContain('*:custodian');
  });
});

describe('remote uniqueness is case-insensitive on github.com, gitlab.com and bitbucket.org', () => {
  it('Acme/Web2 and acme/web2 collide on github.com but not on other hosts', async () => {
    const { w, owner } = await standardTeam();
    const a = await owner.emit('project.define', { key: 'prj_aaa1', name: 'a', remotes: ['https://github.com/Acme/Web2'], rootCommits: [] });
    const b = await owner.emit('project.define', { key: 'prj_bbb1', name: 'b', remotes: ['git@github.com:acme/web2.git'], rootCommits: [] });
    const c = await owner.emit('project.define', { key: 'prj_ccc1', name: 'c', remotes: ['https://git.example.com/Acme/x'], rootCommits: [] });
    const d = await owner.emit('project.define', { key: 'prj_ddd1', name: 'd', remotes: ['https://git.example.com/acme/x'], rootCommits: [] });
    const s = F(w);
    expect(note(s, a)).toBeUndefined();
    expect(note(s, b)).toBe('remote-claimed');
    expect(note(s, c)).toBeUndefined();
    expect(note(s, d)).toBeUndefined();
    expect(s.org.projects.prj_aaa1.remotes).toEqual(['github.com/Acme/Web2']); // stored case is kept
  });
});
