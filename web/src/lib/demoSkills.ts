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

const TOKEN_BODY = `# Token-Efficient Coding (portable)

Spend tokens like money — the smallest set of high-signal tokens that still gets it right.

\`\`\`
ORIENT (map, not repo) → LOCATE (symbol/grep) → READ THE MINIMUM → EDIT MINIMALLY →
DON'T RE-READ → COMPACT WHEN LONG
\`\`\`

**Golden rules (excerpt)**
1. Orient from a map/graph, not a full-repo read (~300× cheaper).
2. Locate the exact symbol (grep/graph) before opening files.
3. Read every region you'll edit IN FULL; read nothing else whole.
4. A file already in context is known — never re-read it.
5. Minimal diffs: only root-cause lines, reuse existing helpers.
6. Batch independent reads/edits; compact before context rot.
7. Quality is never traded for tokens — guessing costs more.

> Baton boost: read CODEBASE.md first, \`query_graph\` for symbols, \`recall_memory\`
> to avoid re-deriving, \`baton usage\` to measure savings.
`;

const TRACE_BODY = `# Traceable Changes (portable)

A commit is the smallest immutable unit of knowledge. Small, isolated, well-described
commits make blame/bisect/revert a one-command answer — even when a different model broke it.

\`\`\`
ISOLATE (worktree/branch) → ONE LOGICAL CHANGE PER COMMIT → MESSAGE STATES WHY →
KEEP DIFFS REVIEWABLE → LEAVE A TRAIL → REVERT IS FIRST-CLASS
\`\`\`

**Golden rules (excerpt)**
1. Isolate each task in its own worktree/branch — parallel agents on one tree clobber silently.
2. One logical change per commit; each commit builds on its own.
3. Message states intent / root cause, not just the diff; link the task.
4. Stage only that change's files (no \`git add -A\` catch-all).
5. No reformatting / unrelated churn — it pollutes blame and bisect.
6. Revert is normal: an atomic commit undoes cleanly.

> Baton boost: \`baton new\` per-task worktrees, \`baton blame\` / who_touched,
> check_files before shared edits, completion reports on merge.
`;

const MEMORY_BODY = `# Memory-Light Context Discipline (portable)

Context is finite and degrades as it fills ("context rot"). Treat context like RAM
and the file system like disk.

\`\`\`
RECALL FIRST → EXTERNALIZE STATE → SAVE DURABLE FACTS → KEEP CONTEXT HIGH-SIGNAL →
COMPACT / HAND OFF BEFORE THE CLIFF
\`\`\`

**Golden rules (excerpt)**
1. Recall what's already recorded before exploring or re-deriving.
2. Write knowledge to storage, not the chat (the chat is re-paid every turn).
3. Externalize task state to a file so it survives compaction/handoff.
4. Save durable, verifiable, evidence-anchored facts — NEVER secrets.
5. Keep live context lean; reference \`file:line\`, drop stale output.
6. Compact or hand off before quality degrades, not after.

> Baton boost: \`recall_memory\` (stale facts withheld), \`save_memory\` (anchored to
> commit + content-hash), CODEBASE.md, \`baton pass\` handoff brief.
`;

