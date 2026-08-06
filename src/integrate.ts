/**
 * The integration barrier's git half — §9 of the task-pipeline spec.
 *
 * `src/pipeline.ts` decides whether a phase holds the barrier, but it is pure
 * and cannot ask git anything. It takes the answer as an injected
 * `integrated(phase)`. This module produces that answer, and performs the
 * integration that clears it.
 *
 * The split matters: gating is decided by unit-tested pure functions, and the
 * only code that touches a repository is here, where it can be read in one
 * sitting.
 */
import { isAncestor, trialIntegrate, type IntegrationTrial } from './git.js';
import { isTerminal, phaseOf, stateOf, type PipelineTask } from './pipeline.js';
import type { Task } from './store.js';

/**
 * The branches a phase still has to land.
 *
 * `done` only. A cancelled task's branch is work someone deliberately dropped —
 * waiting for it to land would wedge the plan on a decision that was already
 * made, which is the same trap `TERMINAL` avoids in the pure layer.
 */
export function phaseBranches(tasks: readonly Task[], phase: number): Task[] {
  return tasks.filter((t) => phaseOf(t as PipelineTask) === phase && stateOf(t as PipelineTask) === 'done' && t.branch);
}

/** Where a task's branch lives — its own repo in a hub, else the baton root. */
function repoOf(t: Task, root: string): string {
  return t.repoRoot ?? root;
}

/**
 * Has this phase landed on the base?
 *
 * A branch counts as landed when its tip is already an ancestor of the base —
 * which covers a squash-merge followed by `baton merge`'s archive, a manual
 * merge, and a branch someone deleted after merging. A branch that no longer
 * exists is treated as landed rather than as an error: refusing to advance
 * because a merged branch was tidied up would punish the tidy.
 */
export async function phaseIntegrated(
  root: string,
  tasks: readonly Task[],
  phase: number,
): Promise<boolean> {
  const pending = phaseBranches(tasks, phase);
  if (pending.length === 0) return true;   // §9: an all-cancelled phase integrates nothing
  for (const t of pending) {
    if (!(await isAncestor(t.branch, t.baseBranch, repoOf(t, root)))) return false;
  }
  return true;
}

/**
 * Which phases have landed — precomputed so the pure gating stays synchronous.
 *
 * Only phases that could possibly hold something are asked about: a phase with
 * unfinished work is not complete, so its integration status cannot matter yet,
 * and asking git about it would spend a process per task on every 2s poll.
 */
export async function integratedPhases(root: string, tasks: readonly Task[]): Promise<Set<number>> {
  const done = new Set<number>();
  const phases = new Set<number>();
  for (const t of tasks) {
    const p = phaseOf(t as PipelineTask);
    if (p >= 1) phases.add(p);
  }
  for (const p of [...phases].sort((a, b) => a - b)) {
    const inPhase = tasks.filter((t) => phaseOf(t as PipelineTask) === p);
    if (!inPhase.every((t) => isTerminal(stateOf(t as PipelineTask)))) continue;
    if (await phaseIntegrated(root, tasks, p)) done.add(p);
  }
  return done;
}

/**
 * Would this phase's branches land together? Nothing is written either way.
 *
 * Every branch is trialled against the same base, so this can only speak for a
 * phase whose tasks share one repository. In a hub they may not, and a trial
 * that silently merged one repo's branches onto another repo's base would be
 * worse than no answer — so each repo is trialled separately and the first
 * conflict wins.
 */
export async function checkPhaseIntegration(
  root: string,
  tasks: readonly Task[],
  phase: number,
): Promise<IntegrationTrial> {
  const pending = phaseBranches(tasks, phase);
  const byRepo = new Map<string, Task[]>();
  for (const t of pending) {
    const repo = repoOf(t, root);
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), t]);
  }
  const ok: string[] = [];
  for (const [repo, group] of byRepo) {
    const unlanded: string[] = [];
    for (const t of group) {
      if (await isAncestor(t.branch, t.baseBranch, repo)) ok.push(t.branch);  // already in
      else unlanded.push(t.branch);
    }
    const base = group[0]!.baseBranch;
    const trial = await trialIntegrate(base, unlanded, repo);
    ok.push(...trial.ok);
    if (trial.conflict) return { ok, conflict: trial.conflict };
  }
  return { ok, conflict: null };
}
