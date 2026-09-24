// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — domain types
   Mirrors the CLI's HTTP contract (src/board.ts, src/history.ts,
   src/git.ts, src/server.ts). Kept in sync with a shape-guard test.
   ============================================================ */

/** Agents Baton detects (src/agents.ts). `null` = no agent attached.
 *  The union is OPEN (`string & {}` keeps literal autocomplete): the daemon
 *  can report ids beyond the built-ins — `.baton/agents.json` custom agents —
 *  and a closed union would make every screen silently drop their sessions. */
export type AgentId =
  | "claude" | "cursor" | "codex" | "gemini" | "antigravity" | "aider" | "opencode" | "openclaw"
  | (string & {});

/** Worktree state (src/git.ts). */
/** `missing` = the task records a worktree that is not on disk. Deliberately not
 *  folded into `clean`: git failing to answer is the opposite of git saying
 *  nothing changed, and the pill has to show which one it is. */
export type Status = "clean" | "dirty" | "conflict" | "missing";

/** In-progress git operation marker (src/git.ts RepoState). */
export type RepoState = "clean" | "merging" | "rebasing" | "cherry-picking" | "reverting";

/** Derived board column (lib/derive.ts). */
export type ColumnId = "idle" | "active" | "dirty" | "conflict" | "ready" | "stopped";

/** A commit on a task branch (src/git.ts CommitInfo — `files` omitted on /status & /history). */
export interface CommitInfo {
  sha: string;
  message: string;
  at: string; // ISO timestamp
  files?: string[];
}

/** A live board row — GET /api/status (src/board.ts StatusRow). */
export interface StatusRow {
  slug: string;
  task: string;
  agent: AgentId | null;
  status: Status;
  repoState?: RepoState;
  ahead: number;
  behind: number;
  conflictFiles: string[];
  filesChanged: number;
  insertions?: number;
  deletions?: number;
  createdAt: string;
}

/** A single task detail — GET /api/tasks/:slug (StatusRow + worktree + commits). */
export interface TaskDetail extends StatusRow {
  worktreePath: string;
  branch: string;
  commits: CommitInfo[];
}

/** A merged/indexed task — GET /api/history (src/history.ts TaskHistory). */
export interface TaskHistory {
  slug: string;
  task: string;
  agent: AgentId | null;
  mergedAt: string | null;
  commits: { sha: string; message: string; at: string }[];
}

/** A created task — POST /api/tasks (src/store.ts Task). */
export interface Task {
  slug: string;
  task: string;
  branch: string;
  worktreePath: string;
  baseBranch: string;
  baseCommit: string | null;
  createdAt: string;
}

/** Conflict label for a merge attempt (src/conflicts.ts). */
export interface ConflictEntry {
  path: string;
  label: string;
}

/** UI project identity — shown in the switcher/sidebar. Real mode derives it
 *  from a connection's /api/meta; demo mode uses lib/preview WORKSPACE. */
export interface Project {
  id: string;
  name: string;
  path: string;
  branch: string;
  framework: string;
  color: string;
  primary?: boolean;
}

/** Daemon metadata — GET /api/meta (repo root + current branch + capabilities). */
export interface Meta {
  repo: string;
  branch: string | null;
  writeEnabled: boolean;
  version: string;
  /** SPDX id and a source URL for THIS build — AGPL-3.0 §13 owes both to
   *  anyone the dashboard is served to. Optional: an older daemon predates it. */
  license?: string;
  source?: string;
  /** True when the root is a multi-repo hub (not a git repo) — new tasks must
   *  target one of `projects`. False/undefined for a plain single repo. */
  hub?: boolean;
  /** The hub's sub-projects a task can target (empty for a single repo). */
  projects?: { id: string; name: string }[];
  /** Interactive-terminal capability, answered for THIS viewer: `tmux` means
   *  the host lacks tmux (hint is a command to run), `remote` means terminals
   *  are loopback-only and no credential changes that. */
  terminals?: { available: boolean; reason?: "tmux" | "remote"; hint?: string };
  /** Which agents each launch mode supports — single source of truth is the
   *  daemon (src/spawn.ts LAUNCHERS / src/terminals.ts INTERACTIVE_LAUNCHERS).
   *  `known` is every agent the daemon's root knows INCLUDING detection-only
   *  ones, which can be handed off to but not launched. Absent on daemons
   *  older than this — fall back to the union of the two launcher lists.
   *  `fromProject` names the ids the REPO defined (its `.baton/agents.json`)
   *  rather than the machine's owner, so any surface that offers to launch one
   *  can say where it came from. */
  agents?: { headless: string[]; interactive: string[]; known?: string[]; fromProject?: string[] };
  /** Who the daemon thinks this browser is. `local` means a loopback
   *  connection, which needs no credential at all; a remote viewer is whichever
   *  member the bearer token names. Absent on daemons older than this. */
  viewer?: {
    local: boolean;
    memberId: string | null;
    name: string | null;
    role: MemberRole | null;
  };
}

