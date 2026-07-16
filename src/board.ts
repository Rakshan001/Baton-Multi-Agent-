/**
 * Shared status collection — the structured data behind `baton status` and the
 * `baton serve` /api/status endpoint. One source of truth for both.
 */
import { detectAgents, detectRootAgents, type RootAgentSession } from './agents.js';
import { computeConflicts } from './conflicts.js';
import { aheadBehind, worktreeStatus, type RepoState } from './git.js';
import { loadTasks } from './store.js';
import { liveSessions, WATCHER_HEARTBEAT_STALE_MS } from './signals.js';

export interface StatusRow {
  slug: string;
  task: string;
  agent: string | null;
  status: 'clean' | 'dirty' | 'conflict';
  repoState: RepoState;
  ahead: number;
  behind: number;
  conflictFiles: string[];
  filesChanged: number;
  insertions: number;
  deletions: number;
  createdAt: string;
}

export async function collectStatus(root: string): Promise<StatusRow[]> {
  const tasks = await loadTasks(root);
  const [agents, conflicts] = await Promise.all([
    detectAgents(tasks.map((t) => t.worktreePath)),
    computeConflicts(tasks, root),
  ]);

  return Promise.all(
    tasks.map(async (t) => {
      const st = await worktreeStatus(t.worktreePath);
      const { ahead, behind } = await aheadBehind(t.branch, t.baseBranch, root);
      return {
        slug: t.slug,
        task: t.task,
        agent: agents.get(t.worktreePath) ?? null,
        status: st.state,
        repoState: st.repoState,
        ahead,
        behind,
        conflictFiles: conflicts.get(t.slug) ?? [],
        filesChanged: st.changedFiles.length,
        insertions: st.insertions,
        deletions: st.deletions,
        createdAt: t.createdAt,
      };
    }),
  );
}

export interface RootAgentCount {
  agent: string;
  count: number;
}

/**
 * Agents running at a hub/repo root or a kb sub-project — visible to no
 * StatusRow because they attach to no task worktree (a real production hub
 * had 6 live Claude sessions running in plain terminals; the dashboard
 * showed "No agents attached right now"). Excludes anything already counted
 * via a task's worktree so a session doesn't show up twice.
 */
export async function rootAgentSummary(
  hubRoot: string,
  kbProjectPaths: string[],
  taskWorktreePaths: string[],
  opts: { detect?: (include: string[], exclude: string[]) => Promise<RootAgentSession[]> } = {},
): Promise<RootAgentCount[]> {
  const detect = opts.detect ?? detectRootAgents;
  const sessions = await detect([hubRoot, ...kbProjectPaths], taskWorktreePaths);
  const counts = new Map<string, number>();
  for (const s of sessions) counts.set(s.agent, (counts.get(s.agent) ?? 0) + 1);
  return [...counts.entries()].map(([agent, count]) => ({ agent, count }));
}

/** A connected agent session that has no Baton task worktree — GET /api/sessions. */
export interface PresenceSession {
  slug: string;
  agent: string | null;
  /** The checkout the session registered from. */
  root: string | null;
  /** Last connect/edit time (ISO). */
  lastSeen: string;
  /** Seen within the heartbeat-fresh window ⇒ actively working, not just idle-connected. */
  live: boolean;
}

/**
 * The presence layer (ADD-07/B): agent sessions registered via MCP connect or
 * edit hooks that are NOT a Baton task worktree — the plain-terminal / connected
 * agents the worktree-only "Active sessions" panel structurally cannot show
 * (ISS-12/ISS-14). Deduped against task slugs so a task's own MCP session is not
 * listed twice, and windowed to recently-seen sessions by `liveSessions`.
 */
export async function collectPresence(root: string): Promise<PresenceSession[]> {
  const tasks = await loadTasks(root);
  const taskSlugs = new Set(tasks.map((t) => t.slug));
  const now = Date.now();
  return liveSessions(root)
    .filter((s) => !taskSlugs.has(s.slug))
    .map((s) => ({
      slug: s.slug,
      agent: s.agent,
      root: s.root,
      lastSeen: s.at,
      live: now - Date.parse(s.at) < WATCHER_HEARTBEAT_STALE_MS,
    }));
}
