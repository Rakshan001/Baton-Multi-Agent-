// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The build-time digest manifest: what it saves, and when it must be ignored.
 *
 * A skill listing reports every reference file's size and sha256 without
 * opening one, by trusting `digests.json`. That trust is what needs testing —
 * `contentSha256` promises to change iff an install would differ, and a cache
 * that keeps answering after the file changed would break exactly that.
 *
 * Nothing here touches ~/.baton: these tests build their own skill directory in
 * a temp dir and never load the machine-wide library.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearDigestCache, digestOf, fileDigest, lazyReference, manifestDigest, referenceReads } from '../src/skills/digests.js';

const TEXT = 'reference body\n';
const KEY = 'demo/references/one.md';

let dir = '';
let before = 0;

/** Bytes of content read since the last checkpoint. */
function readSince(): number { return referenceReads.bytes - before; }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'baton-digests-'));
  await mkdir(join(dir, 'demo', 'references'), { recursive: true });
  await writeFile(join(dir, 'demo', 'references', 'one.md'), TEXT, 'utf-8');
  clearDigestCache();
  before = referenceReads.bytes;
});

afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function writeManifest(entry: unknown): Promise<void> {
  await writeFile(join(dir, 'digests.json'), JSON.stringify({ version: 1, files: { [KEY]: entry } }), 'utf-8');
  clearDigestCache();
}

const truth = digestOf(TEXT);

describe('fileDigest', () => {
  it('answers from the manifest without reading the file', async () => {
    await writeManifest({ size: TEXT.length, bytes: truth.bytes, sha256: truth.sha256 });
    expect(fileDigest(dir, KEY, join(dir, 'demo/references/one.md'))).toEqual(truth);
    expect(readSince(), 'the manifest hit still read the file').toBe(0);
  });

  it('reads the file when there is no manifest at all', () => {
    expect(fileDigest(dir, KEY, join(dir, 'demo/references/one.md'))).toEqual(truth);
    expect(readSince()).toBe(TEXT.length);
  });

  it('reads the file when the manifest has no row for it', async () => {
    await writeManifest({ size: 1, bytes: 1, sha256: 'x' });
    await writeFile(join(dir, 'digests.json'), JSON.stringify({ version: 1, files: {} }), 'utf-8');
    clearDigestCache();
    expect(fileDigest(dir, KEY, join(dir, 'demo/references/one.md'))).toEqual(truth);
    expect(readSince()).toBe(TEXT.length);
  });

  it('ignores a manifest whose version it does not know', async () => {
    await writeFile(join(dir, 'digests.json'),
      JSON.stringify({ version: 99, files: { [KEY]: { size: TEXT.length, bytes: 1, sha256: 'stale' } } }), 'utf-8');
    clearDigestCache();
    expect(fileDigest(dir, KEY, join(dir, 'demo/references/one.md'))).toEqual(truth);
  });

  it('ignores a corrupt manifest rather than throwing', async () => {
    await writeFile(join(dir, 'digests.json'), '{ not json', 'utf-8');
    clearDigestCache();
    expect(fileDigest(dir, KEY, join(dir, 'demo/references/one.md'))).toEqual(truth);
  });

  it('re-reads when the file no longer matches the recorded size', async () => {
    // The invalidation that matters: a bundled reference edited between builds.
    await writeManifest({ size: TEXT.length, bytes: truth.bytes, sha256: truth.sha256 });
    const grown = TEXT + 'one more line\n';
    await writeFile(join(dir, 'demo', 'references', 'one.md'), grown, 'utf-8');
    const d = fileDigest(dir, KEY, join(dir, 'demo/references/one.md'));
    expect(d).toEqual(digestOf(grown));
    expect(d.sha256).not.toBe(truth.sha256);
    expect(readSince()).toBe(grown.length);
  });

  it('hashes empty for a file that has gone missing', async () => {
    await writeManifest({ size: TEXT.length, bytes: truth.bytes, sha256: truth.sha256 });
    await rm(join(dir, 'demo', 'references', 'one.md'));
    expect(fileDigest(dir, KEY, join(dir, 'demo/references/one.md'))).toEqual(digestOf(''));
  });
});

