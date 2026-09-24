// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shared status collection — the structured data behind `baton status` and the
 * `baton serve` /api/status endpoint. One source of truth for both.
 */
import { detectAgents, detectionRoots, detectRootAgents, type RootAgentSession } from './agents.js';
import { computeConflicts } from './conflicts.js';
import { aheadBehindOrNull, worktreeStatus, type RepoState, type WorktreeFileEntry } from './git.js';
import { isMaterialized, loadTasks } from './store.js';
import { isMcpSessionSlug, liveSessions, WATCHER_HEARTBEAT_STALE_MS, type LiveSession } from './signals.js';
import type { IdentitySource } from './identity.js';
import { runningHeadless } from './spawn.js';

export interface StatusRow {
  slug: string;
  task: string;
  agent: string | null;
  /** `missing` = the worktree is recorded but not on disk. See `worktreeStatus`. */
  status: 'clean' | 'dirty' | 'conflict' | 'missing';
  repoState: RepoState;
  ahead: number;
  /** False when git could not count `ahead`/`behind` (they then read 0) — e.g. a base branch that no longer resolves. */
  aheadKnown: boolean;
  behind: number;
  conflictFiles: string[];
  filesChanged: number;
  files: WorktreeFileEntry[];
  insertions: number;
  deletions: number;
  createdAt: string;
}

export async function collectStatus(root: string): Promise<StatusRow[]> {
  // Worktree-backed tasks only. A queued plan row names the branch and path it
  // INTENDS to use but has neither yet, so including them would report every
  // unclaimed task as `missing` — true of the directory, wrong about the task —
  // and spawn git + agent detection per phantom path on a 2s poll. The pipeline
  // view is where queued work belongs.
  const tasks = (await loadTasks(root)).filter(isMaterialized);
  // Runs this process started. `detectAgents` memoizes its ps scan for 5s while
  // the poller ticks every 2s, so a just-started agent is absent from the board
  // for up to five seconds — and a print-mode run shorter than that is never
  // shown as working at all. We don't have to infer a run we launched
  // ourselves: this map is the authority, and it is exactly what the Agents
  // screen already merges in (agents/roster.ts).
  const headless = new Map(runningHeadless().map((r) => [r.slug, r.agent]));
  const [agents, conflicts] = await Promise.all([
    detectAgents(tasks.map((t) => t.worktreePath), { root: detectionRoots(root, tasks) }),
    computeConflicts(tasks, root),
  ]);

  return Promise.all(
    tasks.map(async (t) => {
      const st = await worktreeStatus(t.worktreePath);
      // The task's OWN repo: in a hub the branch lives in the sub-project, and
      // the served root may not be a git repo at all. aheadBehind swallows
      // every error as {0,0}, so asking the wrong repo drew each hub task with
      // nothing to merge — the column that says "this is ready" reading zero.
      const counted = await aheadBehindOrNull(t.branch, t.baseBranch, t.repoRoot ?? root);
      const { ahead, behind } = counted ?? { ahead: 0, behind: 0 };
      return {
        slug: t.slug,
        task: t.task,
        // Scan first, headless second — the same precedence roster.ts uses, so
        // one agent never gets two names across two screens.
        agent: agents.get(t.worktreePath) ?? headless.get(t.slug) ?? null,
        status: st.state,
        repoState: st.repoState,
        ahead,
        behind,
        aheadKnown: counted !== null,
        conflictFiles: conflicts.get(t.slug) ?? [],
        filesChanged: st.changedFiles.length,
        files: st.files,
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
  // Every scanned root contributes its patterns, not just the hub: a
  // sub-project's own `.baton/agents.json` agents run in that sub-project's
  // checkout, and hub-only patterns would drop them from the count.
  const detect = opts.detect ?? ((inc: string[], exc: string[]) => detectRootAgents(inc, exc, { root: [hubRoot, ...kbProjectPaths] }));
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
  /** How `agent` was resolved; null on pre-phase-7 rows. `ancestry-inferred` is a guess. */
  agentSource: IdentitySource | null;
}

/**
 * One Claude root session writes TWO rows — its MCP server's `sess-p<pid>` and
 * its edit hook's `sess-<id8>`. Fold the hook rows into the MCP row when they
 * share an exact (agent, host_pid) and that group has exactly ONE MCP row:
 * Cursor runs one MCP process per app, so several rows can share a host pid and
 * folding into one of them would be a guess. Keeps the latest `at`.
 */
function mergeSessionRows(rows: LiveSession[]): LiveSession[] {
  const groups = new Map<string, LiveSession[]>();
  for (const r of rows) {
    if (r.agent === null || r.hostPid === null) continue;
    const k = `${r.agent}\u0000${r.hostPid}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const drop = new Set<LiveSession>();
  const bump = new Map<LiveSession, string>();
  for (const g of groups.values()) {
    const mcp = g.filter((r) => isMcpSessionSlug(r.slug));
    if (mcp.length !== 1 || g.length < 2) continue;
    const latest = g.reduce((a, r) => (r.at > a ? r.at : a), mcp[0].at);
    bump.set(mcp[0], latest);
    for (const r of g) if (r !== mcp[0]) drop.add(r);
  }
  return rows.filter((r) => !drop.has(r)).map((r) => (bump.has(r) ? { ...r, at: bump.get(r)! } : r));
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
  return mergeSessionRows(liveSessions(root).filter((s) => !taskSlugs.has(s.slug)))
    .map((s) => ({
      slug: s.slug,
      agent: s.agent,
      root: s.root,
      lastSeen: s.at,
      live: now - Date.parse(s.at) < WATCHER_HEARTBEAT_STALE_MS,
      agentSource: s.agentSource,
    }));
}
