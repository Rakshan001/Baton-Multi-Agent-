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

/** Daemon metadata — GET /api/meta (repo root + current branch + capabilities). */
export interface Meta {
  repo: string;
  branch: string;
  writeEnabled: boolean;
  version: string;
}