describe('manifestDigest', () => {
  it('never reads the file, even when it has to answer null', async () => {
    await writeManifest({ size: 1, bytes: 1, sha256: 'stale' });   // size no longer matches
    expect(manifestDigest(dir, KEY, join(dir, 'demo/references/one.md'))).toBeNull();
    expect(readSince()).toBe(0);
  });
});

describe('lazyReference', () => {
  it('names the file without reading it, and digests it without reading it', async () => {
    await writeManifest({ size: TEXT.length, bytes: truth.bytes, sha256: truth.sha256 });
    const ref = lazyReference(dir, 'demo', 'references/one.md');
    expect(ref.rel).toBe('references/one.md');
    expect(ref.digest).toEqual(truth);
    expect(readSince()).toBe(0);
  });

  it('reads the text once, on demand', async () => {
    const ref = lazyReference(dir, 'demo', 'references/one.md');
    expect(ref.content).toBe(TEXT);
    expect(ref.content).toBe(TEXT);
    expect(readSince(), 'content was re-read').toBe(TEXT.length);
  });

  it('prefers the text it already has over the manifest', async () => {
    // A stale row must never outrank bytes actually in hand.
    await writeManifest({ size: TEXT.length, bytes: 999, sha256: 'not-the-real-hash' });
    const ref = lazyReference(dir, 'demo', 'references/one.md');
    expect(ref.content).toBe(TEXT);
    expect(ref.digest).toEqual(truth);
  });

  it('reads once when the manifest cannot answer, however often it is asked', async () => {
    const ref = lazyReference(dir, 'demo', 'references/one.md');
    expect(ref.digest).toEqual(truth);
    expect(ref.digest).toEqual(truth);
    expect(ref.content).toBe(TEXT);
    expect(readSince(), 'the fallback read the file more than once').toBe(TEXT.length);
  });

  it('reads an unreadable file as empty rather than throwing', async () => {
    await writeFile(join(dir, 'demo', 'references', 'locked.md'), 'x', 'utf-8');
    await chmod(join(dir, 'demo', 'references', 'locked.md'), 0o000);
    const ref = lazyReference(dir, 'demo', 'references/locked.md');
    expect(ref.content).toBe('');
  });

  it('does not cache a failed read as an empty file', async () => {
    // One transient EACCES during a listing used to be cached forever, so a
    // later install wrote a zero-byte reference file and hashed the emptiness.
    const path = join(dir, 'demo', 'references', 'flaky.md');
    await writeFile(path, TEXT, 'utf-8');
    await chmod(path, 0o000);

    const ref = lazyReference(dir, 'demo', 'references/flaky.md');
    expect(ref.content, 'a read error must not throw').toBe('');

    await chmod(path, 0o644);
    expect(ref.content, 'the failed read was cached as an empty body').toBe(TEXT);
    expect(ref.digest, 'the digest hashed the cached emptiness').toEqual(truth);
  });

  it('caches a file that really is empty, reading it once', async () => {
    await writeFile(join(dir, 'demo', 'references', 'empty.md'), '', 'utf-8');
    const ref = lazyReference(dir, 'demo', 'references/empty.md');
    const files = referenceReads.files;
    expect(ref.content).toBe('');
    expect(ref.content).toBe('');
    expect(referenceReads.files - files, 'a successful empty read was not cached').toBe(1);
  });
});

/**
 * Telling a file that is EMPTY from a file that could not be READ.
 *
 * `content` collapses both to `''`, which is right for a property access in
 * the middle of a render but wrong for a writer: an install that treats a
 * failed read as an empty file writes a zero-byte reference, counts it, and
 * reports a `contentSha256` — taken from the manifest, which still stats fine —
 * over bytes it never wrote. The SKILL.md then tells the agent to read a file
 * that is present and empty, which is worse than one that is absent.
 *
 * `tryContent` is the honest answer, so a caller that is about to WRITE can
 * ask for one.
 */
