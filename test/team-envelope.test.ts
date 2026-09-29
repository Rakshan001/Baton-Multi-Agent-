// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Team Sync §6.1: canonical bytes, the signed envelope, and derived lamport.
 *
 * The exact signed line is what every device stores, hashes and relays, so a
 * second valid encoding of the same event must be impossible (S-M2), and a
 * self-chosen lamport must never be accepted (S-C1).
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { canonicalize, parseStrict, CanonicalError } from '../src/team/canonical.js';
import {
  checkCausal,
  decodeEvent,
  deviceIdFromSpki,
  signEvent,
  signingBytes,
  verifyEvent,
  eventHash,
  makeForkProof,
  verifyForkProof,
  type Signer,
  type UnsignedEvent,
} from '../src/team/envelope.js';

function keySigner(): Signer & { device: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  return {
    spki,
    device: deviceIdFromSpki(spki),
    sign: (bytes: Uint8Array) => edSign(null, bytes, privateKey),
  };
}

const TEAM = 'a'.repeat(64);

function draft(device: string, over: Partial<UnsignedEvent> = {}): UnsignedEvent {
  return {
    v: 1, team: TEAM, device, seq: 1, fork: 0, prev: null, deps: [], lamport: 1,
    ts: '2026-09-29T10:00:00.000Z', type: 'member.profile', body: { name: 'Priya' },
    ...over,
  };
}

describe('canonical JSON (RFC 8785 JCS)', () => {
  it('sorts keys by UTF-16 code units and drops whitespace', () => {
    expect(canonicalize({ b: 1, a: [true, null, 'x'], '\u00e9': 0, Z: 2 }))
      .toBe('{"Z":2,"a":[true,null,"x"],"b":1,"\u00e9":0}');
  });

  it('serialises numbers the ECMAScript way', () => {
    expect(canonicalize([1e21, 1e-7, -0, 0.1, 100, 1.5e300])).toBe('[1e+21,1e-7,0,0.1,100,1.5e+300]');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalize({ n: NaN })).toThrow(CanonicalError);
    expect(() => canonicalize({ n: Infinity })).toThrow(CanonicalError);
  });

  it('rejects non-NFC strings in values and keys', () => {
    const decomposed = 'e\u0301'; // é as e + combining acute
    expect(() => canonicalize({ s: decomposed })).toThrow(/NFC/);
    expect(() => canonicalize({ [decomposed]: 1 })).toThrow(/NFC/);
  });

  it('rejects lone surrogates, undefined, bigint and functions', () => {
    expect(() => canonicalize('\ud800')).toThrow(CanonicalError);
    expect(() => canonicalize({ a: undefined })).toThrow(CanonicalError);
    expect(() => canonicalize(1n)).toThrow(CanonicalError);
    expect(() => canonicalize({ f: () => 1 })).toThrow(CanonicalError);
  });

  it('parseStrict rejects duplicate keys that JSON.parse silently merges', () => {
    expect(JSON.parse('{"a":1,"a":2}')).toEqual({ a: 2 });
    expect(() => parseStrict('{"a":1,"a":2}')).toThrow(/duplicate/);
    expect(() => parseStrict('{"x":{"a":1,"\\u0061":2}}')).toThrow(/duplicate/);
  });

  it('parseStrict rejects non-NFC, overflow numbers, trailing garbage and deep nesting', () => {
    expect(() => parseStrict('"e\u0301"')).toThrow(/NFC/);
    expect(() => parseStrict('1e400')).toThrow(CanonicalError);
    expect(() => parseStrict('{} x')).toThrow(CanonicalError);
    expect(() => parseStrict('[01]')).toThrow(CanonicalError);
    const deep = '['.repeat(17) + ']'.repeat(17);
    expect(() => parseStrict(deep)).toThrow(/depth/);
    expect(parseStrict('['.repeat(16) + ']'.repeat(16))).toBeDefined();
  });

  it('round-trips parseStrict → canonicalize', () => {
    const text = '{"a":[1,2.5,"\\u00e9\\n"],"b":{"c":null}}';
    expect(canonicalize(parseStrict(text))).toBe('{"a":[1,2.5,"\u00e9\\n"],"b":{"c":null}}');
  });
});

