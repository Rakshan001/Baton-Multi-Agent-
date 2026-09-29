// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One device's append-only event feed on disk: `<dir>/<deviceId>.jsonl`
 * (Team Sync §9, §12.5, §13.1).
 *
 * - Each line is the exact signed canonical line; nothing is re-encoded.
 * - The chain (seq 1.., prev = hash of the previous line) is re-verified on
 *   load. A torn tail after a power loss — or anything after the first line
 *   that fails to parse, chain or verify — is truncated away (`dropped`).
 * - Receiving a different event at a seq we already hold yields a `fork.proof`
 *   (§9). `freeze(proof)` truncates to the common prefix and persists the proof
 *   in `<deviceId>.fork.json`, after which the feed accepts nothing.
 * - The device id is regex-checked before any path is built, and files are
 *   opened with O_NOFOLLOW so a planted symlink can't redirect writes.
 *
 * Signature checks need the device's admitted key, which comes from the org
 * state, so callers MUST pass it in as `verify`, together with the `team` the
 * feed belongs to. A feed never holds another team's line (a device key reused
 * across teams must not let one team's events fork or truncate the other's),
 * and it never truncates on a proof it cannot verify itself.
 *
 * Fork counter (§9), phase 1: a second event at a held seq is equivocation
 * whatever its `fork` counter says, and yields a fork proof. Within one chain
 * `fork` never decreases. (Adopting a legitimately restored feed will need a
 * custodian-signed org event — see `sameSlot` in envelope.ts.)
 */
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, openSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalize } from './canonical.js';
import {
  DEVICE_ID_RE,
  HASH_RE,
  MAX_LINE_BYTES,
  decodeEvent,
  makeForkProof,
  verifyForkProof,
  type ForkProof,
  type TeamEvent,
} from './envelope.js';

export class FeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedError';
  }
}

export interface FeedEntry {
  seq: number;
  hash: string;
  line: string;
  event: TeamEvent;
  /** Byte offset just past this line's newline. */
  end: number;
}

export interface FeedOptions {
  /** The team this feed belongs to; a line of any other team is refused. */
  team: string;
  /** Signature check (the device's admitted key) applied on load, ingest and to fork proofs. Required. */
  verify: (event: TeamEvent) => boolean;
}

export type IngestResult =
  | { status: 'appended'; entry: FeedEntry }
  | { status: 'duplicate' }
  | { status: 'gap'; expected: number }
  | { status: 'fork'; proof: ForkProof }
  | { status: 'chain-mismatch' }
  | { status: 'frozen' }
  | { status: 'invalid'; reason: string };

const { O_RDWR, O_CREAT, O_NOFOLLOW, O_RDONLY, O_WRONLY, O_TRUNC } = constants;

function readAll(fd: number): Buffer {
  const size = fstatSync(fd).size;
  const buf = Buffer.alloc(size);
  let off = 0;
  while (off < size) {
    const n = readSync(fd, buf, off, size - off, off);
    if (n === 0) break;
    off += n;
  }
  return buf.subarray(0, off);
}

