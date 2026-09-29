// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Team Sync event envelope, v1 (docs/system-design/team-sync/README.md §6.1).
 *
 * - Every event is stored, hashed and relayed as its exact signed line: the RFC
 *   8785 canonical JSON of all fields including `sig`. `hash = sha256(line)`.
 * - `sig` is Ed25519 over `"baton/v1/event\0"` + canonical bytes of every field
 *   but `sig`. The domain prefix means a signature made for anything else (a
 *   recovery statement, a skill bundle) can never be replayed as an event.
 * - `lamport` is derived, never chosen: it MUST equal
 *   `max(lamport of deps ∪ prev) + 1` (review finding S-C1). `checkCausal`
 *   enforces that and reports missing deps as pending.
 * - Signing goes through a `Signer` so the private key can live in Electron
 *   main (§4.1); the daemon only ever sees the public SPKI.
 *
 * Zero dependencies: node:crypto only.
 */
import { createHash, createPublicKey, verify as edVerify, type KeyObject } from 'node:crypto';
import { canonicalBytes, canonicalize, parseStrict } from './canonical.js';

// ── ids (§12.5): every id is checked with one of these before it touches fs ──

export const DEVICE_ID_RE = /^[a-z2-7]{16}$/;
export const HASH_RE = /^[0-9a-f]{64}$/;
export const MEMBER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const PROJECT_KEY_RE = /^prj_[a-z0-9]{4,32}$/;
export const EVENT_TYPE_RE = /^[a-z][a-z0-9.-]{0,63}$/;
const SIG_RE = /^[A-Za-z0-9_-]{86}$/; // 64 bytes, base64url, unpadded

/**
 * True iff `s` is the ONE canonical unpadded base64url spelling of its bytes.
 * 86 characters carry 516 bits for a 512-bit signature, so 4 low bits of the
 * last character are ignored by decoders: without this check every signature
 * has 16 spellings, each a distinct line with a distinct hash (a fake fork of
 * any event). SPKIs have the same problem with 2 spare bits.
 */
export function isCanonicalBase64url(s: unknown): s is string {
  return typeof s === 'string' && /^[A-Za-z0-9_-]*$/.test(s) && Buffer.from(s, 'base64url').toString('base64url') === s;
}

/** A well-formed, canonically encoded Ed25519 signature string. */
export function isSignature(s: unknown): s is string {
  return typeof s === 'string' && SIG_RE.test(s) && isCanonicalBase64url(s);
}

export const SUPPORTED_VERSION = 1;
export const MAX_DEPS = 32;
export const MAX_BODY_BYTES = 16 * 1024;
/** Hard cap on one stored/received line, checked before any JSON parsing (§15 invariant 12). */
export const MAX_LINE_BYTES = 1024 * 1024;
export const EVENT_DOMAIN = 'baton/v1/event\0';
/** Domain for the paper recovery key's signature on `recovery.restore` (§5.4). */
export const RECOVERY_DOMAIN = 'baton/v1/recovery\0';

/** `team` = sha256 of the canonical genesis body (§6.1 "hash of genesis"). */
export function teamIdFromGenesis(body: Record<string, unknown>): string {
  return sha256Hex(canonicalize(body));
}

export interface TeamEvent {
  v: number;
  team: string;
  device: string;
  seq: number;
  fork: number;
  prev: string | null;
  deps: string[];
  lamport: number;
  ts: string;
  type: string;
  body: Record<string, unknown>;
  sig: string;
}

export type UnsignedEvent = Omit<TeamEvent, 'sig'>;

/** Something that can sign bytes with a device's Ed25519 key (e.g. Electron main over IPC). */
export interface Signer {
  /** The device public key: DER SPKI, base64url. */
  readonly spki: string;
  sign(bytes: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeError';
  }
}

// ── keys and ids ─────────────────────────────────────────────────────────────

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** §4.1: `deviceId = base32(sha256(spki))[0..16]`. */
export function deviceIdFromSpki(spki: string): string {
  return base32(createHash('sha256').update(Buffer.from(spki, 'base64url')).digest()).slice(0, 16);
}