describe('TeamEvent envelope', () => {
  it('derives a 16-char base32 device id from the spki', () => {
    const s = keySigner();
    expect(s.device).toMatch(/^[a-z2-7]{16}$/);
  });

  it('signs with the domain-separated prefix and verifies', async () => {
    const s = keySigner();
    const { line, event } = await signEvent(s, draft(s.device));
    const bytes = signingBytes(draft(s.device));
    expect(bytes.subarray(0, 15).toString('latin1')).toBe('baton/v1/event\0');
    const decoded = decodeEvent(line);
    expect(decoded.event).toEqual(event);
    expect(decoded.hash).toBe(eventHash(line));
    expect(verifyEvent(decoded.event, s.spki)).toBe(true);
  });

  it('a signature without the domain prefix does not verify', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
    const device = deviceIdFromSpki(spki);
    const d = draft(device);
    const raw = Buffer.from(canonicalize(d as unknown as Record<string, unknown>));
    const sig = edSign(null, raw, privateKey).toString('base64url');
    expect(verifyEvent({ ...d, sig }, spki)).toBe(false);
  });

  it('rejects a tampered event and another device key', async () => {
    const s = keySigner();
    const other = keySigner();
    const { event } = await signEvent(s, draft(s.device));
    expect(verifyEvent({ ...event, body: { name: 'Mallory' } }, s.spki)).toBe(false);
    expect(verifyEvent(event, other.spki)).toBe(false);
  });

  it('only accepts the exact canonical line (no re-encoding by a relay)', async () => {
    const s = keySigner();
    const { line } = await signEvent(s, draft(s.device));
    const reencoded = JSON.stringify(JSON.parse(line), null, 1);
    expect(() => decodeEvent(reencoded)).toThrow(/canonical/);
  });

  it('refuses to sign or decode malformed envelopes', async () => {
    const s = keySigner();
    await expect(signEvent(s, draft(s.device, { seq: 2, prev: null }))).rejects.toThrow(/prev/);
    await expect(signEvent(s, draft(s.device, { seq: 1, prev: 'b'.repeat(64) }))).rejects.toThrow(/prev/);
    await expect(signEvent(s, draft('../../etc/passwd'))).rejects.toThrow(/device/);
    await expect(signEvent(s, draft(s.device, { deps: ['x'] }))).rejects.toThrow(/deps/);
    await expect(signEvent(s, draft(s.device, { body: { big: 'x'.repeat(17_000) } }))).rejects.toThrow(/16/);
    const dup = 'c'.repeat(64);
    await expect(signEvent(s, draft(s.device, { deps: [dup, dup] }))).rejects.toThrow(/deps/);
  });

  it('a signer that is not the author device cannot produce a valid event', async () => {
    const s = keySigner();
    const other = keySigner();
    await expect(signEvent(s, draft(other.device))).rejects.toThrow(/device/);
  });
});

describe('derived lamport (§6.1, invariant 3)', () => {
  type Meta = { device: string; seq: number; lamport: number };
  const table = new Map<string, Meta>();
  const h = (c: string) => c.repeat(64);
  table.set(h('1'), { device: 'aaaaaaaaaaaaaaaa', seq: 1, lamport: 1 });
  table.set(h('2'), { device: 'aaaaaaaaaaaaaaaa', seq: 2, lamport: 5 });
  table.set(h('3'), { device: 'bbbbbbbbbbbbbbbb', seq: 1, lamport: 7 });
  const lookup = (x: string) => table.get(x);

  const ev = (over: Partial<UnsignedEvent>) =>
    ({ ...draft('aaaaaaaaaaaaaaaa'), sig: '', ...over }) as UnsignedEvent & { sig: string };

  it('ok when lamport = max(deps ∪ prev) + 1', () => {
    expect(checkCausal(ev({ seq: 3, prev: h('2'), deps: [h('3')], lamport: 8 }), lookup)).toEqual({ status: 'ok' });
    expect(checkCausal(ev({ seq: 1, prev: null, deps: [], lamport: 1 }), lookup)).toEqual({ status: 'ok' });
  });

  it('rejects backdated and inflated lamports', () => {
    expect(checkCausal(ev({ seq: 3, prev: h('2'), deps: [h('3')], lamport: 6 }), lookup).status).toBe('reject');
    expect(checkCausal(ev({ seq: 3, prev: h('2'), deps: [h('3')], lamport: 99 }), lookup).status).toBe('reject');
    expect(checkCausal(ev({ seq: 1, prev: null, deps: [], lamport: 2 }), lookup).status).toBe('reject');
  });

  it('is pending while deps or prev are unknown', () => {
    expect(checkCausal(ev({ seq: 3, prev: h('2'), deps: [h('9')], lamport: 8 }), lookup))
      .toEqual({ status: 'pending', missing: [h('9')] });
    expect(checkCausal(ev({ seq: 4, prev: h('8'), deps: [], lamport: 8 }), lookup))
      .toEqual({ status: 'pending', missing: [h('8')] });
  });

  it('rejects a prev that is not this feed at seq-1', () => {
    expect(checkCausal(ev({ seq: 2, prev: h('3'), deps: [], lamport: 8 }), lookup).status).toBe('reject');
    expect(checkCausal(ev({ seq: 5, prev: h('2'), deps: [], lamport: 6 }), lookup).status).toBe('reject');
  });
});

describe('fork proofs', () => {
  it('two signed events at the same (device, seq) prove a fork, in a canonical order', async () => {
    const s = keySigner();
    const a = await signEvent(s, draft(s.device, { body: { name: 'A' } }));
    const b = await signEvent(s, draft(s.device, { body: { name: 'B' } }));
    const p1 = makeForkProof(a.line, b.line);
    const p2 = makeForkProof(b.line, a.line);
    expect(p1).toEqual(p2);
    expect(p1).toMatchObject({ type: 'fork.proof', device: s.device, seq: 1 });
    expect(verifyForkProof(p1, s.spki)).toBe(true);
    expect(verifyForkProof(p1, keySigner().spki)).toBe(false);
  });

  it('the same event twice, or different seqs, is not a fork', async () => {
    const s = keySigner();
    const a = await signEvent(s, draft(s.device));
    expect(() => makeForkProof(a.line, a.line)).toThrow();
    const b = await signEvent(s, draft(s.device, { seq: 2, prev: a.hash, lamport: 2 }));
    expect(() => makeForkProof(a.line, b.line)).toThrow();
  });
});
