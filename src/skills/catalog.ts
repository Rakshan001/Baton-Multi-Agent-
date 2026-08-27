// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Skill catalog — the curated, searchable set of reusable agent workflows Baton
 * ships with. A "skill" is a named markdown playbook (objective + steps) that an
 * agent can install into its own config dir and invoke. There are two kinds:
 *
 *   - File-backed skills under ./bundled/<id>/ — a real SKILL.md (with YAML
 *     frontmatter) plus an optional references/ folder of supporting files
 *     loaded on demand. These can be multi-KB and multi-file; we keep them as
 *     editable files rather than embedding them as strings. (The build copies
 *     ./bundled into dist/skills/bundled — see scripts/copy-assets.mjs.)
 *   - Inline skills — short single-file playbooks defined right here.
 *
 * install.ts renders each into the format a given CLI understands
 * (.claude/skills/<id>/SKILL.md + references/, or .cursor/rules/<id>.mdc).
 * Imported skills (from a path/URL) live alongside these at runtime, read out of
 * <repo>/.baton/skills, and carry source: 'imported'.
 */
import { parseFrontmatter } from '../util/frontmatter.js';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export interface SkillReference {
  /** Path relative to the skill dir, e.g. "references/blast-radius-checklist.md". */
  rel: string;
  content: string;
}

/** The human-facing 3-line explainer shown on skill cards: what the skill is,
 *  how it works, and the advantage. Distinct from `description`, which is the
 *  agent-facing trigger text (long, keyword-dense) — humans need three short
 *  lines, not a paragraph. */
export interface SkillExplain {
  what: string;
  how: string;
  win: string;
}

/**
 * Where a skill came from, which decides what may be done to it.
 *
 * 'bundled' ships inside the npm package: read-only, never exported (exporting
 * it would just re-download what npm already delivered) and never deleted.
 * 'global' and 'imported' are the user's own — both exportable and deletable;
 * they differ only in reach, and the dashboard groups them together as
 * "Your skills".
 */
export type SkillSource = 'bundled' | 'global' | 'imported';

/**
 * What a skill is *for*, so 30+ skills can be filtered instead of scrolled.
 *
 * Deliberately coarse — a taxonomy with a category per skill sorts nothing. The
 * test is what a person is trying to do when they open the list: decide what to
 * build ('plan'), change code ('code'), make it look right ('frontend'), check
 * someone's work ('review'), exercise a running thing ('test'), pull data
 * ('data'), or carry knowledge between sessions ('context').
 */
export type SkillCategory =
  | 'plan' | 'code' | 'frontend' | 'review' | 'test' | 'data' | 'context';

/** Category per bundled skill. Imported skills fall back to 'code'. */
const CATEGORY: Record<string, SkillCategory> = {
  // decide what to build
  'validate-idea': 'plan', 'plan-review': 'plan', 'dispatch-plan': 'plan', 'basic-setup': 'plan',
  // change code
  'bug-fix': 'code', 'lean-code': 'code', 'safe-refactor': 'code', 'stack-migration': 'code',
  'token-efficient-coding': 'code', 'traceable-changes': 'code', 'full-output': 'code',
  // make it look right
  'design-taste': 'frontend', 'gpt-taste': 'frontend', 'stitch-design': 'frontend',
  'style-minimalist': 'frontend', 'style-brutalist': 'frontend', 'style-soft': 'frontend',
  'design-redesign': 'frontend', 'image-to-code': 'frontend', 'design-options': 'frontend',
  'design-audit': 'frontend', 'imagegen-web': 'frontend', 'imagegen-mobile': 'frontend',
  brandkit: 'frontend',
  // check someone's work
  'code-review': 'review', 'verify-before-done': 'review',
  // exercise a running thing
  'browser-qa': 'test', 'onboarding-audit': 'test',
  // pull data
  scrape: 'data', 'scrape-to-skill': 'data',
  // carry knowledge between sessions
  handoff: 'context', 'memory-light': 'context', 'map-codebase': 'context',
};

