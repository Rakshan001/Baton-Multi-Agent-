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
import { parseRelations } from './graph.js';
import { existsSync } from 'node:fs';
import { lazyReference, type FileDigest } from './digests.js';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export interface SkillReference {
  /** Path relative to the skill dir, e.g. "references/blast-radius-checklist.md". */
  rel: string;
  /**
   * The file's text. For a bundled skill this is a lazy getter — see
   * {@link lazyReference} — so listing skills costs the directory entry and
   * none of the bytes.
   */
  content: string;
  /** Size and hash of {@link content}, for a caller that must weigh or
   *  fingerprint the file without loading it — a listing does exactly that.
   *  Bundled references answer it from a build-time manifest (./digests.ts). */
  readonly digest?: FileDigest;
  /**
   * The read, with failure told apart from emptiness: `null` means the file
   * could not be read, `''` means it read as empty.
   *
   * `content` collapses both to `''`, which is right for a property access
   * mid-render but wrong for a caller about to WRITE the bytes somewhere. An
   * install that cannot tell them apart writes a zero-byte reference file,
   * counts it, and reports a `digest` taken from the manifest — a hash over
   * bytes it never wrote. Present only on lazy (bundled) references; a caller
   * that must not guess should check for it rather than assume it.
   */
  readonly tryContent?: () => string | null;
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
  /** Skills this one's text names — installing without them dangles the
   *  instruction — and skills merely useful with it. Declared; see ./graph.ts. */
  requires: string[];
  worksWith: string[];
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
  'prompt-master': {
    tags: ['prompt', 'prompt engineering', 'prompt master', 'write a prompt', 'improve prompt', 'rewrite prompt', 'fix prompt', 'system prompt', 'few-shot', 'role assignment', 'grounding', 'hallucination', 'token efficiency', 'decompiler', 'claude code', 'cursor', 'windsurf', 'cline', 'codex', 'devin', 'copilot', 'antigravity', 'gpt', 'gemini', 'grok', 'llama', 'qwen', 'deepseek', 'ollama', 'midjourney', 'dall-e', 'stable diffusion', 'comfyui', 'sora', 'runway', 'kling', 'elevenlabs', 'meshy', 'v0', 'bolt', 'lovable', 'perplexity', 'zapier', 'n8n', 'image ai', 'video ai', 'voice ai'],
    produces: ['target-tool routing', 'one paste-ready prompt', 'intent extraction (9 dimensions)', 'diagnostic fixes (37 patterns)', 'grounding + scope locks', 'agentic stop conditions'],
  },
  'stack-migration': {
    tags: ['migrate', 'migration', 'port', 'convert', 'rewrite', 'angular', 'react', 'next.js', 'nextjs', 'vue', 'nestjs', 'express', 'framework', 'stack', 'phase', 'parity', 'endpoints', 'components', 'dry', 'reuse', 'resumable', 'ledger', 'parallel', 'multi-agent', 'fan-out', 'worktree', 'cursor', 'codex', 'antigravity', 'handoff'],
    produces: ['codebase inventory', 'ordered phase plan', 'MIGRATION.md ledger', 'reuse index', 'per-phase parity re-verify', '95% skeptic gate', 'auto-commit per phase (never pushes)', 'parallel fan-out plan + per-phase HANDOFF briefs'],
  },
  'create-baton-skill': {
    tags: ['skill', 'skills', 'create skill', 'write skill', 'author skill', 'new skill', 'improve skill', 'upgrade skill', 'score skill', 'skill quality', 'meta', 'authoring', 'archetype', 'gate', 'approval gate', 'skeptic', 'rubric', 'checkpoint', 'ledger', 'catalog', 'frontmatter', 'description', 'triggers', 'lint', 'scanner', 'playbook', 'workflow'],
    produces: ['restraint-ladder verdict', 'plain-language authoring interview', 'archetype classification', 'baseline failure transcript', 'gate-library assembly', 'drafted SKILL.md', 'archetype-aware rubric score', 'skeptic re-score (lower wins)', 'compliance + loophole closing', 'mechanical check pass', 'catalog registration + installs'],
  },
  'monolith-split': {
    tags: ['split', 'separate', 'extract', 'decouple', 'monolith', 'microservice', 'service', 'backend', 'frontend', 'api', 'next.js', 'nextjs', 'nestjs', 'fastify', 'express', 'fastapi', 'go', 'spring', 'django', 'rails', 'monorepo', 'boundary', 'network boundary', 'contract', 'strangler', 'proxy', 'feature flag', 'checkpoint', 'rollback', 'cutover', 'parity', 'authorization', 'cors', 'serialization', 'transaction', 'resumable', 'ledger'],
    produces: ['plain-language split interview', 'STAYS/MOVES/SHARED classification', '17-category seam inventory', 'golden-master capture', 'SPLIT.md ledger', 'reversible checkpoints (flag + tag + revert line)', 'proven-no-op CP-0 + rollback drill', 'differential parity (flag off vs on)', '95% skeptic gate', 'auto-commit per checkpoint (never pushes)'],
  },
  'llm-council': {
    tags: ['council', 'debate', 'second opinion', 'pressure-test', 'stress-test', 'multiple perspectives', 'karpathy', 'decision', 'tradeoff', 'architecture', 'peer review', 'chairman', 'subagents', 'parallel'],
    produces: ['worth-it gate + prior-verdict recall', 'neutral decision brief', '3-5 lens seating with stated tensions', 'independent parallel member answers (grounded or [unverified])', 'diversity check + at most one re-seat', 'shuffled anonymized peer review with FINAL RANKING tally', 'chairman verdict (recommendation, confidence, overturn conditions, first step)', 'transcript in the hub .baton/council/ + advisory decision memory (updated when you decide)'],
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
  'create-baton-skill': {
    what: 'Author a skill \u2014 or upgrade one \u2014 to the bar of a production gated pipeline.',
    how: 'Restraint gate \u2192 archetype \u2192 baseline failure test \u2192 gate library \u2192 rubric + skeptic score that blocks below 85.',
    win: 'Skills stop being vague checklists: right shape, real gates, and tested against an agent that tries to skip them.',
  },
  'monolith-split': {
    what: 'Split one codebase into an app + its own backend service, without the running app ever breaking.',
    how: 'Plain-language interview → seam inventory → golden master → reversible checkpoints (flag + tag) at ≥95% parity.',
    win: 'A function call becomes a network boundary without losing an authz check, a transaction, or a field.',
  },
  'map-codebase': {
    what: 'Builds the repo map every other skill navigates by.',
    how: '`baton kb rebuild` → knowledge graph + CODEBASE.md, served to agents over MCP.',
    win: 'Orienting costs hundreds of tokens instead of hundreds of thousands.',
  },
  'prompt-master': {
    what: 'Turns a rough idea into a paste-ready prompt tuned for the exact tool you are aiming at.',
    how: 'Extracts intent across 9 dimensions, routes to that tool\u2019s own template, then audits 37 credit-killing patterns.',
    win: 'The prompt works on the first paste \u2014 no re-prompt loop quietly burning tokens.',
  },
  'safe-refactor': {
    what: 'Restructure code without changing behavior.',
    how: 'Green test baseline → isolated worktree → small steps → graph-checked callers.',
    win: 'Refactors land without breaking the caller you forgot existed.',
  },
  'llm-council': {
    what: 'Pressure-tests one consequential decision with a small council of independent lenses.',
    how: 'Gate → neutral brief → seat 3-5 lenses → parallel grounded answers → anonymized peer review → chairman verdict.',
    win: 'A recommendation with a confidence level and what would overturn it — never acted on without your go-ahead.',
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
    requires: [], worksWith: [],
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
    requires: [], worksWith: [],
    explain: SKILL_EXPLAIN['safe-refactor'],
  },
];

/* ---- file-backed loader (cached — bundled skills never change at runtime) ----
   Reference files are named here and read only on demand: see lazyReference in ./digests.ts. */

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
    let entries: { name: string; isDirectory(): boolean }[] = [];
    try { entries = await readdir(refDir, { withFileTypes: true }); } catch { entries = []; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) continue;   // a reference is a file; readFile would have thrown anyway
      references.push(lazyReference(BUNDLED_DIR, id, `references/${e.name}`));
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
    ...parseRelations(data),
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
