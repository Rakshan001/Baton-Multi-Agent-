// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `baton stamp-commit <file>` and `baton history reindex`.
 *
 * The two halves of the durability claim: one writes lineage into git, the other
 * reads it back. `.baton/history.db` is declared rebuildable in the storage
 * model, and this is what makes that true rather than aspirational — delete the
 * database and the trailers in git log put it back.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gitTry } from '../util/exec.js';
import { branchCommits, listBatonBranches, type CommitInfo } from '../git.js';
import { activeBatonRoot, loadTasks, type Task } from '../store.js';
import { recordTask, recordMerge } from '../history.js';
import { taskOf, trustedLineage, withTaskTrailer } from '../trailers.js';

/**
 * Stamp a commit message with the task that owns this worktree.
 *
 * Called by the prepare-commit-msg hook, so it is silent and total: any
 * uncertainty means leaving the message exactly as the agent wrote it. A commit
 * that loses its trailer costs some lineage; a commit that fails to happen
 * costs the work.
 */
export async function stampCommitCmd(msgFile: string): Promise<void> {
  try {
    const top = await gitTry(['rev-parse', '--show-toplevel']);
    if (!top.ok || !top.stdout) return;
    const root = await activeBatonRoot();
    const here = resolve(top.stdout);
    const task = (await loadTasks(root)).find((t) => t.worktreePath && resolve(t.worktreePath) === here);
    if (!task) return;                                  // not a task worktree — not ours to touch

    const message = await readFile(msgFile, 'utf-8');
    const next = withTaskTrailer(message, task.slug);
    if (next !== message) await writeFile(msgFile, next, 'utf-8');
  } catch {
    /* never break a commit */
  }
}

export interface ReindexReport {
  branches: number;
  commits: number;
  indexed: number;
  /** Commits whose trailer named a task this repo never created — see §7.5. */
  forged: { sha: string; slug: string }[];
  /** Commits on a baton branch with no trailer at all (made before the hook). */
  untrailed: number;
}

/**
 * Rebuild the commit index from git.
 *
 * Only `baton/*` branches are walked, and a trailer is honored only when its
 * slug names a task this repository actually created. Both halves matter: a
 * trailer is a claim written by whoever wrote the commit, and anyone who can
 * push can write one. Attribution is what `who_touched` answers when an agent
 * asks whose work a file is, so a forged trailer would put a stranger's commit
 * into a real task's history — and the agent would have no way to tell.
 *
 * Forged claims are counted and reported, not silently dropped. Something
 * writing Baton trailers for tasks that do not exist is worth a person seeing.
 */
export async function reindexHistory(root: string, cwd: string): Promise<ReindexReport> {
  const tasks = await loadTasks(root);
  const bySlug = new Map(tasks.map((t) => [t.slug, t]));
  const branches = await listBatonBranches(cwd);
  const report: ReindexReport = { branches: branches.length, commits: 0, indexed: 0, forged: [], untrailed: 0 };

  // The base to diff each branch against. A task knows its own; anything else
  // falls back to the repo's default, which is what `baton merge` uses too.
  const byBranch = new Map(tasks.map((t) => [t.branch, t]));
  const seen = new Set<string>();
  const perTask = new Map<string, CommitInfo[]>();

  for (const branch of branches) {
    const task = byBranch.get(branch);
    const base = task?.baseCommit ?? task?.baseBranch ?? 'HEAD';
    const commits = await branchCommits(branch, base, cwd);
    for (const c of commits) {
      if (seen.has(c.sha)) continue;                    // a sha reachable from two branches is one commit
      seen.add(c.sha);
      report.commits++;
      if (!taskOf(c.body ?? c.message)) report.untrailed++;
    }
    const fresh = commits.filter((c) => taskOf(c.body ?? c.message));
    const { trusted, rejected } = trustedLineage(fresh.map((c) => ({ sha: c.sha, message: c.body ?? c.message })), new Set(bySlug.keys()));
    report.forged.push(...rejected);
    const infoBySha = new Map(fresh.map((c) => [c.sha, c]));
    for (const { sha, slug } of trusted) {
      const info = infoBySha.get(sha);
      if (!info) continue;
      const list = perTask.get(slug) ?? [];
      if (!list.some((c) => c.sha === sha)) list.push(info);
      perTask.set(slug, list);
    }
  }

  for (const [slug, commits] of perTask) {
    const t = bySlug.get(slug) as Task | undefined;
    if (!t) continue;
    // The task row has to exist before its commits can join to it.
    recordTask(root, {
      slug: t.slug, task: t.task, agent: t.claimedBy?.agent ?? null,
      branch: t.branch, baseBranch: t.baseBranch, createdAt: t.createdAt,
    });
    // Reuses the merge recorder deliberately: one INSERT path for commits means
    // a reindexed row and a merged row are indistinguishable afterwards, which
    // is the entire point of calling the database rebuildable.
    recordMerge(root, {
      slug, mergedAt: t.finishedSha ? new Date().toISOString() : t.createdAt,
      // The task's own project, not the cwd's: in a hub the branch lives in the
      // sub-project, and mis-scoping paths is what made same-named files in
      // different projects read as collisions.
      archivedRef: null, commits, projectId: t.projectId ?? null,
    });
    report.indexed += commits.length;
  }
  return report;
}

export async function historyReindexCmd(): Promise<void> {
  const root = await activeBatonRoot();
  const r = await reindexHistory(root, process.cwd());

  console.log(`Walked ${r.branches} baton branch${r.branches === 1 ? '' : 'es'}, ${r.commits} commit${r.commits === 1 ? '' : 's'}.`);
  console.log(`  ✓ ${r.indexed} indexed from Baton-Task: trailers`);
  if (r.untrailed) {
    console.log(`  · ${r.untrailed} with no trailer — committed before the hook, or with BATON_NO_TRAILER set.`);
  }
  if (r.forged.length) {
    // Loud, and never "cleaned up" for the reader: a trailer naming a task this
    // repo never created is either a mistake worth fixing or someone claiming
    // attribution they do not have. Both need a person.
    console.log(`\n  ⚠ ${r.forged.length} commit${r.forged.length === 1 ? ' claims' : 's claim'} a task that does not exist here — NOT indexed:`);
    for (const f of r.forged.slice(0, 10)) console.log(`      ${f.sha.slice(0, 9)}  Baton-Task: ${f.slug}`);
    if (r.forged.length > 10) console.log(`      … and ${r.forged.length - 10} more`);
  }
  if (!r.indexed && !r.commits) console.log('  Nothing to index yet — no commits on any baton branch.');
}