export interface SkillDef {
  id: string;
  /** Display name. */
  name: string;
  /** One-line summary an agent uses to decide relevance — keep it searchable. */
  description: string;
  /** Free-text keywords for search (beyond words already in name/description). */
  tags: string[];
  /** Baton artifacts the skill reads or produces, surfaced as chips in the UI. */
  produces: string[];
  /** The playbook body (no frontmatter). */
  body: string;
  /** Supporting files installed alongside the skill (loaded on demand by the agent). */
  references: SkillReference[];
  source: SkillSource;
  /** What the skill is for — the axis the Skills screen filters on. */
  category: SkillCategory;
  /** 3-line human explainer (what / how / win) for the UI. Bundled skills carry
   *  one; imported skills fall back to their description. */
  explain?: SkillExplain;
  /**
   * Verbatim SKILL.md (frontmatter + body) for skills authored as files. When
   * present and the on-disk `name` already matches the id, Claude installs get
   * this byte-for-byte so a hand-tuned skill isn't reflowed. Inline/imported
   * skills leave this undefined and are re-rendered.
   */
  raw?: string;
}

/** Where file-backed skills live, both compiled (dist/skills/bundled) and in dev (src/skills/bundled). */
const BUNDLED_DIR = fileURLToPath(new URL('./bundled', import.meta.url));

/**
 * Tags/produces for file-backed skills whose SKILL.md frontmatter doesn't carry
 * them (so the source file stays a clean, portable Claude skill). Frontmatter
 * `tags:` / `produces:` arrays, if present, take precedence over these.
 */
