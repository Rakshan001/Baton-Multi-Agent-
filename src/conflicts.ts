/**
 * Advisory conflict detection between task branches — "these two tasks both
 * touch Nav.tsx, so a merge conflict is likely." Plain git file-overlap; no
 * graphify / blast-radius needed at this scale.
 */
import { gitTry } from './util/exec.js';
import type { Task } from './store.js';

/** Files a task has changed: committed divergence from base ∪ uncommitted work. */
export async function changedFiles(task: Task, root: string): Promise<Set<string>> {
  const files = new Set<string>();

  // Committed divergence: what's on the branch but not on its base.
  const committed = await gitTry(
    ['diff', '--name-only', `${task.baseBranch}...${task.branch}`],
    root,
  );
  if (committed.ok) {
    for (const f of committed.stdout.split('\n').filter(Boolean)) files.add(f);
  }

  // Uncommitted work-in-progress inside the worktree.
  const uncommitted = await gitTry(['-C', task.worktreePath, 'diff', '--name-only', 'HEAD']);
  if (uncommitted.ok) {
    for (const f of uncommitted.stdout.split('\n').filter(Boolean)) files.add(f);
  }

  return files;
}

/**
 * For each task, the files it shares with at least one other task (sorted).
 * Pure given the per-task file sets — see `computeConflictsFromSets` for tests.
 */
export function computeConflictsFromSets(
  sets: Map<string, Set<string>>,
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const [slug, mine] of sets) {
    const overlap = new Set<string>();
    for (const [other, theirs] of sets) {
      if (other === slug) continue;
      for (const f of mine) if (theirs.has(f)) overlap.add(f);
    }
    result.set(slug, [...overlap].sort());
  }
  return result;
}

/** Resolve each task's changed files, then compute pairwise overlap. */
export async function computeConflicts(
  tasks: Task[],
  root: string,
): Promise<Map<string, string[]>> {
  const sets = new Map<string, Set<string>>();
  await Promise.all(
    tasks.map(async (t) => {
      sets.set(t.slug, await changedFiles(t, root));
    }),
  );
  return computeConflictsFromSets(sets);
}
