// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The undeclared-mention check.
 *
 * A skill's body says "follow the `systematic-debugging` process first". If
 * that skill is not in `requires`, anyone installing this one gets an
 * instruction pointing at nothing — and **nothing reports it**. There is no
 * error, no missing file, no failed load: the agent simply improvises, worse.
 * That silence is the whole reason this exists, and it is the same class of
 * defect as a broken `references/x.md` link.
 *
 * It is a regex over ids Baton already knows, and deliberately nothing more —
 * no model, no network, no "did you mean". A check that guesses produces
 * warnings authors learn to ignore, and an ignored warning is worse than none.
 *
 * Pure by construction: body in, names out. No filesystem, no clock, no
 * randomness — so every case (a fence, a hyphen inside a longer id, a hostile
 * id) is a unit test rather than a fixture.
 */
import { isFenceDelimiter } from './scan.js';

/** What to check, and what to check it against. */
export interface MentionInput {
  /** The skill's own id — a skill naming itself is not a dependency. */
  id: string;
  /** The playbook text (no frontmatter). */
  body: string;
  /** Every skill id in the library. Only these are ever reported. */
  known: Iterable<string>;
  /** Already-declared relations, which are by definition not undeclared. */
  requires?: readonly string[];
}

/** Characters that make displayed text differ from actual text — stripped
 *  before matching for the same reason scan.ts strips them: a separator the
 *  reader cannot see is not a separator to the model reading the skill. */
const INVISIBLE = /[\p{Cf}\p{Co}\p{Cs}]/gu;

/** An id reaches us from an upload, a URL or a GitHub import. `.*` as a skill
 *  id must match the literal text `.*`, not every line in the file. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every known skill id the body mentions and `requires` does not declare, in
 * the order they first appear.
 *
 * Two matching rules, both narrow on purpose:
 *
 * - **Word boundaries count a hyphen as part of the name.** Plain `\b` would
 *   report `debugging` inside `systematic-debugging`, and `bug-fix` inside
 *   `bug-fixer` — false positives on the most common shape of skill id there
 *   is.
 * - **Fenced blocks are skipped.** A fence is where an author writes the
 *   install command for the very skill they are telling you about; flagging it
 *   would make the check fire hardest on the skills that documented themselves
 *   best. Fence tracking is scan.ts's, not a second copy of it — inline
 *   backticks are NOT skipped, because "follow `systematic-debugging`" in prose
 *   is precisely the case this exists to catch.
 */
export function undeclaredMentions(input: MentionInput): string[] {
  // Map, not an object: ids are untrusted text, and `__proto__` as an object
  // key is a pollution vector where as a Map key it is just a string.
  const byLower = new Map<string, string>();
  for (const id of input.known) {
    const key = id.trim().toLowerCase();
    if (key && !byLower.has(key)) byLower.set(key, id);
  }

  const declared = new Set<string>([input.id, ...(input.requires ?? [])].map((s) => s.trim().toLowerCase()));
  for (const key of declared) byLower.delete(key);
  if (!byLower.size || !input.body) return [];

  // Longest first, so `systematic-debugging` wins over a hypothetical
  // `systematic` at the same position rather than losing to alternation order.
  const alts = [...byLower.keys()].sort((a, b) => b.length - a.length).map(escapeRegex);
  const mention = new RegExp(`(?<![\\w-])(?:${alts.join('|')})(?![\\w-])`, 'g');

  const found: string[] = [];
  const seen = new Set<string>();
  let inFence = false;
  for (const line of input.body.split('\n')) {
    if (isFenceDelimiter(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    // Matched against the line as the READER perceives it: invisible characters
    // removed and case folded, so `Code-Review` and a zero-width-spliced id
    // report the same way the visible spelling would.
    const text = line.replace(INVISIBLE, '').toLowerCase();
    mention.lastIndex = 0;
    for (let m = mention.exec(text); m; m = mention.exec(text)) {
      const id = byLower.get(m[0]);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      found.push(id);
    }
  }
  return found;
}
