/**
 * Bundled skill catalog — the curated, searchable set of reusable agent
 * workflows Baton ships with. A "skill" is a named, self-contained markdown
 * playbook (objective + step-by-step instructions) that any agent can install
 * into its own config dir and invoke; install.ts renders each one into the
 * format a given CLI understands (.claude/skills/<id>/SKILL.md, .cursor/rules).
 *
 * Adding a bundled skill is a one-entry change here. Imported skills (from a
 * path or URL) live alongside these at runtime via install.ts's import path,
 * read out of <repo>/.baton/skills, and carry source: 'imported'.
 */

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
  /** The full playbook body rendered into each agent's skill file. */
  body: string;
  source: 'bundled' | 'imported';
}

const BUG_FIX_BODY = `# Common bug fix

Resolve reported bugs in this repository methodically, with Baton's knowledge
base and worktrees doing the heavy lifting. Do **not** start editing until you
can name the root cause with high confidence.

## 1. Map the codebase first

- If \`CODEBASE.md\` is missing or stale, build the repo map: \`baton kb init\`
  then \`baton kb rebuild\`. This produces the graphify knowledge graph and a
  compact \`CODEBASE.md\` (~hundreds of tokens) instead of reading every file
  (~hundreds of thousands).
- Read \`CODEBASE.md\`, then \`AGENTS.md\` / \`CLAUDE.md\` if present, to learn the
  conventions you must not break.
- Recall what past sessions already learned: \`baton memory recall\` (or the
  \`recall_memory\` MCP tool). Trust only facts marked fresh.

## 2. Locate the core files for THIS bug

- Use the knowledge graph to navigate to the symbols involved rather than
  grepping blindly. Read the handful of files that actually own the behaviour.
- Reproduce the bug. Capture the exact failing command / test / input.

## 3. Gate on confidence (95%)

- Write down the root cause in one or two sentences. If you are **not ≥95%
  confident**, keep investigating — add logging, read callers, check git blame.
- Only proceed to a fix once the root cause is certain. A plausible guess is not
  a root cause.

## 4. Fix one bug at a time, in isolation

For each bug, work in its own isolated git worktree so parallel fixes never
clobber one another:

- \`baton new "fix: <short bug title>"\` creates a branch + worktree under
  \`.baton/wt/<slug>\`. Do the fix there.
- Before editing a file, check Baton's live edit signals (the \`check_files\`
  MCP tool, or \`baton signals\`) so you don't collide with another agent on the
  same file. Conflicts are surfaced before they happen, not after.
- Make the smallest change that fixes the root cause. Match the surrounding
  code's style.

## 5. Verify, record, hand off

- Run the build and the test suite. The fix is not done until they pass and the
  original reproduction no longer reproduces.
- Save what you learned with \`baton memory add "…" --files <touched files>\` so
  the next agent doesn't rediscover it.
- When the worktree is green, hand it back: \`baton pass <slug>\` writes a
  HANDOFF.md (objective, what changed, remaining risk) and routes it on, or
  merge it: \`baton merge <slug>\`.
- Then move to the next bug and repeat from step 2.
`;

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

export const BUNDLED_SKILLS: SkillDef[] = [
  {
    id: 'common-bug-fix',
    name: 'Common bug fix',
    description: 'Map the repo, find the core files, confirm the root cause to 95% confidence, then fix bugs one at a time in isolated worktrees.',
    tags: ['bug', 'fix', 'debug', 'error', 'crash', 'regression', 'root cause', 'worktree'],
    produces: ['CODEBASE.md', 'knowledge graph', 'worktree per bug', 'memory'],
    body: BUG_FIX_BODY,
    source: 'bundled',
  },
  {
    id: 'map-codebase',
    name: 'Map this codebase',
    description: 'Build the graphify knowledge graph and CODEBASE.md so agents navigate a compact map instead of reading the whole repo.',
    tags: ['map', 'graphify', 'knowledge graph', 'codebase', 'index', 'navigate', 'onboarding'],
    produces: ['CODEBASE.md', 'knowledge graph'],
    body: MAP_BODY,
    source: 'bundled',
  },
  {
    id: 'safe-refactor',
    name: 'Safe refactor',
    description: 'Restructure code without changing behaviour, using worktrees, a green test baseline, and the knowledge graph to find every caller.',
    tags: ['refactor', 'cleanup', 'restructure', 'rename', 'move', 'worktree', 'tests'],
    produces: ['worktree', 'knowledge graph', 'memory'],
    body: REFACTOR_BODY,
    source: 'bundled',
  },
];
