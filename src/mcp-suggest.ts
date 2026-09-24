// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `suggest_skills` — the ranking behind "which of these thirty-odd skills does
 * this task need?".
 *
 * Lives here rather than in mcp.ts for the same reason mcp-nudge.ts and
 * mcp-toolsets.ts do: mcp.ts registers tools, and a ranking heuristic changes
 * for reasons — a new tier, a stopword, a different clip — that have nothing to
 * do with tool registration. mcp.ts calls `suggestSkills` and holds no opinion
 * about how a skill is chosen.
 *
 * The order below is structural, and every tier is a JOIN over data Baton
 * already holds rather than an inference — which is why this needs no model and
 * beats semantic matching here: it is grounded in what THIS project actually
 * has.
 */
import { existsSync } from 'node:fs';
import { SKILL_AGENTS, loadCatalog, skillTargetFor } from './skills/install.js';
import type { SkillSource } from './skills/catalog.js';

/**
 * Suggestions per answer. Five, because the point of the whole skill-fetch plan
 * is that an agent reads five one-line descriptions instead of twelve full
 * playbooks — a longer list is the problem again, one layer up.
 */
export const SUGGEST_CAP = 5;

/** Description characters served per suggestion. A bundled description is
 *  keyword-dense trigger text and runs to a paragraph; five of those would blow
 *  the 1k-token answer budget on their own. One clause is enough to choose by,
 *  and `baton skills show <id>` has the rest. */
const SUGGEST_DESC_CHARS = 120;

/** A catalogue entry as the ranking sees it: metadata, install state, and the
 *  two declared relations. Never a body. */
export interface SuggestCandidate {
  id: string;
  name: string;
  description: string;
  tags: string[];
  source: SkillSource;
  /** Present on disk for any supported agent CLI. */
  installed: boolean;
  requires: string[];
  worksWith: string[];
}

/** One line an agent can choose by. */
export interface SkillSuggestion {
  id: string;
  name: string;
  description: string;
  /** Which signal put it here — a fact about this project, not a guess. */
  why: string;
}

/** Words that carry no signal in a task sentence. Short list on purpose: a big
 *  stopword list is a place for bugs to hide, and a stray "with" costs one
 *  spurious token match, not a wrong answer. */
const TASK_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'when', 'what', 'how', 'why',
  'you', 'your', 'are', 'was', 'has', 'have', 'not', 'but', 'use', 'using', 'need', 'about',
  'after', 'before', 'than', 'then', 'out', 'get', 'its', 'some', 'any', 'all', 'new', 'now',
  'without', 'anything', 'something',
]);

/** Crude singular fold so "tests" matches "test". Deliberately not a stemmer —
 *  a stemmer is a dependency and a source of surprises, and this is a ranking
 *  hint, not a search engine. */
const fold = (w: string): string => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);

const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9+#]+/).filter(Boolean);

/** One clause, whitespace flattened, cut on a word boundary. */
function clipDescription(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= SUGGEST_DESC_CHARS) return flat;
  const cut = flat.slice(0, SUGGEST_DESC_CHARS);
  const at = cut.lastIndexOf(' ');
  return `${(at > SUGGEST_DESC_CHARS / 2 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/**
 * Rank a catalogue against a task string.
 *
 * The order is the design's, and every tier is a JOIN rather than an inference:
 *
 *   4. attached to this project (an imported skill lives in `.baton/skills`)
 *   3. a `requires` of an installed skill that is NOT installed — a provable
 *      defect in the current setup, not an opinion
 *   2. the task's words appear in the name, description or tags
 *   1. declared `works-with` of something installed
 *   0. already installed — demoted to last, because you have it
 *
 * A skill with no signal at all is left out entirely: padding to five would
 * teach an agent that the list is noise.
 *
 * Maps and Sets throughout, never object literals: ids arrive from imported
 * frontmatter, and `requires: ["__proto__"]` in an object would read back
 * `Object.prototype` as though it were a skill.
 */
export function rankSkillSuggestions(
  task: string,
  skills: readonly SuggestCandidate[],
  limit = SUGGEST_CAP,
): SkillSuggestion[] {
  const installed = new Set(skills.filter((s) => s.installed).map((s) => s.id));
  // First asker wins, and the scan is id-ordered, so two installed skills
  // wanting the same thing always name the same one.
  const requiredBy = new Map<string, string>();
  const worksWithOf = new Map<string, string>();
  for (const s of [...skills].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!s.installed) continue;
    for (const dep of s.requires ?? []) if (!installed.has(dep) && !requiredBy.has(dep)) requiredBy.set(dep, s.id);
    for (const w of s.worksWith ?? []) if (!installed.has(w) && !worksWithOf.has(w)) worksWithOf.set(w, s.id);
  }

  const wanted = [...new Set(wordsOf(task).map(fold))].filter((w) => w.length >= 3 && !TASK_STOPWORDS.has(w));

  const scored: { s: SkillSuggestion; tier: number; score: number }[] = [];
  for (const skill of skills) {
    const haystack = new Set(wordsOf(`${skill.name} ${skill.description} ${(skill.tags ?? []).join(' ')}`).map(fold));
    const hits = wanted.filter((w) => haystack.has(w));

    let tier: number;
    let why: string;
    if (skill.source === 'imported') { tier = 4; why = 'already in this project'; }
    else if (requiredBy.has(skill.id)) { tier = 3; why = `required by ${requiredBy.get(skill.id)}, not installed`; }
    else if (hits.length) { tier = 2; why = `matches: ${hits.slice(0, 3).join(', ')}`; }
    else if (worksWithOf.has(skill.id)) { tier = 1; why = `works with ${worksWithOf.get(skill.id)}`; }
    else continue;                       // no signal — say nothing rather than pad
    if (skill.installed) { tier = 0; why = `installed · ${why}`; }

    scored.push({
      tier,
      score: hits.length,
      s: { id: skill.id, name: skill.name, description: clipDescription(skill.description), why },
    });
  }

  return scored
    .sort((a, b) => b.tier - a.tier || b.score - a.score || a.s.id.localeCompare(b.s.id))
    .slice(0, limit)
    .map((x) => x.s);
}

/** Read the catalogue and rank it. The only part of suggest_skills that touches
 *  disk — install state is `skillTargetFor` + a stat, exactly as the dashboard
 *  listing computes it. */
export async function suggestSkills(root: string, task: string): Promise<SkillSuggestion[]> {
  const catalog = await loadCatalog(root);
  return rankSkillSuggestions(task, catalog.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    tags: s.tags,
    source: s.source,
    installed: SKILL_AGENTS.some((agent) => existsSync(skillTargetFor(agent, s.id, root)!.path)),
    requires: s.requires,
    worksWith: s.worksWith,
  })));
}