const keyCache = new Map<string, KeyObject | null>();

/** The Ed25519 public key for a base64url SPKI, or null if it isn't one. */
export function publicKeyFromSpki(spki: string): KeyObject | null {
  if (keyCache.has(spki)) return keyCache.get(spki) ?? null;
  let key: KeyObject | null = null;
  try {
    if (typeof spki === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(spki) && isCanonicalBase64url(spki)) {
      const k = createPublicKey({ key: Buffer.from(spki, 'base64url'), format: 'der', type: 'spki' });
      if (k.asymmetricKeyType === 'ed25519') key = k;
    }
  } catch {
    key = null;
  }
  if (keyCache.size > 4096) keyCache.clear();
  keyCache.set(spki, key);
  return key;
}

/** Domain-separated bytes: `domain` + canonical bytes of `value`. */
export function domainBytes(domain: string, value: unknown): Buffer {
  return Buffer.concat([Buffer.from(domain, 'utf8'), canonicalBytes(value)]);
}

/** Verify a detached Ed25519 signature (base64url) over `domain` + canonical(value). */
export function verifyDetached(domain: string, value: unknown, sig: string, spki: string): boolean {
  const key = publicKeyFromSpki(spki);
  if (!key || !isSignature(sig)) return false;
  try {
    return edVerify(null, domainBytes(domain, value), key, Buffer.from(sig, 'base64url'));
  } catch {
    return false;
  }
}

// ── envelope shape ───────────────────────────────────────────────────────────

const FIELDS = ['v', 'team', 'device', 'seq', 'fork', 'prev', 'deps', 'lamport', 'ts', 'type', 'body'] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const posInt = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 1;

/** Throws `EnvelopeError` unless `e` has the v1 envelope shape (sig optional). */
export function validateShape(e: unknown, requireSig: boolean): asserts e is TeamEvent {
  if (!isPlainObject(e)) throw new EnvelopeError('event is not an object');
  const allowed = new Set<string>([...FIELDS, 'sig']);
  for (const k of Object.keys(e)) if (!allowed.has(k)) throw new EnvelopeError(`unknown envelope field ${k}`);
  if (!posInt(e.v)) throw new EnvelopeError('v must be a positive integer');
  if (typeof e.team !== 'string' || !HASH_RE.test(e.team)) throw new EnvelopeError('team must be a sha256 hex');
  if (typeof e.device !== 'string' || !DEVICE_ID_RE.test(e.device)) throw new EnvelopeError('device id is malformed');
  if (!posInt(e.seq)) throw new EnvelopeError('seq must be a positive integer');
  if (!Number.isSafeInteger(e.fork) || (e.fork as number) < 0) throw new EnvelopeError('fork must be a non-negative integer');
  if (e.seq === 1) {
    if (e.prev !== null) throw new EnvelopeError('prev must be null at seq 1');
  } else if (typeof e.prev !== 'string' || !HASH_RE.test(e.prev)) {
    throw new EnvelopeError('prev must be the previous event hash');
  }
  if (!Array.isArray(e.deps) || e.deps.length > MAX_DEPS) throw new EnvelopeError(`deps must be an array of ≤ ${MAX_DEPS}`);
  if (!e.deps.every((d) => typeof d === 'string' && HASH_RE.test(d))) throw new EnvelopeError('deps must be event hashes');
  if (new Set(e.deps).size !== e.deps.length) throw new EnvelopeError('deps must not repeat');
  if (!posInt(e.lamport)) throw new EnvelopeError('lamport must be a positive integer');
  if (typeof e.ts !== 'string' || e.ts.length > 64) throw new EnvelopeError('ts must be a short string');
  if (typeof e.type !== 'string' || !EVENT_TYPE_RE.test(e.type)) throw new EnvelopeError('type is malformed');
  if (!isPlainObject(e.body)) throw new EnvelopeError('body must be an object');
  if (canonicalBytes(e.body).length > MAX_BODY_BYTES) throw new EnvelopeError('body exceeds 16 KB');
  if (requireSig) {
    if (!isSignature(e.sig)) throw new EnvelopeError('sig is malformed or not canonical base64url');
  }
}

