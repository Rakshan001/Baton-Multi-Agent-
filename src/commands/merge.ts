/**
 * `baton merge <slug>` — merge a task's branch into the current branch.
 *
 * Default: SQUASH into one clean commit (keeps the agent's WIP commits out of
 * the real history) and ARCHIVE the full branch history to a hidden ref
 * (refs/baton/archive/<slug>) — preserved, never pushed, bisectable. Also
 * records the task's commits/files into the local history index for tracing.
 */
import { archiveBranch, branchCommits, currentBranch, mergeBranch, type ConflictEntry } from '../git.js';
import { detectAgents } from '../agents.js';
import { recordMerge } from '../history.js';
import { getTask, loadTasks, resolveBatonRoot, TaskNotFoundError } from '../store.js';
import { computeConflicts } from '../conflicts.js';
import { update } from '../kb/graphify.js';
import { buildQueue, loadKb } from '../kb/state.js';
import { bus } from '../events.js';
import { buildReport, saveReport, writeReportFile } from '../reports.js';

/** Thrown when a merge aborts on conflicts; carries the labelled file list. */
export class MergeConflictError extends Error {
  conflicts: ConflictEntry[];
  branch: string;
  into: string;
  constructor(branch: string, into: string, conflicts: ConflictEntry[]) {
    super(`merge of ${branch} → ${into} hit conflicts`);
    this.name = 'MergeConflictError';
    this.conflicts = conflicts;
    this.branch = branch;
    this.into = into;
  }
}

export interface MergeResult {
  merged: string;
  into: string;
  branch: string;
  squashed: boolean;
  archivedRef: string | null;
}

/**
 * Core merge logic, shared by the CLI (`baton merge`) and the HTTP API
 * (`POST /api/tasks/:slug/merge`). Throws TaskNotFoundError / MergeConflictError.
 */
export async function mergeTaskBranch(
  slug: string,
  opts: { squash?: boolean; archive?: boolean } = {},
  root?: string,
): Promise<MergeResult> {
  const repoRoot = root ?? (await resolveBatonRoot());
  const task = await getTask(repoRoot, slug);
  if (!task) throw new TaskNotFoundError(slug);
  // In a hub the branch lives in the sub-project's repo, not the (non-git) hub root.
  const gitRepo = task.repoRoot ?? repoRoot;

  const squash = opts.squash !== false; // default true
  const archive = opts.archive !== false; // default true
  const into = await currentBranch(gitRepo);

  // Capture the branch's commits BEFORE merging (squash would otherwise hide them).
  const commits = await branchCommits(task.branch, task.baseBranch, gitRepo);
  const agents = await detectAgents([task.worktreePath]);
  // Overlap snapshot before the merge — who else is touching the same files.
  const allTasks = await loadTasks(repoRoot);
  const overlapMap = await computeConflicts(allTasks, repoRoot).catch(() => new Map<string, string[]>());
  const myOverlapFiles = new Set(overlapMap.get(slug) ?? []);
  const overlappedWith = allTasks
    .filter((t) => t.slug !== slug && (overlapMap.get(t.slug) ?? []).some((f) => myOverlapFiles.has(f)))
    .map((t) => t.slug);

  const { success, conflicts } = await mergeBranch(task.branch, task.task, { squash }, gitRepo);
  if (!success) throw new MergeConflictError(task.branch, into, conflicts);

  let archivedRef: string | null = null;
  if (archive) {
    const ok = await archiveBranch(slug, task.branch, gitRepo);
    if (ok) archivedRef = `refs/baton/archive/${slug}`;
  }
  recordMerge(repoRoot, {
    slug,
    agent: agents.get(task.worktreePath) ?? null,
    mergedAt: new Date().toISOString(),
    archivedRef,
    commits,
  });

  // Completion report: what shipped, for whoever was waiting on these files.
  const report = buildReport({
    slug,
    task: task.task,
    agent: agents.get(task.worktreePath) ?? null,
    mergedAt: new Date().toISOString(),
    commits,
    overlappedWith,
  });
  saveReport(repoRoot, report);
  void writeReportFile(repoRoot, report);

  bus.publish({ type: 'task.merged', slug, report });

  // Keep the knowledge graph current: squash-merges land on the base branch
  // outside graphify's per-commit hook, so queue an incremental update here.
  // Fire-and-forget — a graph refresh must never block or fail a merge.
  void loadKb(repoRoot).then((kb) => {
    if (!kb) return;
    for (const p of kb.projects) {
      buildQueue.enqueue(p.id, () => update(p.path), (err) => {
        if (!err) bus.publish({ type: 'kb.rebuilt', project: p.id });
      });
    }
  }).catch(() => undefined);

  return { merged: slug, into, branch: task.branch, squashed: squash, archivedRef };
}

export async function mergeCmd(
  slug: string,
  opts: { squash?: boolean; archive?: boolean } = {},
): Promise<void> {
  try {
    const r = await mergeTaskBranch(slug, opts);
    console.log(`✓ merged ${r.branch} → ${r.into}${r.squashed ? ' (squashed to one commit)' : ''}`);
    if (r.archivedRef) {
      console.log(`  history preserved at ${r.archivedRef} (hidden; view: git log ${r.archivedRef})`);
    }
    console.log(`  remove the worktree with: baton rm ${slug}`);
  } catch (e) {
    if (e instanceof TaskNotFoundError) {
      console.error(`No task '${slug}'. See: baton ls`);
    } else if (e instanceof MergeConflictError) {
      console.error(`✗ merge of ${e.branch} → ${e.into} hit conflicts (merge aborted):`);
      for (const c of e.conflicts) console.error(`    ${c.path} (${c.label})`);
      console.error('  Resolve in the worktree, commit, then merge again.');
    } else {
      console.error((e as Error).message);
    }
    process.exitCode = 1;
  }
}
