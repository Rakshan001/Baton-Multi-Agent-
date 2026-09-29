// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Regression tests for the Team Sync feed/envelope security review:
 * cross-team feed poisoning (finding 5), forged truncation (C6), the fork
 * counter, and the pre-parse line cap (finding 8).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { Feed, FeedError } from '../src/team/feed.js';
import {
  EnvelopeError, MAX_LINE_BYTES, decodeEvent, deviceIdFromSpki, makeForkProof, signEvent, verifyEvent, verifyForkProof,
  type ForkProof, type Signer, type TeamEvent,
} from '../src/team/envelope.js';

const TEAM_A = 'a'.repeat(64);
const TEAM_B = 'b'.repeat(64);

function keySigner(): Signer & { device: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  return { spki, device: deviceIdFromSpki(spki), sign: (b: Uint8Array) => edSign(null, b, privateKey) };
}

async function chain(s: Signer & { device: string }, n: number, o: { team?: string; tag?: string; fork?: number; from?: { seq: number; hash: string } } = {}) {
  const out: { line: string; hash: string }[] = [];
  let prev: string | null = o.from?.hash ?? null;
  for (let seq = (o.from?.seq ?? 0) + 1; out.length < n; seq++) {
    const r = await signEvent(s, {
      v: 1, team: o.team ?? TEAM_A, device: s.device, seq, fork: o.fork ?? 0, prev, deps: [], lamport: seq,
      ts: '2026-09-29T10:00:00.000Z', type: 'member.profile', body: { name: `${o.tag ?? 'x'}${seq}` },
    });
    out.push(r);
    prev = r.hash;
  }
  return out;
}

const opts = (s: Signer, team = TEAM_A) => ({ team, verify: (ev: TeamEvent) => verifyEvent(ev, s.spki) });

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'baton-feedsec-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('finding 5: a feed is bound to its team (poc-feed)', () => {
  it('a line of another team signed by the same key is refused, not taken as a fork', async () => {
    const s = keySigner();
    const a = await chain(s, 2);
    const b = await chain(s, 1, { team: TEAM_B });
    const f = Feed.open(dir, s.device, opts(s));
    for (const e of a) f.append(e.line);
    expect(f.ingest(b[0].line)).toEqual({ status: 'invalid', reason: 'event belongs to another team' });
    expect(() => f.append(b[0].line)).toThrow(/another team/);
    expect(f.frozen).toBe(false);
    expect(f.entries()).toHaveLength(2);
    f.close();
  });

  it('on load, a line of another team ends the chain', async () => {
    const s = keySigner();
    const b = await chain(s, 1, { team: TEAM_B });
    writeFileSync(join(dir, `${s.device}.jsonl`), b[0].line + '\n');
    const f = Feed.open(dir, s.device, opts(s));
    expect(f.entries()).toHaveLength(0);
    expect(f.dropped).toBe(1);
    f.close();
  });

  it('fork proofs need the same team; a differing fork counter is still equivocation (C2)', async () => {
    const s = keySigner();
    const [a] = await chain(s, 1);
    const [b] = await chain(s, 1, { team: TEAM_B });
    const [c] = await chain(s, 1, { fork: 1, tag: 'c' });
    expect(() => makeForkProof(a.line, b.line)).toThrow(EnvelopeError);
    const [x, y] = [a, b].sort((p, q) => (p.hash < q.hash ? -1 : 1));
    expect(verifyForkProof({ type: 'fork.proof', device: s.device, seq: 1, eventA: x.line, eventB: y.line }, s.spki)).toBe(false);
    const refork = makeForkProof(a.line, c.line);
    expect(verifyForkProof(refork, s.spki, TEAM_A)).toBe(true);
    expect(verifyForkProof(refork, s.spki, TEAM_B)).toBe(false);
  });

  it('a second event at a held seq with a higher or lower fork counter yields a fork proof (C2)', async () => {
    const s = keySigner();
    const base = await chain(s, 2);
    const re = await chain(s, 1, { fork: 1, tag: 'r', from: { seq: 1, hash: base[0].hash } });
    const f = Feed.open(dir, s.device, opts(s));
    for (const e of base) f.append(e.line);
    const r = f.ingest(re[0].line);
    if (r.status !== 'fork') throw new Error(`expected fork, got ${r.status}`);
    expect(verifyForkProof(r.proof, s.spki, TEAM_A)).toBe(true);
    f.freeze(r.proof);
    expect(f.head()?.seq).toBe(1);
    f.close();
    const d2 = mkdtempSync(join(tmpdir(), 'baton-feedsec2-'));
    try {
      const h = Feed.open(d2, s.device, opts(s));
      h.append(base[0].line);
      h.append(re[0].line);
      expect(h.ingest(base[1].line).status).toBe('fork');
      h.close();
    } finally {
      rmSync(d2, { recursive: true, force: true });
    }
  });
});

