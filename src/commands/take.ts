/**
 * `baton take [slug]` — pick up work.
 *
 * Two kinds of pickup, one verb, because from the agent's side they are the
 * same act. A queued pipeline task is CLAIMED (won under the lock, worktree
 * built on the spot). Anything else falls through to the original behavior:
 * read the handoff brief in this worktree and print its execution prompt.
 *
 * The pipeline path is tried first and only ever fires on a task the pipeline
 * actually owns, so every pre-pipeline use of this command is untouched.
 *
 * `baton done [slug]` — mark the brief done.
 */
import { activeBatonRoot, getTask, loadTasks } from '../store.js';
import { briefStalenessWarning, readBrief, setBriefStatus } from '../handoff/brief.js';
import { resolveTask } from './pass.js';
import { isTerminal, stateOf } from '../pipeline.js';
import { nextFor } from '../lifecycle.js';
import { claimTask, ClaimRefused } from './claim.js';
import { describeTask } from './next.js';
import { finishTask, reportFinish } from './finish.js';
import { resolveAgentId, resolveSessionSlug } from '../identity.js';

/** Did this call reach the pipeline? Returns false to fall through to briefs. */
async function tryPipeline(root: string, slug: string | undefined, resume: boolean): Promise<boolean> {
  const agent = await resolveAgentId();
  const who = { agent, sessionSlug: resolveSessionSlug() };

  let target = slug;
  if (!target) {
    // No slug: only take over the pipeline when it actually has work for us.
    // Otherwise this is a brief pickup and we must not interfere.
    const pick = nextFor(agent, await loadTasks(root));
    if (!pick) return false;
    target = pick.slug;
  } else {
    const t = await getTask(root, target);
    if (!t) return false;
    // A row with no stored state predates the pipeline — a plain `baton new`
    // task. Those keep the original brief behavior untouched.
    if (t.state === undefined) return false;
    const state = stateOf(t);
    if (state === 'active' || state === 'claimed') {
      // Mine already: fall through, so `take` inside my own worktree still reads
      // a HANDOFF.md the way it always has.
      if (t.claimedBy?.sessionSlug === who.sessionSlug && !resume) return false;
      if (!resume) {
        // Someone else's. Saying "no HANDOFF.md" here would be a non-sequitur —
        // and worse, it reads as "nothing here" when the truth is "occupied".
        console.error(`✗ '${target}' is ${state}, held by ${t.claimedBy?.agent ?? 'another session'}.`);
        console.error(`  If they have stopped, adopt it with: baton take ${target} --resume`);
        process.exitCode = 1;
        return true;
      }
    } else if (state !== 'queued') {
      console.error(`✗ '${target}' is ${state} — nothing to pick up.`);
      process.exitCode = 1;
      return true;
    }
  }

  try {
    const { task, materialized, adoptedFrom } = await claimTask(root, target, who, { resume });
    console.log(adoptedFrom ? `✓ adopted ${task.slug} from ${adoptedFrom}` : `✓ claimed ${task.slug}`);
    for (const line of describeTask(task)) console.log(line);
    console.log('');
    if (materialized) console.log(`  worktree: ${task.worktreePath}  (${task.branch})`);
    else console.log(`  worktree: ${task.worktreePath}  (existing work — read it before adding to it)`);
    console.log(`    cd ${task.worktreePath}`);
    console.log(`\n  When you stop for any reason:  baton pause ${task.slug}`);
    console.log(`  When it is finished:           baton done ${task.slug}`);
    return true;
  } catch (e) {
    if (!(e instanceof ClaimRefused)) throw e;
    console.error(`✗ ${e.message}`);
    process.exitCode = 1;
    return true;   // handled — do not also try the brief path
  }
}

export async function takeCmd(slug: string | undefined, opts: { resume?: boolean } = {}): Promise<void> {
  const root = await activeBatonRoot();
  if (await tryPipeline(root, slug, Boolean(opts.resume))) return;

  const task = await resolveTask(root, slug);
  if (!task) {
    console.error(slug ? `No task '${slug}'. See: baton ls` : 'Not inside a baton worktree — pass a slug: baton take <slug>');
    process.exitCode = 1;
    return;
  }
  const brief = await readBrief(task.worktreePath);
  if (!brief) {
    console.error(`No HANDOFF.md in ${task.worktreePath} — nothing to take. Create one with: baton pass ${task.slug}`);
    process.exitCode = 1;
    return;
  }
  if (brief.meta.baton !== 1) {
    console.error('HANDOFF.md is not a baton brief (missing `baton: 1` frontmatter).');
    process.exitCode = 1;
    return;
  }
  if (brief.meta.status === 'done') {
    console.error('This brief is already marked done. Re-pass if there is new work: baton pass');
    process.exitCode = 1;
    return;
  }
  await setBriefStatus(task.worktreePath, 'in-progress');
  const staleWarning = await briefStalenessWarning(task.worktreePath, brief.meta.created);

  // The execution prompt — paste (or pipe) this into the receiving agent.
  // The staleness warning goes INSIDE the delimiters so a piped agent sees it.
  console.log('────────────────────────────────────────────────────────');
  if (staleWarning) console.log(staleWarning + '\n');
  console.log(brief.body.trim());
  console.log('────────────────────────────────────────────────────────');
  console.log(`(brief: ${task.worktreePath}/HANDOFF.md · status → in-progress)`);
}

export async function doneCmd(slug: string | undefined, opts: { attest?: boolean; force?: boolean } = {}): Promise<void> {
  const root = await activeBatonRoot();
  const task = await resolveTask(root, slug);
  if (!task) {
    console.error(slug ? `No task '${slug}'` : 'Not inside a baton worktree — pass a slug: baton done <slug>');
    process.exitCode = 1;
    return;
  }

  // A pipeline task goes through the evidence gate. Anything predating the
  // pipeline (no stored state) keeps flipping its brief, as it always did.
  if (task.state !== undefined) {
    const state = stateOf(task);
    if (isTerminal(state)) {
      console.error(`✗ '${task.slug}' is already ${state}.`);
      process.exitCode = 1;
      return;
    }
    if (state === 'review') {
      console.error(`✗ '${task.slug}' is in review — a different agent decides it now.`);
      process.exitCode = 1;
      return;
    }
    const who = { agent: await resolveAgentId(), sessionSlug: resolveSessionSlug() };
    if (task.claimedBy && task.claimedBy.agent !== who.agent) {
      // Marking someone else's task done is the "wrong task" hallucination in
      // its most damaging form: it closes work nobody checked.
      console.error(`✗ '${task.slug}' is held by ${task.claimedBy.agent}, not you.`);
      process.exitCode = 1;
      return;
    }
    reportFinish(task.slug, await finishTask(root, task, who, opts));
    return;
  }

  const ok = await setBriefStatus(task.worktreePath, 'done');
  console.log(ok ? `✓ ${task.slug} marked done — merge with: baton merge ${task.slug}` : 'No HANDOFF.md to update.');
}
