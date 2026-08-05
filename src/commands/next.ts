/**
 * `baton next` — "do you have any pending task?"
 *
 * The answer an agent gets when there is nothing is the interesting half. Told
 * only "none", five agents look exactly like a finished plan, and a wedged
 * pipeline looks like a quiet one. So every empty answer carries its cause, and
 * a pipeline that genuinely cannot advance says so in those words.
 */
import { activeBatonRoot, loadTasks, type Task } from '../store.js';
import { blockers, isDeadlocked, isStalled, openPhase, phaseOf, stateOf, STALL_GRACE_MS } from '../pipeline.js';
import { nextFor } from '../lifecycle.js';
import { livenessProbe } from '../liveness.js';
import { resolveAgentId } from '../identity.js';

export function describeTask(t: Task): string[] {
  const out = [`  ${t.slug}${t.phase ? `  (phase ${t.phase})` : ''}`, `    ${t.task}`];
  if (t.scope?.length) out.push(`    scope: ${t.scope.join(', ')}`);
  if (t.principles?.length) out.push(`    principles: ${t.principles.join('; ')}`);
  if (t.expects?.length) out.push(`    expects: ${t.expects.join('; ')}`);
  return out;
}

export async function nextCmd(opts: { agent?: string } = {}): Promise<void> {
  const root = await activeBatonRoot();
  const tasks = await loadTasks(root);
  const agent = opts.agent ?? (await resolveAgentId());

  if (!tasks.length) {
    console.log('No tasks yet. Apply a plan (baton plan apply <name>) or add one (baton task add "<what>").');
    return;
  }

  const pick = nextFor(agent, tasks);
  if (pick) {
    console.log(`Next for ${agent}:\n`);
    for (const line of describeTask(pick)) console.log(line);
    console.log(`\n  Start it:  baton take ${pick.slug}`);
    return;
  }

  console.log(`Nothing eligible for ${agent}.\n`);

  const open = openPhase(tasks);
  if (open === Infinity) {
    console.log('  ✓ every phase is complete.');
    return;
  }

  const inOpen = tasks.filter((t) => phaseOf(t) === open);
  const remaining = inOpen.filter((t) => stateOf(t) !== 'done' && stateOf(t) !== 'cancelled');
  console.log(`  phase ${open} holds the barrier: ${remaining.length} of ${inOpen.length} remaining`);
  for (const b of blockers(tasks).filter((x) => remaining.some((t) => t.slug === x.slug))) {
    console.log(`    ${b.slug}  ${b.reason}`);
  }

  const locked = tasks.filter((t) => phaseOf(t) > open && stateOf(t) === 'queued');
  if (locked.length) console.log(`  phase ${open + 1}+ locked behind it (${locked.length} task${locked.length === 1 ? '' : 's'})`);

  // Stalled work is offered before the deadlock verdict: an agent that can adopt
  // something is not actually stuck, and saying "stalled" first would send it
  // to a human it does not need.
  const liveness = livenessProbe(root);
  const stalled = tasks.filter((t) => isStalled(t, { now: Date.now(), livenessOf: liveness }));
  if (stalled.length) {
    console.log(`\n  ${stalled.length} stalled task${stalled.length === 1 ? '' : 's'} you may adopt (silent > ${Math.round(STALL_GRACE_MS / 60_000)}m):`);
    for (const t of stalled) console.log(`    ${t.slug}  held by ${t.claimedBy?.agent ?? 'unknown'} — baton take ${t.slug} --resume`);
    return;
  }

  if (isDeadlocked(tasks)) {
    const waiting = blockers(tasks).filter((b) => b.reason.startsWith('blocked'));
    console.log('\n  PIPELINE STALLED: no agent can proceed.');
    for (const b of waiting) console.log(`    ${b.slug}: ${b.reason}`);
    console.log('  This needs a person — resolve a blocker, or cancel a task to let the phase close.');
    process.exitCode = 2;
  }
}