/** One Baton daemon on this machine — GET /api/daemons (src/daemons.ts).
 *  Loopback-only: a remote viewer never sees the fleet at all. `stale` means
 *  the record failed verification (crash leftover, or a reused pid/port) and
 *  may only be cleaned up, never stopped. */
export interface FleetDaemon {
  pid: number;
  port: number;
  root: string;
  startedAt: string;
  version: string;
  writeEnabled: boolean;
  host: boolean;
  status: "live" | "stale";
  /** True on the row describing the daemon that answered this request. */
  self: boolean;
}

/** One live interactive terminal — GET /api/terminals (src/terminals.ts). */
export interface TerminalInfo {
  slug: string;
  agent: string;
  sessionName: string;
  startedAt: string;
}

/** One headless run this daemon is driving — GET /api/agents/running (src/spawn.ts). */
export interface RunningAgentInfo {
  slug: string;
  agent: string;
  model?: string;
  startedAt: string;
  /** Tail of the run's output, already redacted server-side. */
  recentLines: string[];
}

/** One project-memory fact with evidence-checked freshness — GET /api/memory (src/memory.ts). */
export interface MemoryFactStatus {
  id: string;
  type: "decision" | "gotcha" | "convention" | "reference" | "preference";
  fact: string;
  agent: string | null;
  /** WHO claimed it, vs `agent` = WHAT wrote it down. Pre-author facts read as
   *  "unknown" — the backend never sends undefined. */
  author: string;
  task: string | null;
  createdAt: string;
  anchors: { commit: string | null; files: { path: string; hash: string }[] };
  supersedes: string | null;
  freshness: "fresh" | "aging" | "stale";
  staleReason: string | null;
  commitsBehind: number | null;
  /** Which kb sub-project this fact's files belong to (hub scoping); null = shared. */
  project: string | null;
}

/** A kb sub-project for per-server memory scoping (GET /api/memory.projects). */
export interface MemoryProject { id: string; rel: string }

/* ---- code review (three axes, src/reviews.ts) ----
   The axes are deliberately NEVER merged and never cross-ranked: a Standards
   nit and a Security hole are not comparable, so there is no combined total
   anywhere in the API and there must not be one in the UI either. */
export type ReviewAxis = "standards" | "spec" | "security";
export type FindingStatus = "open" | "fixed" | "dismissed";
export type FindingRoute = "fix-directly" | "systematic-debugging" | "bug-fix" | "implement";

export interface ReviewFinding {
  /** Stable identity (axis + file + title) — survives a re-review that reorders
   *  or rewords findings. Always resolve by this, never by array position. */
  id: string;
  axis: ReviewAxis;
  title: string;
  file?: string;
  line?: number;
  /** Mandatory citation — an uncited finding is an opinion and is never stored. */
  source: string;
  detail?: string;
  /** Only a documented-standard breach can be hard, and only on the Standards axis. */
  hard: boolean;
  status: FindingStatus;
  route?: FindingRoute;
}

/** An axis that did not run, and why — an unreported skip reads as a clean pass. */
export interface AxisSkip { axis: ReviewAxis; why: string }

/** A review as GET /api/reviews serves it: the record plus derived per-axis
 *  open counts and a staleness flag against the repo's current HEAD. */
export interface ReviewRecord {
  slug: string;
  fixedPoint: string;
  head: string;
  axes: ReviewAxis[];
  skipped: AxisSkip[];
  findings: ReviewFinding[];
  /** Set when the diff was too large to review whole — a silent partial review
   *  reads as a clean one. */
  partial?: string;
  agent?: string;
  /** WHO ran the review, vs `agent` = WHAT ran it. Tracks the LATEST review
   *  (a re-review replaces the record), so it pairs with `updatedAt`. */
  author: string;
  createdAt: string;
  updatedAt: string;
  open: Record<ReviewAxis, number>;
  stale: boolean;
}

/** Auto-retention policy — GET/POST /api/memory/retention. */
export interface RetentionPolicy {
  maxAgeDays?: number;
  dropStale?: boolean;
  dropAging?: boolean;
}

/* ---- memory consolidation (src/memory/consolidate.ts + src/memory/delegate.ts) ----
   Two passes over the fact store, with very different prices.

   The MECHANICAL one is zero-LLM, free, and always on — the daemon runs it when
   the machine is idle (`startIdleConsolidation`) and `baton memory consolidate`
   runs it on demand. Nothing a user can switch off here stops it.

   The AGENT-ASSISTED one launches the user's OWN coding agent under their OWN
   credentials and spends their tokens, which is why `DELEGATE_DEFAULTS.enabled`
   is `false` and why the UI states the cost at the switch rather than in docs.

   These mirror the daemon exactly: `ConsolidationPassResult` (src/daemons.ts),
   `DelegateConfig`, `DelegateSpend` and `ProducedFact` (src/memory/delegate.ts).
   Nothing here is widened — if the daemon does not send a field, it is null. */

