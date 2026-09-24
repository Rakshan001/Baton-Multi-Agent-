// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Skill metadata without the payload.
 *
 * Listing skills used to ship every playbook: 330 KB across the bundled set,
 * roughly 82k tokens, sent to render a list of names. A summary carries what
 * you need to *choose* a skill and nothing you need to *run* one — the body is
 * fetched only when something actually reads it.
 *
 * `contentSha256` lets a client skip the fetch entirely when its copy is
 * already current.
 */

import { createHash } from 'node:crypto';
import { digestOf, type FileDigest } from './digests.js';
import type { SkillDef, SkillExplain, SkillReference, SkillSource } from './catalog.js';

/** A skill as it appears in a list. Deliberately has no `body`. */
export interface SkillSummary {
  id: string;
  name: string;
  /** The agent-facing trigger text — the field that decides relevance. */
  description: string;
  tags: string[];
  produces: string[];
  source: SkillSource;
  explain?: SkillExplain;
  /** Reference file *paths*. Contents are fetched with the body, never here. */
  references: string[];
  /** Hash of everything that lands on disk. Changes iff an install would differ. */
  contentSha256: string;
  /** Total UTF-8 bytes of the installed content — what this skill costs to load. */
  byteSize: number;
}

/** A reference's digest, carrying the path it belongs to. */
type RefDigest = FileDigest & { rel: string };

/**
 * What a reference weighs and hashes to.
 *
 * A summary is built on the LIST path, where reading reference files is the
 * whole cost this module exists to avoid — 125,870 bytes of bundled reference
 * text per listing, when the answer is a fixed property of files the build
 * already saw. A bundled reference therefore carries its own digest, served
 * from the build-time manifest off a `stat` (see ./digests.ts); an in-memory
 * reference — a global or imported skill, whose text is already loaded — is
 * hashed directly, which costs no read either.
 */
function digestReferences(refs: readonly SkillReference[]): RefDigest[] {
  // Once per summary, not once per field: on a stale-manifest fallback the
  // digest costs a file read, and asking twice would pay for it twice.
  return refs.map((r) => ({ rel: r.rel, ...(r.digest ?? digestOf(r.content)) }));
}

/**
 * Hash the content an install would write: the skill text plus every reference
 * file, each contributing its path as well as its bytes.
 *
 * References enter as their own sha256 rather than as their text. That is the
 * same commitment — sha256 over the exact bytes an install writes, hashed
 * again inside this one — so `contentSha256` still changes iff an install
 * would differ, but it can be computed without the text being in hand.
 *
 * Paths are sorted so that two loads which discovered the same files in a
 * different order agree, and each field is length-prefixed so that moving a
 * byte across a boundary — `ab` + `c` versus `a` + `bc` — cannot collide.
 *
 * Display metadata (name, tags, explain) is deliberately excluded: renaming a
 * card does not change the bytes on disk, so a cached copy stays valid.
 */
function contentHash(def: SkillDef, refs: RefDigest[]): string {
  const h = createHash('sha256');
  const put = (s: string) => h.update(String(Buffer.byteLength(s, 'utf8'))).update('\0').update(s);

  // `raw` is what a byte-faithful install writes; `body` is what a re-rendered
  // one writes. Hash whichever this skill actually installs.
  put(def.raw ?? def.body);
  for (const ref of [...refs].sort((a, b) => a.rel.localeCompare(b.rel))) {
    put(ref.rel);
    put(ref.sha256);
  }
  return h.digest('hex');
}

function contentBytes(def: SkillDef, refs: RefDigest[]): number {
  let n = Buffer.byteLength(def.raw ?? def.body, 'utf8');
  for (const ref of refs) n += ref.bytes;
  return n;
}

/** Strip a full skill down to what a list needs. */
export function summarize(def: SkillDef): SkillSummary {
  const refs = digestReferences(def.references);
  const summary: SkillSummary = {
    id: def.id,
    name: def.name,
    description: def.description,
    tags: def.tags,
    produces: def.produces,
    source: def.source,
    references: def.references.map((r) => r.rel),
    contentSha256: contentHash(def, refs),
    byteSize: contentBytes(def, refs),
  };
  if (def.explain) summary.explain = def.explain;
  return summary;
}

/**
 * An HTTP entity-tag for a whole catalogue.
 *
 * Built from the per-skill hashes, sorted by id, so that a reshuffled catalogue
 * is not a cache miss — the client's copy is genuinely unchanged.
 */
export function summaryEtag(summaries: SkillSummary[]): string {
  const h = createHash('sha256');
  for (const s of [...summaries].sort((a, b) => a.id.localeCompare(b.id))) {
    h.update(s.id).update('\0').update(s.contentSha256).update('\0');
  }
  return `"${h.digest('hex')}"`;
}
