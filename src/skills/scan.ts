// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Content scan for an imported skill.
 *
 * Baton fences text it did not write — plan task text, handoff bodies — as
 * untrusted DATA. That defence deliberately does not extend to skills, and
 * cannot: a skill **is** instructions. `installSkill` writes it to
 * `.claude/skills/<id>/SKILL.md`, where the agent's own harness loads it as
 * directive text. Quoting it would break the feature it exists to provide.
 *
 * So the defence for a downloaded skill is a review gate, and this is the
 * reading aid for that review — nothing more. **It cannot decide intent, and
 * nothing built on it may claim it does.** A skill that produces no findings is
 * *unreviewed*, never *safe*. Its job is to put the dangerous-looking lines in
 * front of a person with line numbers, so that reading the skill is the easy
 * path and installing it unread is the deliberate one.
 *
 * Design note on why this is regexes over a normalised line rather than clever
 * patterns: the input is hostile by assumption, and elastic patterns
 * (`\s*`-between-everything, nested quantifiers) are how a scanner becomes the
 * denial of service. Normalising first — strip invisible characters, collapse
 * whitespace, lowercase — makes every pattern a plain literal, which is linear
 * by construction.
 *
 * Shape adapted from hermes-agent's `tools/skills_guard.py` (MIT, Nous
 * Research): quarantine + scan + audit. Concept only, no code vendored.
 */

/** Longest excerpt returned per finding — a review needs the line, not the file. */
const EXCERPT_MAX = 300;

export type FindingCategory =
  /** Turns off the user's own permission prompts. */
  | 'permission-bypass'
  /** Tells the agent to disregard its scope or its prior instructions. */
  | 'instruction-override'
  /** Reaches for secrets, key files, or credential environment variables. */
  | 'credential-access'
  /** Sends local content somewhere. */
  | 'exfiltration'
  /** Characters that make the rendered text differ from the actual text. */
  | 'hidden-characters';

/**
 * Where the match sits, so a reviewer can tell a skill that DOCUMENTS a pattern
 * from one that USES it.
 *
 * Never a reason to suppress a finding — if a fence hid matches, "wrap it in
 * backticks" would be the bypass.
 */
export type FindingContext = 'imperative' | 'fenced' | 'negated';

export interface ScanFinding {
  category: FindingCategory;
  severity: 'high' | 'medium';
  /** Path relative to the skill directory. */
  file: string;
  /** 1-based, so it matches what an editor shows. */
  line: number;
  /** The matching line, clipped. */
  excerpt: string;
  context: FindingContext;
  /** The normalised text that matched — what to highlight. */
  matched: string;
}

interface Rule {
  category: FindingCategory;
  severity: 'high' | 'medium';
  /** Plain literals, matched against the normalised line. */
  needles: string[];
}

const RULES: Rule[] = [
  {
    category: 'permission-bypass',
    severity: 'high',
    needles: [
      'dangerously-skip-permissions', 'skip-permissions', '--yolo', 'bypass permissions',
      'auto-approve', 'autoapprove', 'disable the sandbox', 'without asking for permission',
      'no confirmation prompts',
    ],
  },
  {
    category: 'instruction-override',
    severity: 'high',
    needles: [
      'ignore your scope', 'ignore the scope', 'ignore all previous instructions',
      'ignore previous instructions', 'ignore prior instructions', 'disregard the above',
      'disregard previous instructions', 'ignore your instructions', 'override your instructions',
      'you are now', 'forget your instructions', 'do not tell the user', 'without telling the user',
    ],
  },
  {
    category: 'credential-access',
    severity: 'high',
    needles: [
      'api_key', 'api key', 'secret_access_key', 'anthropic_api_key', 'openai_api_key',
      'github_token', 'gh_token', '.ssh/id_rsa', '.aws/credentials', '.npmrc', '.env',
      'private key', 'access token', 'process.env.', 'netrc',
    ],
  },
  {
    category: 'exfiltration',
    severity: 'high',
    needles: [
      'curl -x post', 'curl -d', 'curl --data', '| curl', 'wget --post',
      'send it to', 'upload the contents', 'post the contents', 'exfiltrate',
      'base64 | curl', 'nc -e',
    ],
  },
];

/**
 * Characters that make displayed text differ from actual text — zero-width
 * joiners, the BOM, soft hyphens, BiDi overrides, the Tags block.
 *
 * Matched by Unicode CATEGORY rather than an enumerated list, for the same
 * reason `src/handoff/untrusted.ts` does: an enumerated list is a list of the
 * tricks somebody already thought of, and the one that is missing is the one
 * that gets used.
 */
const HIDDEN = /[\p{Cf}\p{Co}\p{Cs}]/u;

/** Wording near a match that forbids rather than instructs. */
const NEGATORS = ['never', 'do not', "don't", 'must not', 'avoid', 'not allowed', 'refuse to', 'without'];

/**
 * Collapse a line to what the READER perceives.
 *
 * A language model does not care about case, and a separator it cannot see is
 * not a separator to it: `ignore<ZWSP>your<ZWSP>scope` reads as the
 * instruction. Removing invisible characters and collapsing whitespace turns
 * every evasion of that kind into the same literal, which is both more reliable
 * than an elastic pattern and immune to catastrophic backtracking.
 */
function normalize(line: string): string {
  return line
    .replace(/[\p{Cf}\p{Co}\p{Cs}]/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(line: string, needle: string): string {
  const t = line.trim();
  if (t.length <= EXCERPT_MAX) return t;
  // Centre the window on the match, so a long line still shows the reason.
  const at = t.toLowerCase().indexOf(needle.split(' ')[0] ?? '');
  const from = Math.max(0, (at === -1 ? 0 : at) - 60);
  return `…${t.slice(from, from + EXCERPT_MAX)}…`;
}

/**
 * Scan a skill's files.
 *
 * Pure: no filesystem, no network, no clock, no randomness — so every evasion
 * attempt is a unit test, and the same skill always produces the same review.
 */
export function scanSkill(files: readonly { rel: string; content: string }[]): ScanFinding[] {
  const out: ScanFinding[] = [];

  for (const file of files) {
    if (!file.content) continue;
    const lines = file.content.split('\n');
    let inFence = false;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!;
      const trimmed = raw.trimStart();
      if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
        inFence = !inFence;
        continue;
      }
      const norm = normalize(raw);

      // Invisible characters are judged on the RAW line: normalising strips
      // them, which is exactly the thing being reported.
      if (HIDDEN.test(raw)) {
        out.push({
          category: 'hidden-characters', severity: 'medium', file: file.rel, line: i + 1,
          excerpt: clip(raw.replace(/[\p{Cf}\p{Co}\p{Cs}]/gu, '·'), ''),
          context: inFence ? 'fenced' : 'imperative',
          matched: 'invisible character',
        });
      }
      if (!norm) continue;

      for (const rule of RULES) {
        for (const needle of rule.needles) {
          if (!norm.includes(needle)) continue;
          const before = norm.slice(0, norm.indexOf(needle));
          const negated = NEGATORS.some((n) => before.includes(n));
          out.push({
            category: rule.category, severity: rule.severity, file: file.rel, line: i + 1,
            excerpt: clip(raw, needle),
            context: inFence ? 'fenced' : negated ? 'negated' : 'imperative',
            matched: needle,
          });
          break; // One finding per rule per line: a reviewer reads the line once.
        }
      }
    }
  }

  // Stable order so two scans of the same skill are byte-identical, and so a
  // reviewer reads the file top to bottom.
  return out.sort((a, b) =>
    a.file.localeCompare(b.file) || a.line - b.line || a.category.localeCompare(b.category));
}