/** Mirrors `ConsolidationStatus`. `busy`/`cancelled` are not recorded as passes. */
export type MemoryConsolidationStatus = "ran" | "unchanged" | "busy" | "cancelled" | "failed";

/** Two facts that disagree. Reported for a person, never resolved by the pass. */
export interface MemoryContradiction { ids: string[]; reason: string }

/** The last mechanical pass, plus when it ran. */
export interface MemoryMechanicalPass {
  status: MemoryConsolidationStatus;
  /** Epoch ms; null when the daemon has not recorded a pass yet. */
  at: number | null;
  /** Ids retired — superseded, never deleted. */
  superseded: string[];
  contradictions: MemoryContradiction[];
  error?: string;
}

/** Mirrors `DelegateConfig`. `enabled` is the only field the dashboard sets.
 *
 *  The caps are read-only here, and they are NOT user configuration: they come
 *  from `DELEGATE_DEFAULTS` in src/memory/delegate.ts, clamped to their legal
 *  range by `resolveDelegateConfig`. The only file involved is
 *  `.baton/memory/delegate.json`, and `saveDelegateSetting` rewrites that whole
 *  file as `{ enabled }` — so caps hand-edited into it survive only until the
 *  next time someone flips this switch, which silently discards them. Do not
 *  render them as something the reader can change. */
export interface MemoryDelegateConfig {
  enabled: boolean;
  maxRunsPerDay: number;
  minIntervalMs: number;
  maxFactsPerJob: number;
  maxUsdPerDay: number;
  windowMs: number;
}

/** One line of `.baton/memory-delegate.jsonl` — mirrors `DelegateSpend`. A run
 *  is recorded whether or not the agent succeeded, so a crashing agent cannot
 *  spend money forever without showing up here. */
export interface MemoryDelegateSpend {
  at: number;
  ok: boolean;
  agent: string;
  model: string | null;
  inputFacts: number;
  promptChars: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Cost as REPORTED, so `null` means the agent priced nothing and `0` means
   *  it reported a free run. Same rule as the token counts either side of it:
   *  never render a missing measurement as 0. A ledger line written by an older
   *  build (or hand-edited) can simply omit the field, and `lastDelegateRun`
   *  hands that line straight through — so this arrives absent in practice. */
  costUsd: number | null;
  durationMs: number;
  produced: number;
  rejected: number;
  error?: string;
}

/**
 * A fact the agent pass produced — mirrors `ProducedFact`.
 *
 * `fact` is MACHINE-GENERATED text derived from facts other agents wrote, which
 * makes it the least trustworthy string this dashboard displays. It is rendered
 * as React text children only: no `dangerouslySetInnerHTML`, no markdown
 * renderer, no `innerHTML`, not here and not in whatever screen shows it next.
 */
export interface MemoryProducedFact {
  id: string;
  fact: string;
  /**
   * Input fact ids this text derives from. The VALIDATOR rejects an empty one,
   * but this route can still serve one: a fact FILE records no `cites`, so a
   * fact that reached disk arrives here with the provenance already dropped.
   * Empty means "not recorded", never "derived from nothing".
   */
  cites: string[];
  /**
   * Which agent/model wrote it, for the person deciding whether to keep it —
   * and `null` when that was never recorded, which is every fact today. A fact
   * file carries no generator, and the `baton-machine` author constant that
   * used to be reported here named no agent and no model while looking like
   * attribution. Render the absence; do not fill it in.
   */
  generator: string | null;
}

/** GET/POST /api/memory/consolidation. */
export interface MemoryConsolidation {
  /** null when no pass has run yet on this machine. */
  mechanical: MemoryMechanicalPass | null;
  delegate: {
    config: MemoryDelegateConfig;
    /** Runs and dollars already spent inside `config.windowMs`. */
    runsInWindow: number;
    usdInWindow: number;
    /** The ledger outlives the switch, so this survives being turned off. */
    lastRun: MemoryDelegateSpend | null;
    produced: MemoryProducedFact[];
    /**
     * Why `produced` cannot have come from an agent pass. Non-null today on
     * every reply: no launcher is wired, so turning the switch on records
     * consent and starts nothing. Without this, an empty `produced` reads as
     * "a pass ran and merged nothing", which is a different fact.
     */
    noPassReason: string | null;
  };
}

/** Disk footprint — GET /api/storage (src/storage.ts). */
export interface StorageBucket { id: string; label: string; bytes: number; count?: number }
export interface StorageBreakdown {
  root: string;
  memory: { bytes: number; facts: number };
  history: { bytes: number };
  reports: { bytes: number; count: number };
  graphs: StorageBucket[];
  graphsTotal: number;
  total: number;
}