function openNoFollow(path: string, flags: number): number | null {
  try {
    return openSync(path, flags | O_NOFOLLOW, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export class Feed {
  private list: FeedEntry[] = [];
  private size = 0;
  private proof: ForkProof | null = null;
  /** Lines dropped on load (torn tail or invalid suffix). */
  dropped = 0;

  private constructor(
    readonly device: string,
    private readonly fd: number,
    private readonly forkPath: string,
    readonly team: string,
    private readonly verify: (e: TeamEvent) => boolean,
  ) {}

  static open(dir: string, device: string, opts: FeedOptions): Feed {
    if (typeof device !== 'string' || !DEVICE_ID_RE.test(device)) throw new FeedError('invalid device id');
    if (!opts || typeof opts.team !== 'string' || !HASH_RE.test(opts.team)) throw new FeedError('a feed needs its team id');
    if (typeof opts.verify !== 'function') throw new FeedError('a feed needs a signature verifier');
    const fd = openSync(join(dir, `${device}.jsonl`), O_RDWR | O_CREAT | O_NOFOLLOW, 0o600);
    const feed = new Feed(device, fd, join(dir, `${device}.fork.json`), opts.team, opts.verify);
    try {
      feed.load();
    } catch (err) {
      closeSync(fd);
      throw err;
    }
    return feed;
  }

  get frozen(): boolean {
    return this.proof !== null;
  }

  get forkProof(): ForkProof | null {
    return this.proof;
  }

  entries(): readonly FeedEntry[] {
    return this.list;
  }

  head(): FeedEntry | null {
    return this.list.length ? this.list[this.list.length - 1] : null;
  }

  get(seq: number): FeedEntry | undefined {
    return this.list[seq - 1];
  }

  private load(): void {
    const pfd = openNoFollow(this.forkPath, O_RDONLY);
    if (pfd !== null) {
      try {
        // A persisted proof truncates the feed, so it is re-verified like any other:
        // a planted or corrupt `.fork.json` is ignored rather than trusted.
        if (fstatSync(pfd).size <= 2 * MAX_LINE_BYTES + 1024) {
          let p: unknown = null;
          try {
            p = JSON.parse(readAll(pfd).toString('utf8'));
          } catch {
            p = null;
          }
          if (this.provenFork(p)) this.proof = p;
        }
      } finally {
        closeSync(pfd);
      }
    }
    const text = readAll(this.fd).toString('utf8');
    let off = 0;
    let bytes = 0;
    while (off < text.length) {
      const nl = text.indexOf('\n', off);
      if (nl < 0) break; // torn tail: no newline
      const line = text.slice(off, nl);
      if (nl - off > MAX_LINE_BYTES) break; // same cap as decodeEvent, before any parsing
      const entry = this.check(line);
      if (typeof entry === 'string') break;
      if (this.proof && entry.seq >= this.proof.seq) break;
      bytes += Buffer.byteLength(line, 'utf8') + 1;
      this.list.push({ ...entry, end: bytes });
      off = nl + 1;
    }
    const rest = text.slice(off);
    this.dropped = rest.split('\n').filter((s) => s.length > 0).length;
    this.size = bytes;
    if (Buffer.byteLength(text, 'utf8') !== bytes) {
      ftruncateSync(this.fd, bytes);
      fsyncSync(this.fd);
    }
  }

  /** Validate `line` as the next entry; returns a reason string on failure. */
  private check(line: string): Omit<FeedEntry, 'end'> | string {
    let d;
    try {
      d = decodeEvent(line);
    } catch (err) {
      return `malformed: ${(err as Error).message}`;
    }
    const { event, hash } = d;
    if (event.team !== this.team) return 'event belongs to another team';
    if (event.device !== this.device) return 'event belongs to another device';
    const head = this.head();
    const expected = head ? head.seq + 1 : 1;
    if (event.seq !== expected) return `expected seq ${expected}`;
    if (event.prev !== (head ? head.hash : null)) return 'prev does not match the feed head';
    if (head && event.fork < head.event.fork) return 'fork counter went backwards';
    if (!this.verify(event)) return 'signature check failed';
    return { seq: event.seq, hash, line, event };
  }

  /** Append this device's own next event. Throws `FeedError` if it doesn't extend the chain. */
  append(line: string): FeedEntry {
    if (this.proof) throw new FeedError('feed is frozen after a fork');
    const entry = this.check(line);
    if (typeof entry === 'string') throw new FeedError(entry);
    return this.write(entry);
  }

  private write(entry: Omit<FeedEntry, 'end'>): FeedEntry {
    const buf = Buffer.from(entry.line + '\n', 'utf8');
    let off = 0;
    while (off < buf.length) off += writeSync(this.fd, buf, off, buf.length - off, this.size + off);
    fsyncSync(this.fd);
    this.size += buf.length;
    const full = { ...entry, end: this.size };
    this.list.push(full);
    return full;
  }

  /** Accept an event received from a peer (it may have been relayed by anyone). */
  ingest(line: string): IngestResult {
    if (this.proof) return { status: 'frozen' };
    let d;
    try {
      d = decodeEvent(line);
    } catch (err) {
      return { status: 'invalid', reason: (err as Error).message };
    }
    const { event, hash } = d;
    if (event.team !== this.team) return { status: 'invalid', reason: 'event belongs to another team' };
    if (event.device !== this.device) return { status: 'invalid', reason: 'event belongs to another device' };
    if (!this.verify(event)) return { status: 'invalid', reason: 'signature check failed' };
    const head = this.head();
    const headSeq = head ? head.seq : 0;
    if (event.seq <= headSeq) {
      const held = this.list[event.seq - 1];
      if (held.hash === hash) return { status: 'duplicate' };
      return { status: 'fork', proof: makeForkProof(held.line, line) };
    }
    if (event.seq > headSeq + 1) return { status: 'gap', expected: headSeq + 1 };
    const entry = this.check(line);
    if (typeof entry === 'string') return { status: 'chain-mismatch' };
    return { status: 'appended', entry: this.write(entry) };
  }

  /**
   * §9: truncate to the common prefix (seq < proof.seq) and stop accepting
   * events. Deterministic whatever arrived first. The proof is persisted so the
   * feed stays frozen across restarts.
   */
  freeze(proof: ForkProof): void {
    if (!proof || proof.device !== this.device || !Number.isSafeInteger(proof.seq) || proof.seq < 1) {
      throw new FeedError('fork proof is for another feed');
    }
    // Truncation is irreversible: only a proof this feed can verify itself (both
    // lines signed by this device's key, same team, same seq) may cause it.
    if (!this.provenFork(proof)) throw new FeedError('fork proof does not verify');
    if (this.proof && this.proof.seq <= proof.seq) return;
    const pfd = openSync(this.forkPath, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o600);
    try {
      writeSync(pfd, canonicalize(proof));
      fsyncSync(pfd);
    } finally {
      closeSync(pfd);
    }
    this.proof = proof;
    const keep = this.list.filter((e) => e.seq < proof.seq);
    const bytes = keep.length ? keep[keep.length - 1].end : 0;
    this.list = keep;
    this.size = bytes;
    ftruncateSync(this.fd, bytes);
    fsyncSync(this.fd);
  }

  private provenFork(p: unknown): p is ForkProof {
    return (
      !!p &&
      typeof p === 'object' &&
      (p as ForkProof).device === this.device &&
      verifyForkProof(p, this.verify, this.team)
    );
  }

  close(): void {
    closeSync(this.fd);
  }
}