function unsignedOf(e: UnsignedEvent | TeamEvent): UnsignedEvent {
  const { v, team, device, seq, fork, prev, deps, lamport, ts, type, body } = e;
  return { v, team, device, seq, fork, prev, deps, lamport, ts, type, body };
}

/** The bytes a device signs: `"baton/v1/event\0"` + canonical(all fields but sig). */
export function signingBytes(e: UnsignedEvent | TeamEvent): Buffer {
  return domainBytes(EVENT_DOMAIN, unsignedOf(e));
}

/** sha256 hex of the exact stored line (no trailing newline). */
export function eventHash(line: string): string {
  return sha256Hex(line);
}

export interface SignedEvent {
  event: TeamEvent;
  line: string;
  hash: string;
}

/** Validate a draft, sign it through `signer`, and return the exact line to store. */
export async function signEvent(signer: Signer, draft: UnsignedEvent): Promise<SignedEvent> {
  const unsigned = unsignedOf(draft);
  validateShape(unsigned, false);
  if (deviceIdFromSpki(signer.spki) !== unsigned.device) {
    throw new EnvelopeError('signer key does not match the event device');
  }
  const sig = Buffer.from(await signer.sign(signingBytes(unsigned))).toString('base64url');
  const event: TeamEvent = { ...unsigned, sig };
  validateShape(event, true);
  const line = canonicalize(event);
  return { event, line, hash: eventHash(line) };
}

/**
 * Parse one stored or received line. The line must already be canonical: a
 * re-encoded event (whitespace, key order, escapes) is refused rather than
 * normalised, because its hash would no longer match what others hold.
 * Does NOT check the signature (the key comes from the org state).
 */