describe('C6: a forged line or proof cannot truncate real history', () => {
  it('Feed.open requires a team and a verifier', () => {
    const s = keySigner();
    expect(() => Feed.open(dir, s.device, undefined as never)).toThrow(FeedError);
    expect(() => Feed.open(dir, s.device, { team: TEAM_A } as never)).toThrow(FeedError);
    expect(() => Feed.open(dir, s.device, { verify: () => true } as never)).toThrow(FeedError);
  });

  it('a line signed by another key is refused before any fork check', async () => {
    const s = keySigner();
    const evil = keySigner();
    const real = await chain(s, 2);
    const f = Feed.open(dir, s.device, opts(s));
    for (const e of real) f.append(e.line);
    // same device id claimed, wrong key
    const forged = (await chain(evil, 1))[0].line.replace(evil.device, s.device);
    expect(f.ingest(forged).status).toBe('invalid');
    expect(f.frozen).toBe(false);
    expect(f.entries()).toHaveLength(2);
    f.close();
  });

  it('freeze refuses a proof it cannot verify', async () => {
    const s = keySigner();
    const evil = keySigner();
    const real = await chain(s, 3);
    const f = Feed.open(dir, s.device, opts(s));
    for (const e of real) f.append(e.line);
    const fake = (await chain(evil, 1))[0].line;
    const forged: ForkProof = { type: 'fork.proof', device: s.device, seq: 1, eventA: real[0].line, eventB: fake };
    expect(() => f.freeze(forged)).toThrow(/does not verify/);
    // A genuine proof about ANOTHER device's key signed events is refused too.
    const e1 = await chain(evil, 1, { tag: 'p' });
    const e2 = await chain(evil, 1, { tag: 'q' });
    expect(() => f.freeze({ ...makeForkProof(e1[0].line, e2[0].line), device: s.device })).toThrow(FeedError);
    expect(f.frozen).toBe(false);
    expect(f.entries()).toHaveLength(3);
    f.close();
    expect(readFileSync(join(dir, `${s.device}.jsonl`), 'utf8')).toBe(real.map((e) => e.line + '\n').join(''));
  });

  it('a planted .fork.json that does not verify is ignored on load', async () => {
    const s = keySigner();
    const real = await chain(s, 3);
    const f = Feed.open(dir, s.device, opts(s));
    for (const e of real) f.append(e.line);
    f.close();
    writeFileSync(join(dir, `${s.device}.fork.json`), JSON.stringify({ type: 'fork.proof', device: s.device, seq: 1, eventA: 'x', eventB: 'y' }));
    const g = Feed.open(dir, s.device, opts(s));
    expect(g.frozen).toBe(false);
    expect(g.entries()).toHaveLength(3);
    g.close();
  });

  it('a genuine proof still freezes and survives a restart', async () => {
    const s = keySigner();
    const real = await chain(s, 3);
    const alt = await chain(s, 3, { tag: 'alt' });
    const f = Feed.open(dir, s.device, opts(s));
    for (const e of real) f.append(e.line);
    const r = f.ingest(alt[1].line);
    if (r.status !== 'fork') throw new Error(`expected fork, got ${r.status}`);
    f.freeze(r.proof);
    f.close();
    const g = Feed.open(dir, s.device, opts(s));
    expect(g.frozen).toBe(true);
    expect(g.head()?.seq).toBe(1);
    g.close();
  });
});

describe('finding 8: line size is capped before parsing', () => {
  it('decodeEvent refuses a line over 1 MiB without parsing it', () => {
    const huge = '{"a":"' + 'x'.repeat(MAX_LINE_BYTES) + '"}';
    expect(() => decodeEvent(huge)).toThrow(/exceeds/);
    // multi-byte characters count in bytes
    const wide = '"' + 'é'.repeat(MAX_LINE_BYTES / 2 + 1) + '"';
    expect(() => decodeEvent(wide)).toThrow(/exceeds/);
  });

  it('the feed load path applies the same cap', async () => {
    const s = keySigner();
    const real = await chain(s, 1);
    writeFileSync(join(dir, `${s.device}.jsonl`), real[0].line + '\n' + 'x'.repeat(MAX_LINE_BYTES + 1) + '\n');
    const f = Feed.open(dir, s.device, opts(s));
    expect(f.entries()).toHaveLength(1);
    expect(f.dropped).toBe(1);
    f.close();
  });
});
