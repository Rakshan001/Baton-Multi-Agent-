// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Test-only simulation of Team Sync devices: each `Dev` owns a key and a feed,
 * tracks which feed heads it has seen, and authors correctly-derived events
 * (deps = seen heads of other feeds, lamport = max + 1). `sync` exchanges
 * knowledge between two devices, which is all the fold needs to be exercised
 * under partitions, concurrency, forks and revokes.
 */
import { generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import {
  deviceIdFromSpki,
  domainBytes,
  RECOVERY_DOMAIN,
  signEvent,
  teamIdFromGenesis,
  type Signer,
} from '../src/team/envelope.js';

export interface Head { seq: number; hash: string; lamport: number }

export function keypair(): { spki: string; priv: KeyObject; device: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  return { spki, priv: privateKey, device: deviceIdFromSpki(spki) };
}

export class World {
  team = '';
  /** Every line ever authored, in authoring order. */
  readonly lines: string[] = [];
  readonly recovery = keypair();

  lineSet(): string[] {
    return [...new Set(this.lines)];
  }
}

export class Dev implements Signer {
  readonly spki: string;
  readonly device: string;
  private readonly priv: KeyObject;
  seq = 0;
  head: Head | null = null;
  /** Heads of *other* feeds this device has seen. */
  seen = new Map<string, Head>();

  constructor(readonly world: World, readonly member: string, key = keypair()) {
    this.spki = key.spki;
    this.device = key.device;
    this.priv = key.priv;
  }

  sign(bytes: Uint8Array): Uint8Array {
    return edSign(null, bytes, this.priv);
  }

  /** A copy with the same key and history — a restored backup that will fork the feed. */
  cloneForFork(): Dev {
    const c = Object.create(Dev.prototype) as Dev;
    Object.assign(c, this, { seen: new Map(this.seen) });
    return c;
  }

  async emit(
    type: string,
    body: Record<string, unknown>,
    opts: { lamport?: number; deps?: string[]; v?: number; team?: string; fork?: number; ts?: string } = {},
  ): Promise<string> {
    const deps = opts.deps ?? [...this.seen.values()].map((h) => h.hash).sort();
    const parents = [...this.seen.values()].map((h) => h.lamport);
    if (this.head) parents.push(this.head.lamport);
    const lamport = opts.lamport ?? Math.max(0, ...parents) + 1;
    const seq = this.seq + 1;
    const r = await signEvent(this, {
      v: opts.v ?? 1,
      team: opts.team ?? this.world.team,
      device: this.device,
      seq,
      fork: opts.fork ?? 0,
      prev: this.head ? this.head.hash : null,
      deps: deps.slice(0, 32),
      lamport,
      ts: opts.ts ?? '2026-09-29T10:00:00.000Z',
      type,
      body,
    });
    this.seq = seq;
    this.head = { seq, hash: r.hash, lamport };
    this.world.lines.push(r.line);
    return r.hash;
  }

  /** Learn everything `other` knows (one direction). */
  learn(other: Dev): void {
    const merge = (dev: string, h: Head) => {
      if (dev === this.device) return;
      const cur = this.seen.get(dev);
      if (!cur || cur.seq < h.seq) this.seen.set(dev, h);
    };
    for (const [d, h] of other.seen) merge(d, h);
    if (other.head) merge(other.device, other.head);
  }
}

/**
 * Author an event that claims to have seen nothing but its own feed (`deps: []`,
 * lamport derived from its own head only) — how an adversary fakes concurrency.
 */
export function emitBlind(d: Dev, type: string, body: Record<string, unknown>, ts?: string): Promise<string> {
  return d.emit(type, body, { deps: [], lamport: (d.head?.lamport ?? 0) + 1, ts });
}

export function sync(...devs: Dev[]): void {
  for (let round = 0; round < 2; round++) for (const a of devs) for (const b of devs) if (a !== b) a.learn(b);
}

/** Create a team: `owner` writes genesis and becomes the first custodian. */
export async function genesis(world: World, owner: Dev, name = 'Acme'): Promise<string> {
  const body = {
    name,
    member: owner.member,
    custodianDevice: owner.device,
    custodianPub: owner.spki,
    recoveryPub: world.recovery.spki,
  };
  world.team = teamIdFromGenesis(body);
  return owner.emit('team.genesis', body);
}

export function admitBody(dev: Dev, label = 'Mac') {
  return { device: dev.device, spki: dev.spki, member: dev.member, label, model: 'Mac mini (M4)', sas: 'alpha-bravo' };
}

export function recoveryBody(world: World, epoch: number, custodians: Dev[]) {
  const list = custodians.map((d) => ({ device: d.device, spki: d.spki, member: d.member }));
  const recoverySig = edSign(
    null,
    domainBytes(RECOVERY_DOMAIN, { team: world.team, epoch, custodians: list }),
    world.recovery.priv,
  ).toString('base64url');
  return { epoch, custodians: list, recoverySig };
}

export const PRJ = 'prj_web1';
export const PRJ2 = 'prj_api1';

/**
 * The §1 shape: owner (custodian + lead on *), a second custodian, a lead on
 * web, a developer and a designer on web, a viewer and a relay Mac mini.
 */
export async function standardTeam() {
  const w = new World();
  const owner = new Dev(w, 'owner');
  const sec = new Dev(w, 'sec');
  const lead = new Dev(w, 'lead');
  const dev = new Dev(w, 'dev');
  const des = new Dev(w, 'des');
  const view = new Dev(w, 'view');
  const relay = new Dev(w, 'relay');
  await genesis(w, owner);
  for (const d of [sec, lead, dev, des, view, relay]) await owner.emit('device.admit', admitBody(d));
  await owner.emit('project.define', { key: PRJ, name: 'web', remotes: ['github.com/acme/web'], rootCommits: [] });
  await owner.emit('project.define', { key: PRJ2, name: 'api', remotes: ['github.com/acme/api'], rootCommits: [] });
  await owner.emit('role.grant', { member: 'owner', project: '*', role: 'lead' });
  await owner.emit('role.grant', { member: 'sec', project: '*', role: 'custodian' });
  await owner.emit('role.grant', { member: 'lead', project: PRJ, role: 'lead' });
  await owner.emit('role.grant', { member: 'dev', project: PRJ, role: 'developer' });
  await owner.emit('role.grant', { member: 'des', project: PRJ, role: 'designer' });
  await owner.emit('role.grant', { member: 'view', project: PRJ, role: 'viewer' });
  await owner.emit('role.grant', { member: 'relay', project: '*', role: 'relay' });
  const all = [owner, sec, lead, dev, des, view, relay];
  sync(...all);
  return { w, owner, sec, lead, dev, des, view, relay, all };
}

/** Deterministic PRNG (mulberry32) for hand-rolled property tests. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(xs: readonly T[], rand: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