const BUNDLED_META: Record<string, { tags: string[]; produces: string[] }> = {
  'basic-setup': {
    tags: ['setup', 'scaffold', 'new project', 'boilerplate', 'starter', 'folder structure', 'project structure', 'architecture', 'mvc', 'feature-sliced', 'clean architecture', 'hexagonal', 'modular monolith', 'microservices', 'best practice', 'convention', 'gitleaks', 'secrets', 'api key', 'env', '.env', 'leak', 'pre-commit', 'hook', 'push protection', 'security', 'devsecops', 'beginner', 'onboarding', 'next.js', 'react', 'vite', 'nuxt', 'nestjs', 'express', 'django', 'fastapi', 'agents.md', 'structure.md', 'audit', 'cleanup'],
    produces: ['plain-language interview', 'structure pattern choice', 'scaffolded project', '.gitleaks.toml + pre-commit hook', 'push protection + CI backstop', '.env.example', 'STRUCTURE.md (humans)', 'AGENTS.md (agents)', 'planted-secret drill proof', 'ranked repair plan (mid-phase)'],
  },
  'bug-fix': {
    tags: ['bug', 'fix', 'debug', 'error', 'crash', 'regression', 'root cause', 'reproduce', 'blast radius', 'skeptic', 'review', 'worktree', 'commit'],
    produces: ['reproduction', 'blast-radius audit', 'root-cause analysis', 'approved plan', 'regression re-verify', 'bugfix report', 'auto-commit (never pushes)'],
  },
  'token-efficient-coding': {
    tags: ['token', 'tokens', 'cost', 'context', 'efficient', 'minimal diff', 'context rot', 'compaction', 'read', 'grep', 'cheap', 'budget'],
    produces: ['targeted reads', 'minimal diffs', 'lower token cost', 'compaction'],
  },
  'traceable-changes': {
    tags: ['traceability', 'atomic commit', 'commit', 'conventional commits', 'worktree', 'blame', 'bisect', 'revert', 'git history', 'audit', 'multi-agent'],
    produces: ['atomic commits', 'isolated worktree', 'conventional messages', 'bisectable history'],
  },
  'memory-light': {
    tags: ['memory', 'context window', 'context rot', 'compaction', 'recall', 'handoff', 'long-horizon', 'multi-session', 'externalize state', 'facts'],
    produces: ['recall-before-explore', 'externalized state', 'durable facts', 'handoff brief'],
  },
  'verify-before-done': {
    tags: ['verify', 'verification', 'double-check', 'hallucination', 'regression', 'skeptic', 'review', 'tests', 'build', 'done', 'symbol exists'],
    produces: ['re-read diff', 'symbol-existence check', 'build/test/lint run', 'independent skeptic re-check'],
  },
  'code-review': {
    tags: ['review', 'code review', 'pr', 'pull request', 'diff', 'branch', 'merge', 'standards', 'conventions', 'spec', 'scope creep', 'code smell', 'fowler', 'security', 'vulnerability', 'injection', 'parallel', 'sub-agent', 'skeptic'],
    produces: ['pinned fixed point', 'standards findings', 'spec findings', 'security findings', 'refuted-first verification', 'routed next steps', 'durable review record (.baton/reviews)'],
  },
  handoff: {
    tags: ['handoff', 'relay', 'usage limit', 'context limit', 'resume', 'continue', 'session', 'brief', 'pass', 'take', 'blocked', 'multi-agent'],
    produces: ['handoff brief', 'pickup command', 'resumed session'],
  },
  'lean-code': {
    tags: ['lean', 'restraint', 'over-engineering', 'yagni', 'simplicity', 'minimal', 'reuse', 'stdlib', 'native', 'one-liner', 'ponytail'],
    produces: ['restraint ladder', 'smallest working diff', 'reuse over rewrite', 'safety carve-outs preserved'],
  },
  'dispatch-plan': {
    tags: ['plan', 'dispatch', 'parallel', 'multi-agent', 'fan-out', 'worktree', 'assign', 'assignee', 'routing', 'phase', 'scope', 'split', 'delegate', 'antigravity', 'codex', 'cursor', 'approve', 'orchestrate', 'coordinate'],
    produces: ['a validated plan file', 'phase + dependency layout', 'per-task scope and acceptance criteria', 'an approval a human gives', 'parallel worktrees'],
  },
  'stack-migration': {
    tags: ['migrate', 'migration', 'port', 'convert', 'rewrite', 'angular', 'react', 'next.js', 'nextjs', 'vue', 'nestjs', 'express', 'framework', 'stack', 'phase', 'parity', 'endpoints', 'components', 'dry', 'reuse', 'resumable', 'ledger', 'parallel', 'multi-agent', 'fan-out', 'worktree', 'cursor', 'codex', 'antigravity', 'handoff'],
    produces: ['codebase inventory', 'ordered phase plan', 'MIGRATION.md ledger', 'reuse index', 'per-phase parity re-verify', '95% skeptic gate', 'auto-commit per phase (never pushes)', 'parallel fan-out plan + per-phase HANDOFF briefs'],
  },
  'validate-idea': {
    tags: ['plan', 'planning', 'product', 'brainstorm', 'idea', 'validate', 'discovery', 'scope', 'ambition', 'wedge', 'demand', 'startup', 'design doc', 'forcing questions', 'diagnostic', 'alternatives'],
    produces: ['goal-routed diagnostic', 'six forcing questions', 'scope mode decision', '2-3 costed alternatives', 'design doc', 'one concrete assignment'],
  },
  'plan-review': {
    tags: ['plan', 'planning', 'architecture', 'review', 'design', 'data flow', 'error handling', 'edge cases', 'test matrix', 'coverage', 'performance', 'scope', 'complexity', 'pre-implementation'],
    produces: ['scope challenge', 'architecture + data-flow map', 'error & rescue map', 'edge-case map', 'test matrix', 'performance pass', 'eng review verdict'],
  },
  'browser-qa': {
    tags: ['qa', 'test', 'testing', 'bugs', 'browser', 'web app', 'quality', 'health score', 'accessibility', 'console', 'forms', 'regression', 'smoke', 'ship', 'verify'],
    produces: ['explored page map', 'evidenced issue list', 'weighted health score', 'atomic fix commits', 'before/after score', 'ship verdict', 'regression baseline'],
  },
  'onboarding-audit': {
    tags: ['dx', 'developer experience', 'onboarding', 'tthw', 'quickstart', 'docs', 'documentation', 'cli', 'sdk', 'api', 'error messages', 'adoption', 'audit', 'scorecard'],
    produces: ['measured TTHW', '8-dimension scorecard', 'evidence tags (TESTED/PARTIAL/INFERRED)', 'quick wins', 'sprint + quarter backlog'],
  },
  'design-audit': {
    tags: ['design', 'visual', 'audit', 'ui', 'typography', 'spacing', 'hierarchy', 'contrast', 'wcag', 'accessibility', 'responsive', 'polish', 'ai slop', 'frontend', 'css'],
    produces: ['first impression', 'extracted design system', 'per-page findings', 'severity classification', 'atomic fix commits', 'design audit verdict'],
  },
  'design-options': {
    tags: ['design', 'ui', 'ux', 'variants', 'options', 'mockup', 'explore', 'brainstorm', 'visual', 'comparison', 'prototype', 'html', 'tokens', 'frontend'],
    produces: ['named concepts', 'self-contained HTML variants', 'comparison board', 'per-variant feedback', 'approved design', 'design tokens'],
  },
  scrape: {
    tags: ['scrape', 'web', 'extract', 'data', 'json', 'fetch', 'parse', 'html', 'read-only', 'metadata', 'json-ld', 'table', 'links'],
    produces: ['one JSON document', 'stable field shape', 'honest blocker report', 'scrape-to-skill handoff'],
  },
  'scrape-to-skill': {
    tags: ['skill', 'codify', 'permanent', 'reusable', 'scrape', 'parser', 'fixture', 'test', 'library', 'automation', 'import'],
    produces: ['pure parser', 'captured HTML fixture', 'a test that can fail', 'approval gate', 'skill in your library'],
  },
  'design-taste': {
    tags: ['design', 'frontend', 'ui', 'taste', 'landing page', 'portfolio', 'gsap', 'motion', 'typography', 'layout', 'anti-slop', 'premium', 'css', 'tailwind'],
    produces: ['brief inference', 'design-system map', 'variance / motion / density dials', 'pre-flight hard-rule check', 'shipped page'],
  },
  'gpt-taste': {
    tags: ['design', 'frontend', 'ui', 'gsap', 'motion', 'awwwards', 'hero', 'bento', 'grid', 'typography', 'scrolltrigger', 'aida', 'premium'],
    produces: ['AIDA page structure', 'hero architecture', 'gapless bento grid', 'GSAP scroll paradigms', 'seeded layout variance'],
  },
  'stitch-design': {
    tags: ['design', 'frontend', 'ui', 'stitch', 'google stitch', 'semantic', 'tokens', 'components', 'generation'],
    produces: ['semantic design rules', 'token vocabulary', 'Stitch-compatible output'],
  },
  'style-minimalist': {
    tags: ['design', 'frontend', 'ui', 'minimalist', 'editorial', 'monochrome', 'notion', 'linear', 'whitespace', 'clean', 'style'],
    produces: ['monochrome palette', 'editorial type scale', 'restrained layout'],
  },
  'style-brutalist': {
    tags: ['design', 'frontend', 'ui', 'brutalist', 'swiss', 'typography', 'contrast', 'raw', 'industrial', 'style'],
    produces: ['Swiss type system', 'extreme scale contrast', 'raw structural layout'],
  },
  'style-soft': {
    tags: ['design', 'frontend', 'ui', 'soft', 'premium', 'depth', 'shadow', 'whitespace', 'animation', 'expensive', 'style'],
    produces: ['premium type pairing', 'depth and shadow system', 'smooth motion'],
  },
  'design-redesign': {
    tags: ['design', 'frontend', 'redesign', 'upgrade', 'audit', 'refresh', 'ai slop', 'legacy', 'css', 'tailwind', 'existing project'],
    produces: ['stack scan', 'AI-fingerprint diagnosis', 'in-place design upgrade'],
  },
  'image-to-code': {
    tags: ['design', 'frontend', 'image', 'reference', 'analysis', 'implementation', 'visual', 'mockup', 'ui'],
    produces: ['reference image', 'deep visual analysis', 'matching implementation'],
  },
  'imagegen-web': {
    tags: ['design', 'image generation', 'reference', 'website', 'concept', 'visual', 'mockup', 'no code'],
    produces: ['website reference images'],
  },
  'imagegen-mobile': {
    tags: ['design', 'image generation', 'mobile', 'app', 'screens', 'flows', 'concept', 'visual', 'no code'],
    produces: ['mobile screen concepts', 'flow concepts'],
  },
  brandkit: {
    tags: ['design', 'brand', 'identity', 'logo', 'palette', 'typography', 'mockup', 'image generation', 'no code'],
    produces: ['logo concepts', 'identity system', 'colour palette', 'type system', 'mockups'],
  },
  'full-output': {
    tags: ['output', 'completeness', 'truncation', 'placeholder', 'laziness', 'code generation', 'exhaustive', 'coding'],
    produces: ['complete files', 'deliverable count check', 'clean token-limit splits'],
  },
};

