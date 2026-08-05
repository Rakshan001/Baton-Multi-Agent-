/**
 * `baton next` — "do you have any pending task?"
 *
 * The answer an agent gets when there is nothing is the interesting half. Told
 * only "none", five agents look exactly like a finished plan, and a wedged
 * pipeline looks like a quiet one. So every empty answer carries its cause, and
 * a pipeline that genuinely cannot advance says so in those words.
 */
import { activeBatonRoot, loadTasks, type Task } from '../store.js';
import { blockers, isDeadlocked, isStalled, openPhase, phaseOf, reviewableBy, stateOf, STALL_GRACE_MS } from '../pipeline.js';
import { nextFor } from '../lifecycle.js';
import { livenessProbe } from '../liveness.js';
import { resolveAgentId } from '../identity.js';

export function describeTask(t: Task): string[] {
  const out = [`  ${t.slug}${t.phase ? `  (phase ${t.phase})` : ''}`, `    ${t.task}`];
  if (t.scope?.length) out.push(`    scope: ${t.scope.join(', ')}`);
  if (t.principles?.length) out.push(`    principles: ${t.principles.join('; ')}`);
  if (t.expects?.length) out.push(`    expects: ${t.expects.join('; ')}`);
  // A rejection that nobody reads is a rejection loop: the same agent redoes the
  // same work and hands back the same thing. This is where they see the reason.
  if (t.reviewedBy?.verdict === 'reject' && t.reviewedBy.notes) {
    out.push(`    ✗ sent back by ${t.reviewedBy.actor}: ${t.reviewedBy.notes}`);
  }
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

  // Work you already hold, before anything new. Two reasons: a session that came
  // back from an interruption is asking exactly this question and needs to be
  // pointed at its own worktree, and a task sent back by a reviewer lands here —
  // `active`, held, and otherwise invisible, since nothing eligible ever picks it.
  const held = tasks.filter((t) => {
    const s = stateOf(t);
    return (s === 'active' || s === 'claimed' || s === 'blocked') && t.claimedBy?.agent === agent;
  });
  if (held.length) {
    console.log(`You already hold ${held.length} task${held.length === 1 ? '' : 's'}:\n`);
    for (const t of held) {
      for (const line of describeTask(t)) console.log(line);
      console.log(`    cd ${t.worktreePath}`);
      console.log(stateOf(t) === 'blocked'
        ? `    blocked: ${t.stoppedReason ?? 'no reason recorded'} — hand it back with: baton pause ${t.slug}`
        : `    finish it: baton done ${t.slug}   ·   hand it back: baton pause ${t.slug}`);
    }
    console.log('');
  }

  // Reviewing comes first, and not out of politeness: a task in `review` holds
  // its phase exactly like an unfinished one, so clearing the verdict is what
  // lets the barrier lift. Starting yet another task does not.
  const toReview = reviewableBy(agent, tasks) as Task[];
  if (toReview.length) {
    console.log(`Awaiting your verdict (${toReview.length}) — you did not write ${toReview.length === 1 ? 'it' : 'these'}:\n`);
    for (const t of toReview) {
      console.log(`  ${t.slug}  by ${t.contributors?.map((c) => c.agent).join(' → ') ?? t.claimedBy?.agent ?? 'unknown'}`);
      console.log(`    ${t.task}`);
      console.log(`    review it:  cd ${t.worktreePath}  ·  then: baton review approve ${t.slug}  |  baton review reject ${t.slug} -n "<what to fix>"`);
    }
    console.log('');
  }

  const pick = nextFor(agent, tasks);
  if (pick) {
    console.log(`Next for ${agent}:\n`);
    for (const line of describeTask(pick)) console.log(line);
    console.log(`\n  Start it:  baton take ${pick.slug}`);
    return;
  }

  if (toReview.length || held.length) {
    // "Nothing eligible" directly under a list of work would read as a
    // contradiction, and an agent that believes the second line stops.
    console.log('Nothing new to start — the work above is yours to finish.');
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
