/**
 * `baton cancel` — stop work without destroying it (§8).
 *
 * Three scopes, one verb: a task, a phase, or a whole plan. Cancelling is
 * COOPERATIVE — Baton cannot halt an agent mid-thought, so this writes state the
 * agent observes on its next tool call, and between the click and that call it
 * keeps writing. That window is real and is stated rather than papered over.
 *
 * Nothing is deleted. Branch, worktree and every checkpoint survive, because
 * cancelling reverses a decision and the commits are often the most valuable
 * thing an abandoned approach produced.
 *
 * The blast radius is shown BEFORE anything is written, and it is the same
 * computation the write consumes — a preview derived by different code from the
 * action is a preview that can lie about the action.
 */
import { activeBatonRoot, mutateTasks } from '../store.js';
import { blastRadius, agentsStopped, type BlastRadius, type CancelScope, type PipelineTask } from '../pipeline.js';
import { cancelTasks } from '../lifecycle.js';
import { resolveAuthor } from '../identity.js';
import { requireOperator } from '../operator.js';

export interface CancelOpts {
  phase?: string;
  plan?: string;
  reason?: string;
  dryRun?: boolean;
  yes?: boolean;
}

/** The scope the flags describe, or a message saying why they do not describe one. */
export function resolveScope(slug: string | undefined, opts: CancelOpts): CancelScope | string {
  const named = [slug && 'a slug', opts.phase && '--phase', opts.plan && '--plan'].filter(Boolean);
  if (named.length === 0) return 'Name what to cancel: a slug, --phase <n>, or --plan <id>.';
  // Ambiguity here is not a nuisance, it is a wrong blast radius. `baton cancel
  // auth-api --phase 2` could mean either, and guessing would stop work nobody
  // asked to stop.
  if (named.length > 1) return `Pick one scope — you passed ${named.join(' and ')}.`;

  if (slug) return { kind: 'task', slug };
  if (opts.plan) return { kind: 'plan', planId: opts.plan };
  const phase = Number(opts.phase);
  if (!Number.isInteger(phase) || phase < 1) return `Not a phase: '${opts.phase}'. Phases are whole numbers from 1.`;
  return { kind: 'phase', phase };
}

function describeScope(scope: CancelScope): string {
  if (scope.kind === 'task') return `'${scope.slug}'`;
  if (scope.kind === 'phase') return `phase ${scope.phase}`;
  return `plan '${scope.planId}'`;
}

/** The confirmation text — the whole point of computing a blast radius. */
export function renderRadius(scope: CancelScope, r: BlastRadius): string[] {
  const out: string[] = [];
  const live = agentsStopped(r);
  out.push(`Cancelling ${describeScope(scope)} stops ${r.stopping.length} task${r.stopping.length === 1 ? '' : 's'}${live ? ` and ${live} working agent${live === 1 ? '' : 's'}` : ''}:`);
  for (const s of r.stopping) {
    out.push(`  · ${s.slug} (${s.state}${s.holder ? ` — ${s.holder} is on it now` : ''})`);
  }
  if (r.alreadyFinished.length) {
    // Counted separately so the numbers reconcile. "Cancel phase 2" on a mostly
    // finished phase should not silently report a smaller number than the phase
    // has tasks.
    out.push(`\n  ${r.alreadyFinished.length} already finished, untouched: ${r.alreadyFinished.join(', ')}`);
  }
  if (r.stranding.length) {
    // The consequence nobody predicts. A cancelled dependency never reaches
    // `done`, and `depBlocker` refuses it forever — so these are not delayed,
    // they are unstartable until someone cancels them too or edits the plan.
    out.push(`\n  ⚠ ${r.stranding.length} task${r.stranding.length === 1 ? '' : 's'} will be STRANDED — they depend on this and can never start:`);
    for (const s of r.stranding) out.push(`      ${s.slug} → needs ${s.dependsOn.join(', ')}`);
    out.push('      Cancel those too, or edit the plan and re-apply.');
  }
  out.push('\n  Nothing is deleted: branches, worktrees and checkpoints all stay.');
  return out;
}

export async function cancelCmd(slug: string | undefined, opts: CancelOpts = {}): Promise<void> {
  const root = await activeBatonRoot();
  // §7.6: cancelling is the operator's. A member stopping work on their own
  // machine would diverge from the hub's plan with nothing reporting it.
  if (!(await requireOperator(root, 'baton cancel'))) return;

  const scope = resolveScope(slug, opts);
  if (typeof scope === 'string') {
    console.error(`✗ ${scope}`);
    process.exitCode = 1;
    return;
  }

  const actor = await resolveAuthor(root);
  const now = new Date().toISOString();

  const outcome = await mutateTasks(root, (tasks) => {
    // Computed INSIDE the lock, against the list about to be written — the
    // board someone read a moment ago may already be stale, and a blast radius
    // measured against a stale board stops the wrong work.
    const radius = blastRadius(tasks as PipelineTask[], scope);
    if (!radius.stopping.length) return { tasks: null, result: { radius, cancelled: [] as string[] } };
    if (opts.dryRun) return { tasks: null, result: { radius, cancelled: [] as string[] } };
    const r = cancelTasks(tasks, radius.stopping.map((s) => s.slug), actor, now, opts.reason);
    return { tasks: r.tasks, result: { radius, cancelled: r.cancelled } };
  });

  const { radius, cancelled } = outcome;
  if (!radius.stopping.length) {
    const finished = radius.alreadyFinished.length;
    console.log(finished
      ? `Nothing to cancel in ${describeScope(scope)} — all ${finished} task${finished === 1 ? ' is' : 's are'} already finished.`
      : `Nothing to cancel — ${describeScope(scope)} matched no unfinished tasks.`);
    return;
  }

  for (const line of renderRadius(scope, radius)) console.log(line);

  if (opts.dryRun) {
    console.log('\n(dry run — nothing cancelled)');
    return;
  }

  console.log(`\n✓ cancelled ${cancelled.length} task${cancelled.length === 1 ? '' : 's'}${opts.reason ? ` — ${opts.reason}` : ''}`);
  // The honest part. Cancellation is state an agent reads, not a signal that
  // interrupts it, so promising an immediate stop would be a lie the user finds
  // out about by watching commits land after the confirmation.
  console.log('  Agents still running learn on their next tool call and stop there.');
  console.log('  Their work is intact — inspect a branch before you discard it.');
}