/** What / how / advantage — three short lines per bundled skill, shown on the
 *  Skills screen so a human (or an agent browsing the catalog) understands each
 *  skill without reading its playbook. Keep every line under ~90 chars. */
const SKILL_EXPLAIN: Record<string, SkillExplain> = {
  'basic-setup': {
    what: 'Starts a project an experienced dev can read — and that can’t leak your keys.',
    how: 'Plain-language interview → pattern ladder → gitleaks hook + push protection + CI → STRUCTURE.md/AGENTS.md → proof drill.',
    win: 'Answer “1” to every question and still get an industry-standard, leak-proof project.',
  },
  'bug-fix': {
    what: 'A gated pipeline for fixing bugs without creating new ones.',
    how: 'Reproduce → audit blast radius → hypothesis-driven root cause → 95% skeptic-checked plan → fix → re-verify.',
    win: 'No duplicate fixes, no symptom patches, no regressions shipped.',
  },
  'dispatch-plan': {
    what: 'Splits big work into a plan several agents can run at once, in separate worktrees.',
    how: 'Phases and `after:` for order, scope globs to keep agents apart, `@agent` to assign — then a human approves.',
    win: 'Parallel work with no collisions, and no agent ever starts paid processes on its own say-so.',
  },
  'lean-code': {
    what: 'The anti-over-engineering reflex (Ponytail’s "lazy senior dev" discipline).',
    how: 'Climbs a restraint ladder — YAGNI → reuse → stdlib → platform → one line — before writing code.',
    win: 'Smaller diffs, fewer dependencies, cheaper reviews; safety code stays untouched.',
  },
  'token-efficient-coding': {
    what: 'Work habits that cut a session’s token burn.',
    how: 'Read the map (CODEBASE.md / graph), not the repo; minimal diffs; never re-read what you know.',
    win: 'Sessions cost a fraction and stay sharp deeper into the context window.',
  },
  'traceable-changes': {
    what: 'Git discipline for repos where several agents commit.',
    how: 'One atomic commit per change, conventional messages, isolated worktrees.',
    win: 'Blame, bisect, and revert always work — any change traces to one commit.',
  },
  'memory-light': {
    what: 'Long-horizon work without dragging the whole history in context.',
    how: 'Recall memory before exploring; externalize state to disk, not the chat.',
    win: 'Sessions resume cheaply and nothing gets re-learned twice.',
  },
  'verify-before-done': {
    what: 'A "done means verified" gate before any completion claim.',
    how: 'Re-read the diff, confirm symbols exist, run build/tests, independent skeptic re-check.',
    win: 'Hallucinated "done" claims die before they ship.',
  },
  'code-review': {
    what: 'Reviews a diff since a fixed point along three axes that are never merged.',
    how: 'Standards, Spec and Security run as parallel sub-agents; every finding must survive a refute pass first.',
    win: 'No axis masks another, findings are verified not guessed, and they outlive the session.',
  },
  handoff: {
    what: 'The relay: pass unfinished work to another agent instead of losing it.',
    how: 'create_handoff writes done / pending / next step; the next agent runs `baton resume`.',
    win: 'A usage limit costs you a minute, not the whole investigation.',
  },
  'stack-migration': {
    what: 'Migrate a codebase to another stack (Angular→Next.js, etc.) feature-by-feature without losing parity.',
    how: 'Inventory → ordered phases → migrate one at ≥95% checked parity; fans out across agents; resumes from MIGRATION.md.',
    win: 'A 100+-file rewrite survives usage limits and lands with no dropped feature or duplicate code.',
  },
  'map-codebase': {
    what: 'Builds the repo map every other skill navigates by.',
    how: '`baton kb rebuild` → knowledge graph + CODEBASE.md, served to agents over MCP.',
    win: 'Orienting costs hundreds of tokens instead of hundreds of thousands.',
  },
  'safe-refactor': {
    what: 'Restructure code without changing behavior.',
    how: 'Green test baseline → isolated worktree → small steps → graph-checked callers.',
    win: 'Refactors land without breaking the caller you forgot existed.',
  },
  'validate-idea': {
    what: 'The "should this exist at all" gate, run before a line of code.',
    how: 'Six forcing questions with anti-sycophancy rules, an explicit scope mode, then 2-3 costed alternatives.',
    win: 'You find out the premise is wrong in an hour instead of a quarter.',
  },
  'plan-review': {
    what: 'Locks the execution plan before any code exists.',
    how: 'Challenge scope → architecture → error/rescue map → edge cases → test matrix → performance → verdict.',
    win: 'Architecture problems surface while they still cost a conversation, not a rewrite.',
  },
  'browser-qa': {
    what: 'Tests the running app like a user, then fixes what breaks.',
    how: 'Click everything, break every form, watch the console — then one atomic commit per fix and re-verify.',
    win: 'Finds breakage code review structurally cannot see; --report-only when someone else fixes.',
  },
  'onboarding-audit': {
    what: 'Walks your own onboarding as a stranger and scores what actually happens.',
    how: 'Times Time-To-Hello-World, scores 8 dimensions, tags each TESTED / PARTIAL / INFERRED.',
    win: 'You learn why adoption stalls before you announce, not from the tracker after.',
  },
  'design-audit': {
    what: 'Visual audit of a live site that ends in committed fixes, not complaints.',
    how: 'First impression → design-system extraction → per-page checklist → fix → atomic commit.',
    win: 'Contrast, focus states and design sprawl get fixed, not just filed.',
  },
  'design-options': {
    what: 'Shows several genuinely different design directions before you commit to one.',
    how: 'Concepts in words first, an anti-convergence rule, HTML variants on one comparison board.',
    win: 'You choose from real options instead of iterating on the first idea anyone had.',
  },
  scrape: {
    what: 'Pulls structured data off a page under a strict read-only contract.',
    how: 'One-line intent → refuse anything mutating → extract → one stable JSON document on stdout.',
    win: 'Pipeable output, and a real blocker report instead of invented results when it fails.',
  },
  'scrape-to-skill': {
    what: 'Turns a scrape that just worked into a permanent, tested skill.',
    how: 'Pure parser + captured fixture + a test that can fail → approval gate → baton skills import.',
    win: 'The next run executes a proven parser, and the fixture proves it still works.',
  },
  'design-taste': {
    what: 'The default frontend design skill — pages that do not look templated.',
    how: 'Infer the brief, map a design system, tune variance / motion / density, then ship against hard pre-flight rules.',
    win: 'Landing pages and portfolios that read as designed, not generated.',
  },
  'gpt-taste': {
    what: 'An opinionated Awwwards-level doctrine for premium, motion-rich pages.',
    how: 'AIDA structure, the 2-line hero rule, gapless bento grids, seeded variance, strict GSAP scroll paradigms.',
    win: 'Breaks the layouts a model reaches for by default, deterministically.',
  },
  'stitch-design': {
    what: 'Google Stitch-compatible semantic rules for AI UI generation.',
    how: 'A semantic token and component vocabulary Stitch understands, held consistent across every screen.',
    win: 'Generated UI stays coherent instead of drifting screen to screen.',
  },
  'style-minimalist': {
    what: 'Clean editorial interfaces in the Notion / Linear register.',
    how: 'Strict monochrome palette, restrained type scale, generous whitespace, no decorative colour.',
    win: 'Calm, dense, professional UI that ages well.',
  },
  'style-brutalist': {
    what: 'Raw mechanical interfaces with Swiss typography. (Beta)',
    how: 'Extreme scale contrast, visible structure, hard edges, a deliberate refusal of softness.',
    win: 'A distinctive look nobody mistakes for a template.',
  },
  'style-soft': {
    what: 'The expensive, soft, high-end look.',
    how: 'Premium type pairing, deep whitespace, layered depth and shadow, smooth motion.',
    win: 'Interfaces that read as considered and costly rather than default.',
  },
  'design-redesign': {
    what: 'Upgrades an existing codebase to premium quality without a rewrite.',
    how: 'Scan the stack, diagnose generic AI design fingerprints, fix in place using the framework already there.',
    win: 'Kills the purple-gradient, Inter-everywhere look without breaking what works.',
  },
  'image-to-code': {
    what: 'Image-first frontend work: generate a reference, then build to match it.',
    how: 'Produce a premium reference image, analyse it deeply, then implement code that matches what it shows.',
    win: 'You agree on the look before any code gets written.',
  },
  'imagegen-web': {
    what: 'Generates premium website design reference images. Writes no code.',
    how: 'Produces reference imagery to direct or approve a look before implementation starts.',
    win: 'Design direction settled visually, without spending a build to find out.',
  },
  'imagegen-mobile': {
    what: 'Generates premium mobile app screen concepts and flows. Writes no code.',
    how: 'Produces screen and flow concepts as images so a mobile direction can be judged early.',
    win: 'See the app before building it.',
  },
  brandkit: {
    what: 'Generates a brand-kit overview — identity, palette, type, mockups.',
    how: 'Logo concepts, an identity system, colour and typography, and mockups rendered as one visual sheet.',
    win: 'A brand direction you can react to in a single look.',
  },
  'full-output': {
    what: 'Stops the model truncating code with placeholder comments.',
    how: 'Bans the "rest of code" family, counts deliverables up front, and splits cleanly at token limits.',
    win: 'You get the whole file, not a skeleton you have to finish yourself.',
  },
};