/** Permanent purge — GET/POST /api/storage/purge (src/purge.ts). */
export type PurgeCategory = "archives" | "history" | "reports" | "graphs" | "tmp" | "memory";
export interface PurgeItem {
  category: PurgeCategory;
  label: string;
  bytes: number;
  count: number;
  destructive: boolean;
  detail: string;
  warning?: string;
}
export interface PurgePreview {
  root: string;
  repo: string;
  confirmPhrase: string;
  gitObjectBytes: number;
  items: PurgeItem[];
}
export interface PurgeResult {
  deleted: { category: PurgeCategory; count: number }[];
  freedBytes: number;
  gcRan: boolean;
}

/** One knowledge-base project — GET /api/kb (src/kb/state.ts via src/server.ts). */
export interface KbProjectStat {
  id: string;
  name: string;
  path: string;
  nodes: number;
  edges: number;
  communities: number;
  lastBuiltAt: string | null;
  building: boolean;
  /** ≈ tokens to read CODEBASE.md vs reading the whole project (savings metric). */
  mapTokens?: number | null;
  repoTokens?: number | null;
}

/** Real per-session token usage — GET /api/usage (src/usage.ts). */
export interface SessionUsage {
  sessionId: string;
  slug: string | null;
  agent: "claude";
  model: string | null;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estCostUsd: number;
  firstAt: string | null;
  lastAt: string | null;
}

export interface UsageTotals {
  sessions: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estCostUsd: number;
}

export interface RepoUsage {
  sessions: SessionUsage[];
  totals: UsageTotals;
  byModel: Record<string, UsageTotals>;
}

/** Knowledge-base status — GET /api/kb. */
export interface KbStatus {
  initialized: boolean;
  graphifyInstalled: boolean;
  projects: KbProjectStat[];
  merged: KbProjectStat | null;
}

/** A graph.json node (graphify networkx node-link export). */
export interface GraphNode {
  id: string;
  label: string;
  file_type?: string;
  source_file?: string;
  source_location?: string;
  community?: number;
  norm_label?: string;
}

/** A graph.json edge. `source`/`target` are node ids (force-graph mutates them to objects). */
export interface GraphLink {
  source: string | GraphNode;
  target: string | GraphNode;
  relation?: string;
  confidence?: string;
  confidence_score?: number;
}

/** GET /api/kb/graph?project=… — graphify's graph.json. */
export interface GraphData {
  directed?: boolean;
  nodes: GraphNode[];
  links: GraphLink[];
}

/** Who is editing a path right now (src/signals.ts). */
export interface SignalHolder {
  slug: string;
  agent: AgentId | string | null;
  lastEditAt: string;
  /**
   * `active` = holding the path now. `settled` = just finished (committed or
   * reverted) — shown dimmed for a few minutes, never a reason to wait (ISS-15).
   * Optional: an older daemon omits it, and those signals are all active.
   */
  state?: "active" | "settled";
  /** When the path went clean. Settled holders only. */
  settledAt?: string;
  /** The holder's live intent (report_progress / P5), if fresh. */
  note?: string;
  noteAt?: string;
}

/** Load-aware handoff recommendation — GET /api/tasks/:slug/suggest-handoff. */
export interface HandoffLoadSuggestion {
  /** Least-loaded available agent to hand this task to (null = none). */
  recommended: AgentId | string | null;
  reason: string;
  /** Active-task count per agent (dirty/conflict tasks). */
  loads: Record<string, number>;
}

/** An open handoff brief — GET /api/handoffs. Task briefs live in worktree
 *  HANDOFF.md files; session briefs (any agent, incl. repo root) under
 *  .baton/handoffs/. The dashboard's copy buttons serve these. */
export interface HandoffBriefEntry {
  slug: string;
  kind: "task" | "session";
  title: string;
  status: string;
  from: string;
  to: string;
  created: string;
  path: string;
  /** Where the resuming agent should work. */
  cwd: string;
  /** Full HANDOFF.md (frontmatter + body). */
  markdown: string;
  /** Body only. */
  body: string;
  /**
   * The prompt to paste into the next agent, with the body already quoted.
   *
   * Built by the daemon (`resumePromptFor` in `src/handoff/resume.ts`) and
   * copied verbatim. Do NOT assemble one here: a brief arrives by `git pull`
   * from a branch nobody reviewed, and `web/` cannot import `src/`, so a fence
   * written in the browser would be a second implementation of a security
   * primitive that could drift from the real one.
   */
  resumePrompt: string;
  /** Slugs this brief waits on that are still open. */
  dependsOn: string[];
  /** The plan phase this brief came from, when it came from a plan. */
  phase: string | null;
  /** 1-based pipeline position. Briefs sharing a step can run at the same time. */
  step: number;
  /** Another open brief shares this step. */
  parallel: boolean;
  /** Nothing open is holding this up — safe to paste now. */
  ready: boolean;
  /** Open briefs this one waits on. */
  blockedBy: string[];
  /** Sits in a dependency cycle; can never become ready on its own. */
  cyclic: boolean;
}

/** A connected agent with no task worktree — GET /api/sessions (presence layer).
 *  Surfaces plain-terminal / MCP-connected sessions the worktree-only board
 *  cannot show (src/board.ts collectPresence). */
