/* ============================================================
   BATON — demo skill catalog
   Mirrors src/skills (catalog + bundled/bug-fix) so the Skills
   screen is fully explorable in demo mode (no daemon). Bodies are
   trimmed for the preview; the real daemon serves the full playbooks
   and ships the bug-fix reference files alongside each install.
   ============================================================ */
import type { SkillStatus } from "../types";

const BUG_FIX_BODY = `# Bug Fix Skill (portable)

Fix bugs systematically. The order is non-negotiable:

\`\`\`
REPRODUCE-FIRST + TRIAGE → SYNC → MAP (audit) → MULTI-AGENT AUDIT → BLAST RADIUS →
ROOT CAUSE → WRITTEN PLAN → ⛔ CONFIDENCE ≥95% GATE ⛔ → ⛔ WAIT FOR APPROVAL ⛔ →
TEST → FIX → DRY/PERF QUALITY GATE → RE-VERIFY (symptom gone + skeptic) →
REPORT → COMMIT (auto) → ⛔ ASK BEFORE PUSH ⛔
\`\`\`

**Golden rules (excerpt)**
1. REPRODUCE BEFORE YOU FIX. If it doesn't reproduce on current code → STOP.
2. SYNC BEFORE YOU AUDIT. Audit the *current* code, not stale code.
3. AUDIT EVERY FILE THE FIX COULD TOUCH. Don't reason about code you haven't read.
4. NO FIX WITHOUT ROOT CAUSE. Symptom patches are forbidden.
5. ⛔ CONFIDENCE ≥ 95% TO EDIT — corroborated by an independent skeptic agent.
6. WRITE THE PLAN, THEN STOP. Wait for explicit approval before editing any file.
7. STOP AND WARN on high blast radius.
8. EDIT ONLY THE FILES IN THE APPROVED PLAN.
9. CLEAN CODE, NOT JUST CORRECT — DRY, no duplication, no avoidable/N+1 calls.
10. RE-VERIFY the symptom is gone; a skeptic adversarially re-checks the diff.
11. COMMIT AUTOMATICALLY when verified — but ⛔ NEVER push without asking.

> Stack-agnostic: substitute this repo's real test/build/graph commands. Optional
> phases (shared registry, dependency graph) are skipped if the project lacks them.

_Ships 3 reference files: a blast-radius checklist, a bugfix report template, and
a multi-session status schema._
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
    id: "bug-fix",
    name: "bug-fix",
    description: "Systematically fix bugs in ANY codebase WITHOUT regressions: reproduce first, audit every file the fix could touch, classify blast radius, find the true root cause, require ≥95% skeptic-corroborated confidence AND an approved plan before editing, re-verify the symptom is gone, then commit automatically but never push without asking.",
    tags: ["bug", "fix", "debug", "error", "crash", "regression", "root cause", "reproduce", "blast radius", "skeptic", "review", "worktree", "commit"],
    produces: ["reproduction", "blast-radius audit", "root-cause analysis", "approved plan", "regression re-verify", "bugfix report", "auto-commit (never pushes)"],
    body: BUG_FIX_BODY,
    source: "bundled",
    references: ["references/blast-radius-checklist.md", "references/report-template.md", "references/status-template.json"],
    installs: [
      { agent: "claude", rel: ".claude/skills/bug-fix/SKILL.md", installed: true },
      { agent: "cursor", rel: ".cursor/rules/bug-fix.mdc", installed: false },
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
    references: [],
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
    references: [],
    installs: [
      { agent: "claude", rel: ".claude/skills/safe-refactor/SKILL.md", installed: false },
      { agent: "cursor", rel: ".cursor/rules/safe-refactor.mdc", installed: false },
    ],
  },
];