const VERIFY_BODY = `# Verify Before Done (portable)

"It compiles" and "I'm done" are claims, not facts. LLMs emit confident code that calls
APIs that don't exist or breaks a caller. Verification + an independent skeptic stops that.

\`\`\`
RE-READ THE DIFF → CONFIRM EVERY SYMBOL EXISTS → BUILD / TEST / LINT →
CONFIRM THE GOAL → INDEPENDENT SKEPTIC RE-CHECK → ONLY THEN DONE
\`\`\`

**Golden rules (excerpt)**
1. Re-read your actual diff, not your memory of it.
2. Every referenced symbol/import/API must exist in THIS codebase + version.
3. Run the real build/tests/lint — don't claim a result you didn't run.
4. Confirm the goal (symptom gone / feature works), not just green.
5. Re-read consumers of any changed interface.
6. The reviewer ≠ the author — a fresh read-only skeptic tries to refute the diff.

> Baton boost: check_files / who_touched, use the bug-fix skill for bugs,
> completion report on merge. Pairs with traceable-changes.
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
    id: "token-efficient-coding",
    name: "token-efficient-coding",
    description: "Work token-efficiently in ANY codebase: navigate a repo map or code graph instead of reading whole files, read the smallest high-signal slice before editing, make minimal surgical diffs, batch tool calls, and never re-read a file already in context. Cuts wasted tokens and cost on every read and edit without lowering quality.",
    tags: ["token", "tokens", "cost", "context", "efficient", "minimal diff", "context rot", "compaction", "read", "grep", "cheap", "budget"],
    produces: ["targeted reads", "minimal diffs", "lower token cost", "compaction"],
    body: TOKEN_BODY,
    source: "bundled",
    references: ["references/token-budget-cheatsheet.md"],
    installs: [
      { agent: "claude", rel: ".claude/skills/token-efficient-coding/SKILL.md", installed: false },
      { agent: "cursor", rel: ".cursor/rules/token-efficient-coding.mdc", installed: false },
    ],
  },
  {
    id: "traceable-changes",
    name: "traceable-changes",
    description: "Make every change traceable so a bug introduced by ANY agent (Claude, Cursor, Codex, Gemini) is easy to find, attribute, and revert: one logical change per commit, a conventional message that states intent and root cause, isolated git worktrees per task, and a clean bisect/blame trail.",
    tags: ["traceability", "atomic commit", "commit", "conventional commits", "worktree", "blame", "bisect", "revert", "git history", "audit", "multi-agent"],
    produces: ["atomic commits", "isolated worktree", "conventional messages", "bisectable history"],
    body: TRACE_BODY,
    source: "bundled",
    references: ["references/commit-conventions.md"],
    installs: [
      { agent: "claude", rel: ".claude/skills/traceable-changes/SKILL.md", installed: false },
      { agent: "cursor", rel: ".cursor/rules/traceable-changes.mdc", installed: false },
    ],
  },
  {
    id: "memory-light",
    name: "memory-light",
    description: "Keep working context lean across long or multi-session work so the model stays sharp and cheap: recall what is already known before exploring, write durable facts to the file system or a memory store (not the chat), externalize task state, and compact or hand off before context rot degrades recall.",
    tags: ["memory", "context window", "context rot", "compaction", "recall", "handoff", "long-horizon", "multi-session", "externalize state", "facts"],
    produces: ["recall-before-explore", "externalized state", "durable facts", "handoff brief"],
    body: MEMORY_BODY,
    source: "bundled",
    references: ["references/recall-save-patterns.md"],
    installs: [
      { agent: "claude", rel: ".claude/skills/memory-light/SKILL.md", installed: false },
      { agent: "cursor", rel: ".cursor/rules/memory-light.mdc", installed: false },
    ],
  },
  {
    id: "verify-before-done",
    name: "verify-before-done",
    description: "Verify a change actually works before claiming it is done, so a hallucinated or careless edit from ANY model doesn't ship a new bug: re-read every changed file and its callers, confirm referenced APIs/symbols actually exist, run the build/tests/linter, confirm the goal is met, and have an independent skeptic adversarially re-check the diff.",
    tags: ["verify", "verification", "double-check", "hallucination", "regression", "skeptic", "review", "tests", "build", "done", "symbol exists"],
    produces: ["re-read diff", "symbol-existence check", "build/test/lint run", "independent skeptic re-check"],
    body: VERIFY_BODY,
    source: "bundled",
    references: ["references/verification-checklist.md"],
    installs: [
      { agent: "claude", rel: ".claude/skills/verify-before-done/SKILL.md", installed: false },
      { agent: "cursor", rel: ".cursor/rules/verify-before-done.mdc", installed: false },
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

/* Mirrors SKILL_EXPLAIN in src/skills/catalog.ts — the 3-line human explainer
   each card shows (what / how / win). Kept in sync by hand; the real daemon
   serves these from the catalog. */
const DEMO_EXPLAIN: Record<string, SkillStatus["explain"]> = {
  "bug-fix": {
    what: "A gated pipeline for fixing bugs without creating new ones.",
    how: "Reproduce → audit blast radius → hypothesis-driven root cause → 95% skeptic-checked plan → fix → re-verify.",
    win: "No duplicate fixes, no symptom patches, no regressions shipped.",
  },
  "token-efficient-coding": {
    what: "Work habits that cut a session's token burn.",
    how: "Read the map (CODEBASE.md / graph), not the repo; minimal diffs; never re-read what you know.",
    win: "Sessions cost a fraction and stay sharp deeper into the context window.",
  },
  "traceable-changes": {
    what: "Git discipline for repos where several agents commit.",
    how: "One atomic commit per change, conventional messages, isolated worktrees.",
    win: "Blame, bisect, and revert always work — any change traces to one commit.",
  },
  "memory-light": {
    what: "Long-horizon work without dragging the whole history in context.",
    how: "Recall memory before exploring; externalize state to disk, not the chat.",
    win: "Sessions resume cheaply and nothing gets re-learned twice.",
  },
  "verify-before-done": {
    what: "A \"done means verified\" gate before any completion claim.",
    how: "Re-read the diff, confirm symbols exist, run build/tests, independent skeptic re-check.",
    win: "Hallucinated \"done\" claims die before they ship.",
  },
  "map-codebase": {
    what: "Builds the repo map every other skill navigates by.",
    how: "`baton kb rebuild` → knowledge graph + CODEBASE.md, served to agents over MCP.",
    win: "Orienting costs hundreds of tokens instead of hundreds of thousands.",
  },
  "safe-refactor": {
    what: "Restructure code without changing behavior.",
    how: "Green test baseline → isolated worktree → small steps → graph-checked callers.",
    win: "Refactors land without breaking the caller you forgot existed.",
  },
};
for (const s of DEMO_SKILLS) s.explain = DEMO_EXPLAIN[s.id];
// Keep demo installs in sync with SKILL_AGENTS (antigravity landed in W4).
for (const s of DEMO_SKILLS) {
  if (!s.installs.some((i) => i.agent === "antigravity")) {
    s.installs.push({ agent: "antigravity", rel: `.agents/skills/${s.id}/SKILL.md`, installed: false });
  }
}