export interface PresenceSession {
  slug: string;
  agent: AgentId | string | null;
  /** The checkout the session registered from. */
  root: string | null;
  /** Last connect/edit time (ISO). */
  lastSeen: string;
  /** Actively working (seen very recently), vs idle-but-connected. */
  live: boolean;
}

/** A live edit signal — GET /api/signals. warning = 2+ sessions on one path. */
export interface EditSignal {
  path: string;
  level: "info" | "warning";
  holders: SignalHolder[];
}

/** What a merged task shipped — GET /api/reports[/:slug] (src/reports.ts). */
export interface CompletionReport {
  slug: string;
  task: string;
  agent: AgentId | string | null;
  mergedAt: string;
  summary: string;
  files: string[];
  commits: { sha: string; message: string; at: string }[];
  overlappedWith: string[];
}

/** POST /api/kb/import result (src/kb/transfer.ts). */
export interface ImportResult {
  projects: Array<{ id: string; status: "ok" | "path-missing" | "invalid-graph" }>;
  gitHead: string | null;
  commitsBehind: number | null;
  warnings: string[];
}

/** Routing types — mirror src/routing.ts (routing-parity.test.ts enforces lockstep). */
export type RoutingMode = "auto" | "manual" | "single";

export interface TierEntry {
  agent: string;
  model?: string;
}

/** Routing rule from baton.config.json (src/routing.ts). */
export interface RoutingRule {
  match: string[];
  agent?: string;
  tier?: string;
  model?: string;
}

export interface RoutingConfig {
  rules: RoutingRule[];
  default: string;
  mode?: RoutingMode;
  tiers?: Record<string, TierEntry[]>;
  single?: TierEntry;
}

/** Legacy suggestion shape (suggestAgent). */
export interface RoutingSuggestion {
  agent: string;
  model?: string;
  rule: RoutingRule | null;
  matched: string[];
  source: "rule" | "default";
}

/** Rich suggestion (suggestRoute): severity-ranked, tier-aware, explainable. */
/** W5 — advisory cheaper-tier alternative for a trivial task caught by a rule. */
export interface Downshift {
  tier: string;
  chain: TierEntry[];
  reason: string;
}

export interface RouteSuggestion {
  mode: RoutingMode;
  agent: string;
  model?: string;
  tier: string | null;
  chain: TierEntry[];
  severity: number;
  signals: string[];
  matched: string[];
  rule: RoutingRule | null;
  source: "single" | "rule" | "severity" | "default";
  confidence: "high" | "low";
  /** Advisory: a cheaper tier that could handle this (rule pick stays the answer). */
  downshift?: Downshift | null;
}

/** GET /api/routing[?task=…] */
export interface RoutingInfo {
  config: RoutingConfig;
  path: string | null;
  errors: string[];
  suggestion: RouteSuggestion | null;
}

/** Per-agent MCP wiring status (src/agents/connect.ts). */
export interface McpStatus {
  agent: string;
  supported: boolean;
  scope: "project" | "global" | null;
  path: string | null;
  exists: boolean;
  connected: boolean;
}

/** One live session attributed to an agent (process scan / headless / terminal). */
export interface LiveSession {
  slug: string;
  kind: "process" | "headless" | "terminal";
}

/** One row of the agent roster — GET /api/agents (src/agents/roster.ts). */
export interface AgentRosterEntry {
  id: AgentId;
  label: string;
  binary: string;
  installed: boolean;
  headless: boolean;
  interactive: boolean;
  mcp: McpStatus;
  live: LiveSession[];
  idle: boolean;
  /** Defined by this repo's `.baton/agents.json`, not by you — the Agents
   *  screen labels it, because config that arrives with a `git pull` should
   *  never look like a built-in. */
  fromProject?: true;
}

/** POST /api/agents/:id/connect result. */
export interface ConnectResult {
  agent: string;
  scope: "project" | "global";
  path: string;
  wrote: boolean;
  needsConfirm: boolean;
  servers: string[];
  preview?: string;
}

/** Agent-blame for one file — GET /api/blame?file=… */
export interface BlameResult {
  file: string;
  merged: { path: string; slug: string; task: string; agent: string | null; sha: string; message: string; at: string }[];
  live: SignalHolder[];
}

/** One side-by-side diff line — GET /api/tasks/:slug/diff. */
export type DiffLineType = "add" | "del" | "ctx";
export interface DiffLine { t: DiffLineType; o: number | null; n: number | null; s: string }
export interface DiffHunk { header: string; lines: DiffLine[] }
export type FileStatus = "added" | "modified" | "deleted" | "renamed";
/** `oldPath` is set only when `status` is "renamed". `tooLarge`: listed without
 *  its content because this one file was too big to show (not the whole diff). */
export interface DiffFile { path: string; status: FileStatus; oldPath?: string; tooLarge?: true; hunks: DiffHunk[]; add: number; del: number; lang: string }
/** `truncated`: the daemon's shared size budget or file cap was hit, so files and counts are partial. */
export interface DiffResult { files: DiffFile[]; truncated: boolean }

