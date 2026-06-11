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

/** Routing rule from baton.config.json (src/routing.ts). */
export interface RoutingRule {
  match: string[];
  agent: string;
  model?: string;
}

export interface RoutingConfig {
  rules: RoutingRule[];
  default: string;
}

export interface RoutingSuggestion {
  agent: string;
  model?: string;
  rule: RoutingRule | null;
  matched: string[];
  source: "rule" | "default";
}

/** GET /api/routing[?task=…] */
export interface RoutingInfo {
  config: RoutingConfig;
  path: string | null;
  errors: string[];
  suggestion: RoutingSuggestion | null;
}

/** Agent-blame for one file — GET /api/blame?file=… */
export interface BlameResult {
  file: string;
  merged: { path: string; slug: string; task: string; agent: string | null; sha: string; message: string; at: string }[];
  live: SignalHolder[];
}
