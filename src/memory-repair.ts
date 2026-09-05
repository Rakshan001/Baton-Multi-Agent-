// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * M3 — mechanical re-anchoring for project memory.
 *
 * A fact carries evidence anchors: `path@hash`, meaning "if this file changes,
 * re-check me". Today any change to an anchored file withholds the fact and
 * asks a human whether it still holds. Most of the time that judgement needs no
 * human and no model: if the change did not touch the part of the file the fact
 * is about, the fact still holds and its anchor should move forward.
 *
 * This module makes only that call, and it makes it as a **pure function** —
 * the caller supplies the before and after content, because reading git is I/O
 * and every decision here has to be a unit test.
 *
 * The asymmetry is the design. A wrongly-withheld fact costs one
 * re-derivation. A wrongly-REFRESHED fact is served to every later session as
 * verified truth — the exact failure this subsystem exists to prevent. So
 * anything undecidable stays stale: `unknown` is a refusal, not a maybe.
 */

import { createHash } from 'node:crypto';

/** Matches src/memory.ts — a fact's anchor hash is a 12-char content sha1. */
const sha1 = (data: string) => createHash('sha1').update(data).digest('hex').slice(0, 12);

/**
 * Beyond this, scanning costs more than the re-derivation it saves — and a
 * generated or vendored file this large is rarely what a fact is really about.
 */
const MAX_SCAN_BYTES = 512_000;

/** A term shorter than this matches too much to be evidence of anything. */
const MIN_TERM = 4;

export type AnchorVerdict =
  /** The change missed this fact's evidence — move the anchor to `hash`. */
  | { kind: 'intact'; hash: string }
  /** The evidence itself changed. Stay stale, with the reason a human reads. */
  | { kind: 'moved'; reason: string }
  /** Not decidable mechanically. Stay stale; this is a refusal, not a maybe. */
  | { kind: 'unknown'; reason: string };

export interface AnchorInput {
  /** Repo-relative path of the anchored file. */
  path: string;
  /** Content when the fact was saved — `null` when it cannot be recovered. */
  before: string | null;
  /** Content now — `null` when the file no longer exists. */
  after: string | null;
}

/**
 * Which of `paths` this text names.
 *
 * One matcher, two callers, and they need **different strictness** because
 * being wrong costs them opposite things:
 *
 * - **Capture** decides what to anchor. A wrong anchor is false evidence that
 *   kills the fact on unrelated churn, so it matches strictly: the path or its
 *   full basename, nothing looser.
 * - **The migration** decides what to un-anchor. Dropping a real anchor leaves
 *   a fact nothing can ever invalidate — served as fresh forever, however wrong
 *   the repo makes it — so it also accepts the basename's **stem**
 *   (`stem: true`), because facts name concepts: "locks go through tmux
 *   session names" is about `src/util/tmux.ts`.
 *
 * Word-boundary matched either way, so `mytoken.tsx` never claims
 * `src/auth/token.ts`. Sorted, so the result never depends on input order.
 */
export function claimedFiles(
  text: string,
  paths: string[],
  opts: { stem?: boolean } = {},
): string[] {
  if (!text) return [];
  const names = (needle: string): boolean => {
    if (!needle || needle.length < 3) return false;
    const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\w/.-])${esc}(?![\\w.-])`).test(text);
  };
  return [...new Set(paths.filter((p) => {
    const base = p.split('/').pop() ?? p;
    if (names(p) || names(base)) return true;
    // `tmux.ts` -> `tmux`. Only for the migration, and only when the stem is
    // distinctive enough to be worth matching on.
    return opts.stem === true && names(base.replace(/\.[^.]+$/, ''));
  }))].sort();
}

/** NUL bytes mean this is not text we can reason about line by line. */
const isBinary = (s: string) => s.includes('\0');

/**
 * The distinctive words a fact is *about*.
 *
 * Identifiers, dotted names and file paths — the things that would actually
 * appear in the code the fact describes. Prose words are deliberately excluded
 * by the length floor: "the guard is central" must not match every line
 * containing "central".
 *
 * Character classes only, no backtracking constructs: this runs over
 * attacker-influenceable text.
 */
function termsOf(fact: string): string[] {
  const words = fact.match(/[A-Za-z_][A-Za-z0-9_./-]{2,}/g) ?? [];
  const terms = new Set<string>();
  for (const w of words) {
    if (w.length < MIN_TERM) continue;
    // A bare lowercase prose word is not evidence; an identifier is. Something
    // that carries a separator or an internal capital is a name, not prose.
    if (/[._/-]/.test(w) || /[a-z][A-Z]/.test(w) || /^[A-Z0-9_]+$/.test(w)) terms.add(w);
  }
  return [...terms].sort();
}

/** `path:42` written inside the fact — an explicit claim about one line. */
function citedLine(fact: string, path: string): number | null {
  const base = path.split('/').pop() ?? path;
  for (const m of fact.matchAll(/([A-Za-z0-9_./-]+):(\d{1,6})(?![\d.])/g)) {
    if (m[1] === path || m[1] === base) return Number(m[2]);
  }
  return null;
}

/**
 * Can this fact keep its anchor on this file?
 *
 * `fact` is the fact's own text — the only description we have of what its
 * evidence actually is, since anchors record a whole-file hash rather than a
 * region.
 */
export function assessAnchor(fact: string, input: AnchorInput): AnchorVerdict {
  const { path, before, after } = input;

  // A deleted file can never be re-anchored: there is nothing left to point at.
  if (after === null) return { kind: 'moved', reason: `${path} no longer exists` };
  // Without the old content there is no change to inspect, so nothing was
  // checked — and "not checked" must never present as "checked and fine".
  if (before === null) return { kind: 'unknown', reason: `no recorded content for ${path} to compare against` };
  if (isBinary(before) || isBinary(after)) return { kind: 'unknown', reason: `${path} is not text` };
  if (before.length > MAX_SCAN_BYTES || after.length > MAX_SCAN_BYTES) {
    return { kind: 'unknown', reason: `${path} is too large to check mechanically` };
  }
  if (before === after) return { kind: 'intact', hash: sha1(after) };

  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  // An explicit `path:42` is the strongest statement a fact can make about its
  // own evidence, so it decides on its own.
  const line = citedLine(fact, path);
  if (line !== null) {
    if (line > afterLines.length) return { kind: 'moved', reason: `${path}:${line} no longer exists` };
    return beforeLines[line - 1] === afterLines[line - 1]
      ? { kind: 'intact', hash: sha1(after) }
      : { kind: 'moved', reason: `${path}:${line} changed` };
  }

  const terms = termsOf(fact);
  // Nothing to look for means nothing was verified. Refreshing on no evidence
  // is the one outcome that would make this whole mechanism dishonest.
  if (terms.length === 0) {
    return { kind: 'unknown', reason: 'the fact names nothing specific enough to check' };
  }

  // Lines that exist on one side only: everything the change added or removed.
  // A line merely MOVED appears on both sides and is correctly ignored — its
  // content, which is what the fact is about, did not change.
  const counts = new Map<string, number>();
  for (const l of beforeLines) counts.set(l, (counts.get(l) ?? 0) - 1);
  for (const l of afterLines) counts.set(l, (counts.get(l) ?? 0) + 1);

  for (const [text, delta] of counts) {
    if (delta === 0) continue;
    for (const t of terms) {
      if (text.includes(t)) return { kind: 'moved', reason: `${path} changed where the fact points ("${t}")` };
    }
  }

  return { kind: 'intact', hash: sha1(after) };
}