/** Agent CLIs Baton can install a skill into (have a skill/rule directory). */
export type SkillAgent = "claude" | "cursor" | "antigravity";

/** Per-agent install state for one skill. */
export interface SkillInstallState {
  agent: SkillAgent;
  rel: string;
  installed: boolean;
}

/**
 * Where a skill came from, which decides what may be done to it.
 * `bundled` ships in the package — never exported, never deleted.
 * `global` (~/.baton/skills, every project) and `imported` (legacy, this repo
 * only) are the user's own; the dashboard groups both as "Your skills".
 */
export type SkillSource = "bundled" | "global" | "imported";

/** True for a skill the user owns — exportable and deletable. */
export const isUserSkill = (s: SkillSource): boolean => s === "global" || s === "imported";

/**
 * One catalog entry — GET /api/skills (src/skills).
 *
 * Metadata only: **no body**. The bundled set is ~330 KB, so a listing that
 * carried bodies spent ~58k tokens to render a list of names. Fetch a body from
 * `GET /api/skills/:id/file` when something actually reads it, and use
 * `contentSha256` to skip that fetch when your copy is current.
 */
export interface SkillStatus {
  id: string;
  name: string;
  description: string;
  tags: string[];
  produces: string[];
  source: SkillSource;
  /** Hash of the installed content — changes iff an install would differ. */
  contentSha256: string;
  /** Total UTF-8 bytes of body + reference files. */
  byteSize: number;
  /** 3-line human explainer (what / how / win); absent for imported skills. */
  explain?: { what: string; how: string; win: string };
  /** Relative paths of the skill's reference files (content omitted); [] for single-file skills. */
  references: string[];
  installs: SkillInstallState[];
  /** Pinned by the user — sorts to the top of its band. */
  bookmarked: boolean;
}

/** POST /api/skills/:id/install result. */
export interface SkillInstallResult {
  skill: string;
  agent: SkillAgent;
  rel: string;
  path: string;
  wrote: boolean;
  /** Number of reference files written alongside the skill. */
  references: number;
}

/* ---- Imported-skill review gate (GET /api/skills/quarantine) ----
   A skill IS instructions: installSkill writes it where the agent's harness
   loads it as directive text, so Baton's untrusted-quoting defence cannot
   apply to it. The defence is a human release instead, and these are the
   shapes that review screen reads. The scanner cannot decide intent, so
   nothing here may be presented as a verdict. */

export type FindingCategory =
  | "permission-bypass" | "instruction-override" | "credential-access"
  | "exfiltration" | "hidden-characters";

/** Where the match sits — a skill that DOCUMENTS a pattern is not one that USES it. */
export type FindingContext = "imperative" | "fenced" | "negated";

/** One scanner hit. Evidence for a reader, never a judgement. */
export interface ScanFindingRow {
  category: FindingCategory;
  severity: "high" | "medium";
  /** Path relative to the skill directory. */
  file: string;
  /** 1-based, matching what an editor shows. */
  line: number;
  excerpt: string;
  context: FindingContext;
  /** The normalised text that matched. */
  matched: string;
}

/** One file of a held skill, transported as data and rendered as plain text. */
export interface HeldSkillFile { rel: string; content: string }

/**
 * A skill waiting on a human.
 *
 * Carries the FULL content, because a person cannot approve what they have not
 * been shown, and the `hash` the release call must echo back — approving a name
 * would approve whatever later occupies it.
 */
export interface HeldSkill {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  hash: string;
  files: HeldSkillFile[];
  findings: ScanFindingRow[];
}

/** GET /api/skills/quarantine. `note` is the daemon's own wording; show it. */
export interface QuarantineView { held: HeldSkill[]; note: string }

/** GET /api/kb/context?format=json — the shareable context pack. */
export interface ContextPackResponse {
  markdown: string;
  tokens: number;
  redactions: number;
  omitted: string[];
  fits: { id: string; label: string; limit: number; ok: boolean }[];
}

/* ---- Team: membership + the federated "who is editing what" plane ----
   Cross-machine MEMBERS, not the local agent sessions in PresenceSession.
   Everything here is a live view with a TTL: it is never persisted, so a
   restarted host knows nothing until members report in again. */

export type MemberRole = "owner" | "member";

/** An owner's notice to one member — GET /api/members. */
export interface MemberWarning {
  id: string;
  message: string;
  from: string;
  at: string;
}

/** One roster row: registry record merged with whatever the live plane knows. */
export interface MemberRow {
  id: string;
  name: string;
  role: MemberRole;
  /** False for a live member with no registry record (a loopback heartbeat). */
  registered: boolean;
  createdAt: string;
  revokedAt?: string;
  online: boolean;
  device: string | null;
  sessions: number;
  since: string | null;
  lastSeen: string | null;
  /** How many files they currently hold. */
  claims: number;
  warnings: MemberWarning[];
  /** Deadline for the FIRST use of an invite; absent once redeemed or if none. */
  expiresAt?: string;
  /** When this member's token was first used to authenticate. */
  firstUsedAt?: string;
  /** Team id, or null. Already resolved against the teams that exist, so a
   *  pointer at a deleted team arrives as null rather than as a dangling id. */
  team: string | null;
}

