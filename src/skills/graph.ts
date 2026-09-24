// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The skill graph — two relations, and the walk over them.
 *
 * A skill's text routinely points at another skill by name ("follow the
 * `systematic-debugging` process first"). Install it without that skill and the
 * instruction dangles: no error, no warning, just an agent quietly doing
 * something worse. `requires` is the author saying which names those are.
 * `works-with` is a suggestion — commonly useful together, never installed on
 * its own say-so.
 *
 * **No version ranges and no solver.** A skill is a markdown playbook, not
 * linked code: a name means "the current version of that skill", full stop.
 * npm's resolver is the hardest part of npm, and buying that complexity for a
 * folder of markdown would be a bad trade. If the limitation ever bites it will
 * bite visibly and can be fixed then.
 *
 * **An unknown name is reported, never thrown.** A skill that references one
 * the user has not imported must still install — the reference is a hint about
 * the library, not a precondition on this file. Refusing the install would turn
 * every typo in someone else's frontmatter into a broken skill of yours.
 *
 * Lives beside catalog.ts rather than inside it because catalog.ts is at its
 * 400-line ceiling, and because the relation model (parse + walk) is one idea
 * that the loader merely happens to call.
 *
 * Design: ../../../baton-vault/docs/features/skill-graph.md.
 */
import type { SkillDef } from './catalog.js';

/** The two declared relations, normalised. */
export interface SkillRelations {
  /** Names this skill's text points at; installing without them leaves the
   *  instruction dangling. */
  requires: string[];
  /** Names commonly useful alongside it. Offered, never forced. */
  worksWith: string[];
}

/**
 * A list of names, or nothing.
 *
 * Frontmatter arrives from GitHub imports and pasted uploads, so every shape
 * that is not a list of non-empty strings — a map, a number, a null — reads as
 * "no relation declared" rather than as an error. An author's mistake is not a
 * reason to refuse their skill.
 */
function nameList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
}

/** Pull `requires` / `works-with` out of parsed frontmatter. Both default to
 *  `[]`, which is what "the author declared nothing" means. */
export function parseRelations(data: Record<string, unknown>): SkillRelations {
  return { requires: nameList(data.requires), worksWith: nameList(data['works-with']) };
}

/** What a walk of `requires` found. */
export interface RequiresResolution {
  /** The root and everything it transitively requires, root first, each id
   *  exactly once — the set an install would write. */
  ids: string[];
  /** Names that no skill in the catalogue provides, in the order they were
   *  met, deduped. A warning for the user, never a failure. */
  missing: string[];
}

/**
 * Everything installing `id` should bring with it.
 *
 * Breadth-first from the root, guarded by a visited set, so a cycle
 * (`a requires b`, `b requires a`) terminates and each skill appears once.
 * Cycles are *permitted and harmless* here: there is no build order to satisfy,
 * only a set of files to write.
 *
 * The index is a `Map` and the visited set a `Set` on purpose. Skill ids come
 * from untrusted frontmatter, and in an object literal a `requires:
 * ["__proto__"]` would read back `Object.prototype` as though it were a skill —
 * the same reasoning as `skills/quarantine.ts` and `skills/usage.ts`. A Map key
 * is just a string, so a skill genuinely named `__proto__` also resolves
 * normally.
 *
 * An unknown root is reported in `missing` and yields no ids: the caller asked
 * for something that does not exist, and inventing it would be worse than
 * saying so.
 */
export function resolveRequires(id: string, skills: readonly SkillDef[]): RequiresResolution {
  const index = new Map(skills.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const missing = new Set<string>();
  const ids: string[] = [];

  const queue = [id];
  while (queue.length) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    const skill = index.get(next);
    if (!skill) { missing.add(next); continue; }
    ids.push(next);
    for (const dep of skill.requires) if (!seen.has(dep)) queue.push(dep);
  }
  return { ids, missing: [...missing] };
}
