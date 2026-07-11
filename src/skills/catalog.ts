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
import matter from 'gray-matter';
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
  source: 'bundled' | 'imported';
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
  handoff: {
    tags: ['handoff', 'relay', 'usage limit', 'context limit', 'resume', 'continue', 'session', 'brief', 'pass', 'take', 'blocked', 'multi-agent'],
    produces: ['handoff brief', 'pickup command', 'resumed session'],
  },
  'lean-code': {
    tags: ['lean', 'restraint', 'over-engineering', 'yagni', 'simplicity', 'minimal', 'reuse', 'stdlib', 'native', 'one-liner', 'ponytail'],
    produces: ['restraint ladder', 'smallest working diff', 'reuse over rewrite', 'safety carve-outs preserved'],
  },
};

/** What / how / advantage — three short lines per bundled skill, shown on the
 *  Skills screen so a human (or an agent browsing the catalog) understands each
 *  skill without reading its playbook. Keep every line under ~90 chars. */
const SKILL_EXPLAIN: Record<string, SkillExplain> = {
  'bug-fix': {
    what: 'A gated pipeline for fixing bugs without creating new ones.',
    how: 'Reproduce → audit blast radius → hypothesis-driven root cause → 95% skeptic-checked plan → fix → re-verify.',
    win: 'No duplicate fixes, no symptom patches, no regressions shipped.',
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
  handoff: {
    what: 'The relay: pass unfinished work to another agent instead of losing it.',
    how: 'create_handoff writes done / pending / next step; the next agent runs `baton resume`.',
    win: 'A usage limit costs you a minute, not the whole investigation.',
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
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
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