export function decodeEvent(line: string): SignedEvent {
  if (typeof line !== 'string') throw new EnvelopeError('line must be a string');
  // Size first: `length` ≤ UTF-8 bytes, so the cheap check rejects most oversize lines unscanned.
  if (line.length > MAX_LINE_BYTES || Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
    throw new EnvelopeError(`event line exceeds ${MAX_LINE_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = parseStrict(line);
  } catch (err) {
    throw new EnvelopeError(`unparseable event: ${(err as Error).message}`);
  }
  validateShape(parsed, true);
  if (canonicalize(parsed) !== line) throw new EnvelopeError('event line is not in canonical form');
  return { event: parsed, line, hash: eventHash(line) };
}

/** True iff `event.sig` is a valid signature by the key `spki`, and the key is this device's. */
export function verifyEvent(event: TeamEvent, spki: string): boolean {
  if (deviceIdFromSpki(spki) !== event.device) return false;
  const key = publicKeyFromSpki(spki);
  if (!key || !isSignature(event.sig)) return false;
  try {
    return edVerify(null, signingBytes(event), key, Buffer.from(event.sig, 'base64url'));
  } catch {
    return false;
  }
}

// ── derived lamport ──────────────────────────────────────────────────────────

export interface CausalMeta {
  device: string;
  seq: number;
  lamport: number;
}

export type CausalVerdict =
  | { status: 'ok' }
  | { status: 'pending'; missing: string[] }
  | { status: 'reject'; reason: string };

/**
 * §6.1: prev must be this feed's event at seq-1, every dep must be known, and
 * `lamport` must equal `max(lamport of deps ∪ prev) + 1` (1 for a root event).
 * Unknown prev/deps ⇒ pending (the caller holds it and rejects after a bounded
 * wait); a known-but-wrong prev or a chosen lamport ⇒ reject.
 */
export function checkCausal(
  e: Pick<TeamEvent, 'device' | 'seq' | 'prev' | 'deps' | 'lamport'>,
  lookup: (hash: string) => CausalMeta | undefined,
): CausalVerdict {
  const missing: string[] = [];
  let max = 0;
  if (e.seq > 1) {
    if (e.prev === null) return { status: 'reject', reason: 'prev-missing' };
    const p = lookup(e.prev);
    if (!p) missing.push(e.prev);
    else {
      if (p.device !== e.device || p.seq !== e.seq - 1) return { status: 'reject', reason: 'prev-not-chain' };
      max = p.lamport;
    }
  } else if (e.prev !== null) {
    return { status: 'reject', reason: 'prev-at-root' };
  }
  for (const d of e.deps) {
    const m = lookup(d);
    if (!m) missing.push(d);
    else if (m.lamport > max) max = m.lamport;
  }
  if (missing.length) return { status: 'pending', missing: [...new Set(missing)].sort() };
  if (e.lamport !== max + 1) return { status: 'reject', reason: 'lamport-not-derived' };
  return { status: 'ok' };
}

/** The lamport a new event must carry given its prev's and deps' lamports. */
export function nextLamport(parentLamports: number[]): number {
  return parentLamports.reduce((a, b) => Math.max(a, b), 0) + 1;
}

// ── fork proofs (§9) ─────────────────────────────────────────────────────────

export interface ForkProof {
  type: 'fork.proof';
  device: string;
  seq: number;
  /** The two exact signed lines, ordered by hash so every peer builds the same proof. */
  eventA: string;
  eventB: string;
}

/**
 * Equivocation is two distinct events by one device at the same `(team, seq)`.
 *
 * Phase 1: the `fork` counter does NOT excuse a second event at a held seq — a
 * differing counter is equivocation like any other, so a stolen key can't use
 * it to rewrite history. (A legitimate restore will later need a
 * custodian-signed org event; it must never be adopted at or below a revoke
 * cutoff, never for a revoked device, and never at genesis seq 1.)
 * Events of another team are never a proof: a device key reused across teams
 * must not let one team's line freeze the other.
 */
function sameSlot(a: TeamEvent, b: TeamEvent): boolean {
  return a.team === b.team && a.device === b.device && a.seq === b.seq;
}

/** Build a proof from two distinct lines by the same device at the same (team, seq). Throws otherwise. */
export function makeForkProof(lineA: string, lineB: string): ForkProof {
  const a = decodeEvent(lineA);
  const b = decodeEvent(lineB);
  if (a.hash === b.hash) throw new EnvelopeError('identical events are not a fork');
  if (!sameSlot(a.event, b.event)) {
    throw new EnvelopeError('a fork needs two events at the same (team, device, seq)');
  }
  const [x, y] = a.hash < b.hash ? [a, b] : [b, a];
  return { type: 'fork.proof', device: a.event.device, seq: a.event.seq, eventA: x.line, eventB: y.line };
}

/**
 * True iff the proof holds two distinct events at its (device, seq), in one team,
 * both accepted by `key` — the device's SPKI, or a
 * verifier such as a Feed's `verify`. With `team`, both events must belong to it.
 */
export function verifyForkProof(proof: unknown, key: string | ((e: TeamEvent) => boolean), team?: string): boolean {
  if (!isPlainObject(proof)) return false;
  const { device, seq, eventA, eventB } = proof;
  if (typeof device !== 'string' || !DEVICE_ID_RE.test(device) || !posInt(seq)) return false;
  if (typeof eventA !== 'string' || typeof eventB !== 'string') return false;
  const ok = typeof key === 'string' ? (e: TeamEvent) => verifyEvent(e, key) : key;
  try {
    const a = decodeEvent(eventA);
    const b = decodeEvent(eventB);
    if (!(a.hash < b.hash)) return false;
    if (!sameSlot(a.event, b.event)) return false;
    if (team !== undefined && a.event.team !== team) return false;
    for (const x of [a, b]) {
      if (x.event.device !== device || x.event.seq !== seq) return false;
      if (!ok(x.event)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