/**
 * A group of members (src/teams.ts).
 *
 * `projects` is a VIEW SCOPE — it decides what this team's rows are filtered to
 * on this screen, and nothing else. It reaches no authorization decision on the
 * server, and it is never applied to conflicts.
 */
export interface Team {
  id: string;
  name: string;
  /** Hub project ids. **Empty = the whole hub**, not "no projects". */
  projects: string[];
  createdAt: string;
}

/** One claimed file. ADVISORY: claiming an already-claimed path succeeds. */
export interface MemberClaim {
  projectId: string | null;
  relPath: string;
  memberId: string;
  memberName: string;
  agent: string | null;
  branch: string | null;
  openedAt: string;
  refreshedAt: string;
}

/** Two or more members on one path. `sameBranch` false = information, not a
 *  warning: divergent branches meet at merge, not in a working tree. */
export interface ClaimOverlap {
  projectId: string | null;
  relPath: string;
  sameBranch: boolean;
  holders: Array<{ memberId: string; memberName: string; agent: string | null; branch: string | null; since: string }>;
}

/** GET /api/members — the whole Team screen in one poll. */
export interface TeamState {
  members: MemberRow[];
  teams: Team[];
  claims: MemberClaim[];
  overlaps: ClaimOverlap[];
  ttlMs: number;
  /** What THIS viewer may do. The server enforces it independently on every
   *  owner endpoint — this only decides what is worth rendering. */
  viewer: { local: boolean; memberId: string | null; isOwner: boolean };
}

/** POST /api/members (or …/rotate) — the token is returned exactly once. */
export interface InviteResult {
  member: { id: string; name: string; role: MemberRole; expiresAt?: string };
  token: string;
  /** Ready to paste: `npx baton join <url> --token …`. */
  command: string;
  expiresAt?: string;
  note: string;
}

/** One way to expose the daemon — GET /api/reachability. Baton detects and
 *  instructs; it never starts a tunnel itself (see src/reachability.ts). */
export interface TunnelTool {
  id: "ssh" | "tailscale" | "cloudflared";
  label: string;
  needsBinary: boolean;
  installed: boolean;
  install?: string;
  why: string;
  /** Commands only — never prose. */
  steps: string[];
  /** Follow-up prose, rendered as text rather than a copyable command. */
  then?: string;
}

/** GET /api/reachability — owner-only: can anyone else actually reach this hub? */
export interface Reachability {
  bind: string;
  loopbackOnly: boolean;
  port: number;
  allowedHosts: string[];
  urls: string[];
  lanAddresses: string[];
  members: { active: number; owners: number };
  tools: TunnelTool[];
  /** Things that would make an invite fail outright. */
  blockers: string[];
  notes: string[];
}

/* ---- pipeline swimlanes — GET /api/pipeline (src/pipeline-view.ts) ---- */

export type TaskState =
  | "queued" | "claimed" | "active" | "paused" | "review" | "blocked" | "done" | "cancelled";

/** What a lane header says about its phase. `holding` means every task in it is
 *  finished but its branches have not landed — which is WHY the next lane is
 *  locked, so it is a distinct state rather than a flavour of `complete`. */
export type LaneStatus = "ungated" | "complete" | "holding" | "open" | "locked";

export interface LaneTask {
  slug: string;
  title: string;
  phase: number;
  state: TaskState;
  assignee: string | null;
  holder: { agent: string; sessionSlug: string; at: string } | null;
  dependsOn: string[];
  planId: string | null;
  /** The pipeline's own wording for why this cannot start, or null.
   *  Rendered verbatim — the dashboard must not invent a second vocabulary for
   *  a refusal the CLI answers to. */
  blocker: string | null;
  branch: string;
  cancelledBy?: { actor: string; at: string; reason?: string };
  stoppedReason?: string;
}

export interface Lane {
  phase: number;
  status: LaneStatus;
  tasks: LaneTask[];
  done: number;
  total: number;
}

export interface PipelineView {
  /** null means nothing is open — a finished plan, not a missing number. */
  openPhase: number | null;
  integrationHold: number | null;
  deadlocked: boolean;
  lanes: Lane[];
  plans: Array<{ id: string; total: number; done: number; cancelled: number }>;
  totals: { total: number; done: number; active: number; blocked: number; cancelled: number };
}

/** What a cancellation would touch — computed by the daemon, never by the UI. */
export interface BlastRadius {
  stopping: Array<{ slug: string; state: TaskState; holder: string | null }>;
  alreadyFinished: string[];
  /** Tasks that depend on something being cancelled and can then NEVER start. */
  stranding: Array<{ slug: string; dependsOn: string[] }>;
}