/* ---- inline single-file skills (short, no references) ---- */

const MAP_BODY = `# Map this codebase

Produce Baton's two navigation artifacts so every later agent reads a map
instead of the whole repo.

## Steps

- \`baton kb init\` — register this repo with the knowledge base if it isn't
  already.
- \`baton kb rebuild\` — build (or incrementally update) the graphify knowledge
  graph and regenerate \`CODEBASE.md\`, the compact repo map.
- Open \`CODEBASE.md\` and sanity-check it: the top-level structure, the entry
  points, and the key modules should be recognisable. If a major area is
  missing, the graph may need a full rebuild: \`baton kb rebuild --full\`.
- Wire the graph into your agent over MCP (the dashboard's **Connect MCP**
  button, or \`baton mcp\`) so you can query symbols directly.

The map costs ~hundreds of tokens to read; the raw repo costs ~hundreds of
thousands. Always navigate from the map.
`;

const REFACTOR_BODY = `# Safe refactor

Restructure code without changing behaviour, using worktrees and the knowledge
graph to stay safe.

## Steps

- Map first (see the *Map this codebase* skill) so you know every caller of the
  code you're about to move. Use the knowledge graph to find references — don't
  rely on grep alone.
- Open an isolated worktree: \`baton new "refactor: <area>"\`. Never refactor on
  a branch another agent is using.
- Establish a green baseline: run the build + tests **before** touching
  anything. If they aren't green, stop — fix or report that first.
- Make the change in small, behaviour-preserving steps. Re-run tests after each
  step. Check edit signals before touching shared files.
- Keep the public API identical unless the task says otherwise. If you must
  change a signature, update every caller the graph found.
- Record any non-obvious decision with \`baton memory add\`, then \`baton pass\`
  or \`baton merge\` the worktree once tests pass.
`;

