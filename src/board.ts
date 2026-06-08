/**
 * Shared status collection — the structured data behind `baton status` and the
 * `baton serve` /api/status endpoint. One source of truth for both.
 */
import { detectAgents } from './agents.js';
import { computeConflicts } from './conflicts.js';
import { aheadBehind, worktreeStatus } from './git.js';
import { loadTasks } from './store.js';

export interface StatusRow {
  slug: string;
  task: string;
  agent: string | null;
  status: 'clean' | 'dirty' | 'conflict';
  ahead: number;
  behind: number;
  conflictFiles: string[];
  filesChanged: number;
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
        ahead,
        behind,
        conflictFiles: conflicts.get(t.slug) ?? [],
        filesChanged: st.changedFiles.length,
        createdAt: t.createdAt,
      };
    }),
  );
}