export interface CancelResult {
  ok: boolean;
  dryRun: boolean;
  scope: string;
  radius: BlastRadius;
  agentsStopped: number;
  cancelled: string[];
}

export type CancelScopeInput =
  | { slug: string } | { phase: number } | { plan: string };

/* ---- plan inventory — GET /api/plans (src/plans/inventory.ts) ----

   The counterpart to PipelineView.plans, which is derived from the TASKS: a
   plan file nobody has applied has no tasks and so appears nowhere in it. That
   hid the one checkpoint the safety model rests on — a human running
   `baton plan approve`, recorded against the plan's exact bytes.

   Every field here is data the daemon judged. The browser re-judges none of
   it: a second opinion about "approved" would eventually disagree with the CLI
   that actually refuses to dispatch. */

/** One problem with a plan file, in the parser's own words. */
export interface PlanIssue {
  /** Where it is, as a human reads the file: a task slug, a phase, or 'plan'. */
  where: string;
  message: string;
}

/**
 * `void` is the case the byte-exact gate exists to catch: somebody approved
 * this plan and then the file moved underneath the approval. It is not a
 * weaker "approved".
 *
 * `unknown` is a file that could not be read — no bytes, so nothing to vouch
 * for, and "unapproved" would imply we had looked.
 */
export interface PlanApproval {
  state: "approved" | "unapproved" | "void" | "unknown";
  /** The daemon's own wording, including how to fix it. Rendered as text. */
  reason: string | null;
  approvedBy: string | null;
  at: string | null;
  /** The digest that was APPROVED — for `void`, not the one on disk. */
  sha256: string | null;
}

export interface PlanInventoryEntry {
  /** The filename stem, and what a URL names. */
  id: string;
  /** The id the frontmatter declares — the key `baton plan approve` uses. */
  planId: string;
  /** Repo-relative, for display. */
  path: string;
  goal: string;
  /** Tasks the FILE declares — not rows on the board. */
  tasks: number;
  phases: number;
  parses: boolean;
  issues: PlanIssue[];
  /** False when the file could not be read at all. */
  readable: boolean;
  /** Has this plan created tasks? "On disk" and "running" are different states. */
  applied: boolean;
  appliedTasks: number;
  /** The digest of the bytes on disk right now. */
  sha256: string | null;
  approval: PlanApproval;
}

export interface PlanInventory {
  /** Where the plans live, repo-relative — part of the answer to "why is mine
   *  not listed?". */
  dir: string;
  plans: PlanInventoryEntry[];
}

/* ---- worktree read-model — GET /api/worktrees (src/worktrees.ts) ---- */

/**
 * `health` is the evidence layer under `state`, never a peer of it
 * (src/worktrees.ts:48-58). `state` is the lifecycle value the daemon was told;
 * `health` is what the disk says. A task can be `active` and `abandoned` at the
 * same time — that pair is the entire point of the feature.
 *
 * `unknown` is the fail-closed answer: a row whose git calls did not answer
 * reports it and never `working`.
 */
export type WorktreeHealth =
  | "working" | "quiet" | "stalled" | "abandoned"
  | "ok" | "dirty" | "conflict" | "rebasing" | "missing" | "orphan-disk"
  | "unknown" | "unmanaged";

/** Who made the worktree (src/worktrees.ts:WorktreeKind). `task` and `orphan`
 *  are Baton's; `main` and `external` are shown, and Baton acts on neither. */
export type WorktreeKind = "task" | "orphan" | "main" | "external";

/** What you lose if this disk dies (src/worktrees.ts:66-71). `commits: null`
 *  means the refs read failed, and `atRisk` then stays true — not knowing is
 *  not the same as being safe. */
export interface Unprotected {
  lines: number;
  commits: number | null;
  atRisk: boolean;
}

/** One row of `GET /api/worktrees`. Mirrors `WorktreeRow` in src/worktrees.ts. */
export interface WorktreeRow {
  /** The task slug for a task row; `<name>~<hash>` for every other kind. */
  slug: string;
  kind: WorktreeKind;
  branch: string | null;
  worktreePath: string;
  /** null for an orphan worktree on disk: no task owns it, so it has no lifecycle. */
  state: TaskState | null;
  health: WorktreeHealth;
  /** ms since the progress token last advanced; null when there is no evidence. */
  quietForMs: number | null;
  lastActivityAt: string | null;
  unprotected: Unprotected;
  filesChanged: number | null;
  ahead: number | null;
  behind: number | null;
  repoState: RepoState | null;
  /** The process actually detected in the worktree. */
  agent: string | null;
  /** The agent the task RECORD says holds it. Differs from `agent` exactly when
   *  the holder died. */
  claimedBy: string | null;
  holderRunning: boolean;
  planId: string | null;
  phase: number | null;
  dependsOn: string[];
  orphan: boolean;
  wipRef: string | null;
}