const INLINE_SKILLS: SkillDef[] = [
  {
    id: 'map-codebase',
    name: 'Map this codebase',
    description: 'Build the graphify knowledge graph and CODEBASE.md so agents navigate a compact map instead of reading the whole repo.',
    tags: ['map', 'graphify', 'knowledge graph', 'codebase', 'index', 'navigate', 'onboarding'],
    produces: ['CODEBASE.md', 'knowledge graph'],
    body: MAP_BODY,
    references: [],
    source: 'bundled',
    category: 'context',
    explain: SKILL_EXPLAIN['map-codebase'],
  },
  {
    id: 'safe-refactor',
    name: 'Safe refactor',
    description: 'Restructure code without changing behaviour, using worktrees, a green test baseline, and the knowledge graph to find every caller.',
    tags: ['refactor', 'cleanup', 'restructure', 'rename', 'move', 'worktree', 'tests'],
    produces: ['worktree', 'knowledge graph', 'memory'],
    body: REFACTOR_BODY,
    references: [],
    source: 'bundled',
    category: 'code',
    explain: SKILL_EXPLAIN['safe-refactor'],
  },
];

/* ---- file-backed loader (cached — bundled skills never change at runtime) ---- */

let fileBackedCache: SkillDef[] | null = null;

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
}

