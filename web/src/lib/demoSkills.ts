/* ============================================================
   BATON — demo skill catalog
   Mirrors src/skills/catalog.ts so the Skills screen is fully
   explorable in demo mode (no daemon). Bodies are trimmed for the
   preview; the real daemon serves the full playbooks.
   ============================================================ */
import type { SkillStatus } from "../types";

const BUG_FIX_BODY = `# Common bug fix

Resolve reported bugs methodically, with Baton's knowledge base and worktrees
doing the heavy lifting. Don't start editing until you can name the root cause.

## 1. Map the codebase first
- Build the repo map if missing: \`baton kb init\` → \`baton kb rebuild\` (graphify
  graph + a compact CODEBASE.md, ~hundreds of tokens vs. ~hundreds of thousands).
- Read CODEBASE.md, then AGENTS.md / CLAUDE.md for the conventions you can't break.
- \`baton memory recall\` — trust only facts marked fresh.

## 2. Locate the core files for THIS bug
- Navigate via the knowledge graph, not blind grep. Read the few files that own it.
- Reproduce the bug; capture the exact failing command/test.

## 3. Gate on confidence (95%)
- Write the root cause in one or two sentences. If not ≥95% confident, keep digging.

## 4. Fix one bug at a time, in isolation
- \`baton new "fix: <title>"\` → branch + worktree under .baton/wt/<slug>.
- Check live edit signals before touching a file so you don't collide.
- Smallest change that fixes the root cause; match surrounding style.

## 5. Verify, record, hand off
- Build + tests must pass and the repro must stop reproducing.
- \`baton memory add "…" --files <touched>\`, then \`baton pass <slug>\` or \`baton merge <slug>\`.
`;

const MAP_BODY = `# Map this codebase

- \`baton kb init\` — register this repo with the knowledge base.
- \`baton kb rebuild\` — build the graphify graph + regenerate CODEBASE.md.
- Sanity-check CODEBASE.md; \`baton kb rebuild --full\` if a major area is missing.
- Wire the graph over MCP (dashboard Connect MCP, or \`baton mcp\`).

The map costs ~hundreds of tokens; the raw repo ~hundreds of thousands.
`;

const REFACTOR_BODY = `# Safe refactor

- Map first so you know every caller (use the graph, not just grep).
- \`baton new "refactor: <area>"\` for an isolated worktree.
- Establish a green build + test baseline before touching anything.
- Behaviour-preserving steps; re-run tests after each; check edit signals.
- Keep the public API identical unless told otherwise; update every caller.
- \`baton memory add\`, then \`baton pass\` / \`baton merge\` once green.
`;

export const DEMO_SKILLS: SkillStatus[] = [
  {
    id: "common-bug-fix",
    name: "Common bug fix",
    description: "Map the repo, find the core files, confirm the root cause to 95% confidence, then fix bugs one at a time in isolated worktrees.",
    tags: ["bug", "fix", "debug", "error", "crash", "regression", "root cause", "worktree"],
    produces: ["CODEBASE.md", "knowledge graph", "worktree per bug", "memory"],
    body: BUG_FIX_BODY,
    source: "bundled",
    installs: [
      { agent: "claude", rel: ".claude/skills/common-bug-fix/SKILL.md", installed: true },
      { agent: "cursor", rel: ".cursor/rules/common-bug-fix.mdc", installed: false },
    ],
  },
  {
    id: "map-codebase",
    name: "Map this codebase",
    description: "Build the graphify knowledge graph and CODEBASE.md so agents navigate a compact map instead of reading the whole repo.",
    tags: ["map", "graphify", "knowledge graph", "codebase", "index", "navigate", "onboarding"],
    produces: ["CODEBASE.md", "knowledge graph"],
    body: MAP_BODY,
    source: "bundled",
    installs: [
      { agent: "claude", rel: ".claude/skills/map-codebase/SKILL.md", installed: false },
      { agent: "cursor", rel: ".cursor/rules/map-codebase.mdc", installed: false },
    ],
  },
  {
    id: "safe-refactor",
    name: "Safe refactor",
    description: "Restructure code without changing behaviour, using worktrees, a green test baseline, and the knowledge graph to find every caller.",
    tags: ["refactor", "cleanup", "restructure", "rename", "move", "worktree", "tests"],
    produces: ["worktree", "knowledge graph", "memory"],
    body: REFACTOR_BODY,
    source: "bundled",
    installs: [
      { agent: "claude", rel: ".claude/skills/safe-refactor/SKILL.md", installed: false },
      { agent: "cursor", rel: ".cursor/rules/safe-refactor.mdc", installed: false },
    ],
  },
];