describe('lazyReference.tryContent', () => {
  it('answers null when the file cannot be read', async () => {
    const path = join(dir, 'demo', 'references', 'locked.md');
    await writeFile(path, TEXT, 'utf-8');
    await chmod(path, 0o000);
    const ref = lazyReference(dir, 'demo', 'references/locked.md');
    expect(ref.tryContent!()).toBeNull();
    await chmod(path, 0o644);
  });

  it('answers the empty string for a file that really is empty', async () => {
    await writeFile(join(dir, 'demo', 'references', 'empty.md'), '', 'utf-8');
    expect(lazyReference(dir, 'demo', 'references/empty.md').tryContent!()).toBe('');
  });

  it('is the one place the manifest and the file can disagree', async () => {
    // The exact divergence: `digest` answers 15 bytes off the manifest (a stat
    // succeeds on a mode-000 file), while there are no bytes to be had.
    const path = join(dir, 'demo', 'references', 'one.md');
    await writeManifest({ size: TEXT.length, bytes: truth.bytes, sha256: truth.sha256 });
    await chmod(path, 0o000);
    const ref = lazyReference(dir, 'demo', 'references/one.md');
    expect(ref.digest).toEqual(truth);
    expect(ref.content, 'content still degrades to empty, as its callers rely on').toBe('');
    expect(ref.tryContent!(), 'nothing could say the read had failed').toBeNull();
    await chmod(path, 0o644);
  });

  it('retries after a transient failure, and caches only the success', async () => {
    const path = join(dir, 'demo', 'references', 'flaky.md');
    await writeFile(path, TEXT, 'utf-8');
    await chmod(path, 0o000);
    const ref = lazyReference(dir, 'demo', 'references/flaky.md');
    expect(ref.tryContent!()).toBeNull();
    await chmod(path, 0o644);
    expect(ref.tryContent!()).toBe(TEXT);
    const files = referenceReads.files;
    expect(ref.tryContent!()).toBe(TEXT);
    expect(referenceReads.files - files, 'a successful read was not cached').toBe(0);
  });
});

describe('the shipped bundled/digests.json', () => {
  it('matches every bundled reference file byte for byte', () => {
    // Same walk and hashing as scripts/copy-assets.mjs: depth-1 files under
    // <skill>/references/, size from the raw bytes, bytes/sha256 from the text.
    // fileDigest trusts a row by size alone, so a same-size edit without a
    // rebuild would otherwise report a stale contentSha256.
    const bundled = fileURLToPath(new URL('../src/skills/bundled/', import.meta.url));
    const manifest = JSON.parse(readFileSync(join(bundled, 'digests.json'), 'utf-8')) as {
      version: number; files: Record<string, { size: number; bytes: number; sha256: string }>;
    };
    expect(manifest.version).toBe(1);
    const actual: Record<string, { size: number; bytes: number; sha256: string }> = {};
    for (const skill of readdirSync(bundled, { withFileTypes: true })) {
      if (!skill.isDirectory()) continue;
      const refDir = join(bundled, skill.name, 'references');
      if (!existsSync(refDir)) continue;
      for (const e of readdirSync(refDir, { withFileTypes: true })) {
        if (!e.isFile()) continue;
        const buf = readFileSync(join(refDir, e.name));
        const d = digestOf(buf.toString('utf-8'));
        actual[`${skill.name}/references/${e.name}`] = { size: buf.length, bytes: d.bytes, sha256: d.sha256 };
      }
    }
    const stale = 'digests.json is stale: run npm run build';
    expect(Object.keys(manifest.files).sort(), stale).toEqual(Object.keys(actual).sort());
    for (const [key, row] of Object.entries(actual)) {
      expect(manifest.files[key], `${key}: ${stale}`).toEqual(row);
    }
  });
});