async function loadOneFileSkill(id: string): Promise<SkillDef | null> {
  const skillPath = join(BUNDLED_DIR, id, 'SKILL.md');
  if (!existsSync(skillPath)) return null;
  const raw = await readFile(skillPath, 'utf-8');
  const parsed = parseFrontmatter(raw);
  const data = parsed.data;
  const name = String(data.name ?? id).trim() || id;
  // Folded/multiline YAML descriptions arrive as one string with newlines — flatten.
  const description = String(data.description ?? '').replace(/\s+/g, ' ').trim();

  const references: SkillReference[] = [];
  const refDir = join(BUNDLED_DIR, id, 'references');
  if (existsSync(refDir)) {
    let files: string[] = [];
    try { files = await readdir(refDir); } catch { files = []; }
    for (const f of files.sort()) {
      try {
        references.push({ rel: `references/${f}`, content: await readFile(join(refDir, f), 'utf-8') });
      } catch { /* skip unreadable reference */ }
    }
  }

  const meta = BUNDLED_META[id] ?? { tags: [], produces: [] };
  const fmTags = asStringArray(data.tags);
  const fmProduces = asStringArray(data.produces);
  // raw is byte-faithful only when the on-disk name already equals the id.
  const nameMatchesId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') === id;

  return {
    id,
    name,
    description: description || `The ${id} skill.`,
    tags: fmTags.length ? fmTags : meta.tags,
    produces: fmProduces.length ? fmProduces : meta.produces,
    body: parsed.content.trim() + '\n',
    references,
    source: 'bundled',
    category: CATEGORY[id] ?? 'code',
    explain: SKILL_EXPLAIN[id],
    raw: nameMatchesId ? raw : undefined,
  };
}

async function loadFileBackedSkills(): Promise<SkillDef[]> {
  if (fileBackedCache) return fileBackedCache;
  const out: SkillDef[] = [];
  if (existsSync(BUNDLED_DIR)) {
    let entries: { name: string; isDirectory(): boolean }[] = [];
    try { entries = await readdir(BUNDLED_DIR, { withFileTypes: true }); } catch { entries = []; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        const skill = await loadOneFileSkill(e.name);
        if (skill) out.push(skill);
      } catch { /* skip a malformed bundled skill rather than break the catalog */ }
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  fileBackedCache = out;
  return out;
}

/** All skills Baton ships: file-backed (./bundled) + inline. */
export async function bundledSkills(): Promise<SkillDef[]> {
  return [...(await loadFileBackedSkills()), ...INLINE_SKILLS];
}
