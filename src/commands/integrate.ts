/**
 * `baton integrate [phase]` — land a finished phase's branches on the base.
 *
 * The barrier detects automatically and never writes; this is the half that
 * writes, and it only runs because someone typed it. That split was a
 * deliberate choice: a tool that merges into your base branch on a timer is one
 * you have to supervise, and the whole point of the barrier is to be the thing
 * you don't have to watch.
 *
 * Order of operations matters. The whole phase is trialled first, and a single
 * conflict refuses the entire command — a half-integrated phase is the worst
 * outcome available, because the next phase would branch from a base carrying
 * some of its foundations and not others.
 */
import { loadTasks, resolveBatonRoot, type Task } from '../store.js';
import { checkPhaseIntegration, phaseBranches } from '../integrate.js';
import { integrationHold, openPhase, phaseComplete, phaseOf, stateOf, type PipelineTask } from '../pipeline.js';
import { integratedPhases } from '../integrate.js';
import { isAncestor } from '../git.js';
import { mergeTaskBranch } from './merge.js';
import { requireOperator } from '../operator.js';

/** The phase to integrate when none was named: the one holding the barrier. */
async function inferPhase(root: string, tasks: Task[]): Promise<number | null> {
  const landed = await integratedPhases(root, tasks);
  const held = integrationHold(tasks as PipelineTask[], { integrated: (p) => landed.has(p) });
  if (held !== null) return held;
  // Nothing is holding the barrier, but a finished phase may still be unlanded
  // — the last phase of a plan has nothing after it to lock, so it never shows
  // as a hold. Offer it rather than reporting "nothing to do" at the one moment
  // the work is finished and waiting to ship.
  const phases = [...new Set(tasks.map((t) => phaseOf(t as PipelineTask)).filter((p) => p >= 1))].sort((a, b) => a - b);
  for (const p of phases) if (phaseComplete(tasks as PipelineTask[], p) && !landed.has(p)) return p;
  return null;
}

export async function integrateCmd(phaseArg?: string, opts: { dryRun?: boolean } = {}): Promise<void> {
  const root = await resolveBatonRoot();
  const tasks = await loadTasks(root);

  let phase: number | null;
  if (phaseArg === undefined) {
    phase = await inferPhase(root, tasks);
    if (phase === null) {
      console.log('Nothing to integrate — every finished phase is already on the base.');
      return;
    }
  } else {
    phase = Number(phaseArg);
    if (!Number.isInteger(phase) || phase < 1) {
      console.error(`Not a phase: '${phaseArg}'. Phases are whole numbers from 1.`);
      process.exitCode = 1;
      return;
    }
  }

  if (!phaseComplete(tasks as PipelineTask[], phase)) {
    const unfinished = tasks.filter(
      (t) => phaseOf(t as PipelineTask) === phase && stateOf(t as PipelineTask) !== 'done' && stateOf(t as PipelineTask) !== 'cancelled',
    );
    console.error(`Phase ${phase} is not finished — ${unfinished.length} task(s) still open:`);
    for (const t of unfinished) console.error(`  · ${t.slug} (${stateOf(t as PipelineTask)})`);
    console.error('\nIntegrating now would land a partial phase. Finish or cancel these first.');
    process.exitCode = 1;
    return;
  }

  const pending = phaseBranches(tasks, phase);
  if (pending.length === 0) {
    console.log(`Phase ${phase} has nothing to land (no finished task carries a branch).`);
    return;
  }

  // Trial the whole phase before touching anything.
  console.log(`Phase ${phase} — checking integration of ${pending.length} branch(es):`);
  const trial = await checkPhaseIntegration(root, tasks, phase);
  if (trial.conflict) {
    for (const b of trial.ok) console.log(`  ✓ ${b}`);
    console.error(`  ✗ ${trial.conflict.branch}  CONFLICT`);
    for (const f of trial.conflict.files) console.error(`      ${f}`);
    console.error(
      `\nPhase ${phase} stays unintegrated and the next phase stays locked. Nothing was merged.\n`
      + `Resolve the overlap in '${trial.conflict.branch}' — rebase it on ${pending[0]!.baseBranch}, `
      + `or merge it by hand — then run \`baton integrate ${phase}\` again.`,
    );
    process.exitCode = 1;
    return;
  }
  for (const b of trial.ok) console.log(`  ✓ ${b}`);

  if (opts.dryRun) {
    console.log(`\nWould integrate phase ${phase}. Nothing written (--dry-run).`);
    return;
  }

  // §7.6, checked here rather than at the top: the trial above writes nothing,
  // and telling a member whether their phase would conflict is useful to them
  // and reveals only what `git merge-tree` on branches they already have would.
  // What is the operator's alone is landing it on the shared base.
  if (!(await requireOperator(root, `baton integrate ${phase}`))) return;

  // Clean. Land them, skipping any that a human already merged.
  console.log('');
  let landed = 0;
  for (const t of pending) {
    if (await isAncestor(t.branch, t.baseBranch, t.repoRoot ?? root)) {
      console.log(`  · ${t.slug} — already on ${t.baseBranch}`);
      continue;
    }
    // A true merge, NOT `baton merge`'s squash, for two reasons that both bite.
    //
    // Ancestry: a squash copies the content and keeps no link to the branch, so
    // the next branch in the same phase computes its merge base against the
    // original base and conflicts with work already sitting on the base. The
    // trial says clean, the merge fails, and the phase ends up half-integrated
    // — which is worse than not starting.
    //
    // Lineage: squashing collapses the phase's commits, and with them the
    // `Baton-Task:` trailers that make `.baton/` disposable. Merging keeps the
    // real commits on the base, so `history reindex` can still rebuild.
    try {
      const r = await mergeTaskBranch(t.slug, { squash: false }, root);
      console.log(`  ✓ ${t.slug} → ${r.into}`);
      landed++;
    } catch (e) {
      // A trial passed and the merge still failed. Say exactly how far this got
      // — a phase reported as failed but partly landed is how someone resolves
      // the wrong thing.
      console.error(`  ✗ ${t.slug} — ${e instanceof Error ? e.message : String(e)}`);
      console.error(
        `\nPhase ${phase} is PARTLY integrated: ${landed} branch(es) landed before this one failed.`
        + `\nThe base has moved. Resolve '${t.branch}', then run \`baton integrate ${phase}\` again —`
        + ` branches already on the base are skipped.`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const opened = openPhase(tasks as PipelineTask[], { integrated: (p) => p <= phase });
  console.log(`\nPhase ${phase} integrated (${landed} merged).`);
  if (opened !== Infinity && opened > phase) console.log(`Phase ${opened} is now open — \`baton next\`.`);
}
