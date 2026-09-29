// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Team Sync §9 and §12.5: the per-device append-only feed.
 *
 * Stored bytes are the exact signed lines; the chain is re-verified on load and
 * a torn tail (power loss mid-write) is dropped; a second event at an existing
 * seq yields a fork.proof and freezes the feed at the common prefix; ids that
 * fail the regex never reach the filesystem.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, appendFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { Feed, FeedError } from '../src/team/feed.js';
import { deviceIdFromSpki, signEvent, verifyEvent, verifyForkProof, type Signer, type TeamEvent } from '../src/team/envelope.js';

const TEAM = 'a'.repeat(64);

function keySigner(): Signer & { device: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  return { spki, device: deviceIdFromSpki(spki), sign: (b: Uint8Array) => edSign(null, b, privateKey) };
}

async function chain(s: Signer & { device: string }, n: number, tag = 'x') {
  const out: { line: string; hash: string }[] = [];
  let prev: string | null = null;
  for (let seq = 1; seq <= n; seq++) {
    const r = await signEvent(s, {
      v: 1, team: TEAM, device: s.device, seq, fork: 0, prev, deps: [], lamport: seq,
      ts: '2026-09-29T10:00:00.000Z', type: 'member.profile', body: { name: `${tag}${seq}` },
    });
    out.push(r);
    prev = r.hash;
  }
  return out;
}

/** The options every feed now requires: its team, and the device's signature check. */
const opts = (s: Signer) => ({ team: TEAM, verify: (ev: TeamEvent) => verifyEvent(ev, s.spki) });

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'baton-feed-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('Feed', () => {
  it('appends exact signed lines and reloads the chain', async () => {
    const s = keySigner();
    const evs = await chain(s, 3);
    const f = Feed.open(dir, s.device, opts(s));
    for (const e of evs) f.append(e.line);
    expect(f.head()).toMatchObject({ seq: 3, hash: evs[2].hash });
    f.close();
    expect(readFileSync(join(dir, `${s.device}.jsonl`), 'utf8')).toBe(evs.map((e) => e.line + '\n').join(''));
    const g = Feed.open(dir, s.device, opts(s));
    expect(g.entries().map((e) => e.hash)).toEqual(evs.map((e) => e.hash));
    expect(g.dropped).toBe(0);
    g.close();
  });

  it('refuses out-of-order, wrong-device and broken-chain appends', async () => {
    const s = keySigner();
    const other = keySigner();
    const evs = await chain(s, 3);
    const f = Feed.open(dir, s.device, opts(s));
    expect(() => f.append(evs[1].line)).toThrow(FeedError);
    f.append(evs[0].line);
    const foreign = (await chain(other, 1))[0].line;
    expect(() => f.append(foreign)).toThrow(/device/);
    const alt = await chain(s, 2, 'alt');
    expect(() => f.append(alt[1].line)).toThrow(/prev/);
    f.close();
  });

  it('drops a torn tail on load and keeps appending after it', async () => {
    const s = keySigner();
    const evs = await chain(s, 4);
    const f = Feed.open(dir, s.device, opts(s));
    for (const e of evs.slice(0, 3)) f.append(e.line);
    f.close();
    appendFileSync(join(dir, `${s.device}.jsonl`), evs[3].line.slice(0, 40)); // power loss mid-write
    const g = Feed.open(dir, s.device, opts(s));
    expect(g.head()?.seq).toBe(3);
    expect(g.dropped).toBe(1);
    g.append(evs[3].line);
    g.close();
    const h = Feed.open(dir, s.device, opts(s));
    expect(h.head()?.seq).toBe(4);
    expect(h.dropped).toBe(0);
    h.close();
  });

  it('drops from the first line whose signature or chain fails', async () => {
    const s = keySigner();
    const evs = await chain(s, 3);
    const bogus = evs[1].line.replace('"x2"', '"xx"');
    writeFileSync(join(dir, `${s.device}.jsonl`), [evs[0].line, bogus, evs[2].line].join('\n') + '\n');
    const g = Feed.open(dir, s.device, opts(s));
    expect(g.head()?.seq).toBe(1);
    expect(g.dropped).toBe(2);
    g.close();
  });

  it('ingest reports duplicate, gap, and fork with a verifiable proof; then freezes', async () => {
    const s = keySigner();
    const evs = await chain(s, 3);
    const alt = await chain(s, 3, 'alt');
    const f = Feed.open(dir, s.device, opts(s));
    expect(f.ingest(evs[0].line).status).toBe('appended');
    expect(f.ingest(evs[0].line).status).toBe('duplicate');
    expect(f.ingest(evs[2].line).status).toBe('gap');
    expect(f.ingest(evs[1].line).status).toBe('appended');
    const r = f.ingest(alt[1].line);
    expect(r.status).toBe('fork');
    if (r.status !== 'fork') throw new Error('unreachable');
    expect(r.proof.seq).toBe(2);
    expect(verifyForkProof(r.proof, s.spki)).toBe(true);
    f.freeze(r.proof);
    expect(f.head()?.seq).toBe(1); // common prefix
    expect(f.frozen).toBe(true);
    expect(f.ingest(evs[2].line).status).toBe('frozen');
    expect(() => f.append(evs[1].line)).toThrow(/frozen/);
    f.close();
    const g = Feed.open(dir, s.device, opts(s));
    expect(g.frozen).toBe(true);
    expect(g.head()?.seq).toBe(1);
    g.close();
  });

  it('never touches the filesystem for an id that fails the regex', () => {
    for (const bad of ['../evil', 'AAAAAAAAAAAAAAAA', 'aaaa', 'aaaaaaaaaaaaaaa1', 'aaaaaaaaaaaaaaaa/x']) {
      expect(() => Feed.open(dir, bad, { team: TEAM, verify: () => true })).toThrow(FeedError);
    }
    expect(existsSync(join(dir, '..', 'evil.jsonl'))).toBe(false);
  });

  it('refuses to follow a symlinked feed file (O_NOFOLLOW)', () => {
    const s = keySigner();
    const target = join(dir, 'elsewhere.txt');
    writeFileSync(target, '');
    symlinkSync(target, join(dir, `${s.device}.jsonl`));
    expect(() => Feed.open(dir, s.device, opts(s))).toThrow();
  });
});
