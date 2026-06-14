/* ============================================================
   BATON — domain types
   Mirrors the CLI's HTTP contract (src/board.ts, src/history.ts,
   src/git.ts, src/server.ts). Kept in sync with a shape-guard test.
   ============================================================ */

/** Agents Baton detects (src/agents.ts). `null` = no agent attached. */
export type AgentId = "claude" | "cursor" | "codex" | "gemini" | "aider" | "opencode";

/** Worktree state (src/git.ts). */
export type Status = "clean" | "dirty" | "conflict";

/** In-progress git operation marker (src/git.ts RepoState). */
export type RepoState = "clean" | "merging" | "rebasing" | "cherry-picking" | "reverting";

/** Derived board column (lib/derive.ts). */
export type ColumnId = "idle" | "active" | "dirty" | "conflict" | "ready";

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
  branch: string;
  writeEnabled: boolean;
  version: string;
  /** Interactive-terminal capability (tmux on the daemon's PATH). */
  terminals?: { available: boolean; hint?: string };
  /** Which agents each launch mode supports — single source of truth is the
   *  daemon (src/spawn.ts LAUNCHERS / src/terminals.ts INTERACTIVE_LAUNCHERS). */
  agents?: { headless: string[]; interactive: string[] };
}

/** One live interactive terminal — GET /api/terminals (src/terminals.ts). */
export interface TerminalInfo {
  slug: string;
  agent: string;
  sessionName: string;
  startedAt: string;
}

/** One project-memory fact with evidence-checked freshness — GET /api/memory (src/memory.ts). */
export interface MemoryFactStatus {
  id: string;
  type: "decision" | "gotcha" | "convention" | "reference" | "preference";
  fact: string;
  agent: string | null;
  task: string | null;
  createdAt: string;
  anchors: { commit: string | null; files: { path: string; hash: string }[] };
  supersedes: string | null;
  freshness: "fresh" | "aging" | "stale";
  staleReason: string | null;
  commitsBehind: number | null;
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
export type FileStatus = "added" | "modified" | "deleted";
export interface DiffFile { path: string; status: FileStatus; hunks: DiffHunk[]; add: number; del: number; lang: string }
