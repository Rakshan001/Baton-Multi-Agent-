/**
 * `baton pause [slug]`  — hand a task back without finishing it.
 * `baton block [slug]`  — report that it cannot proceed.
 *
 * These exist because the alternative is worse than either of them. Without an
 * honest way to stop, an interrupted session leaves a task `active` under an
 * agent that is gone — and the only signals left are a stall timer and a guess.
 * A stop that says so is not a failure to report; it is the report.
 */
import { activeBatonRoot, getTask, mutateTasks } from '../store.js';
import { block, pause, type Outcome } from '../lifecycle.js';
import { resolveAgentId, resolveSessionSlug } from '../identity.js';
import { resolveTask } from './pass.js';

async function resolveSlug(root: string, slug: string | undefined): Promise<string | null> {
  if (slug) return (await getTask(root, slug)) ? slug : null;
  return (await resolveTask(root, undefined))?.slug ?? null;
}

function report(o: Outcome, done: (t: NonNullable<Extract<Outcome, { ok: true }>['task']>) => void): void {
  if (o.ok) { done(o.task); return; }
  console.error(`✗ ${o.refusal.message}`);
  process.exitCode = 1;
}

export async function pauseCmd(slug: string | undefined, opts: { reason?: string } = {}): Promise<void> {
  const root = await activeBatonRoot();
  const target = await resolveSlug(root, slug);
  if (!target) {
    console.error(slug ? `No task '${slug}'. See: baton ls` : 'Not inside a task worktree — pass a slug: baton pause <slug>');
    process.exitCode = 1;
    return;
  }
  const who = { agent: await resolveAgentId(), sessionSlug: resolveSessionSlug() };
  const now = new Date().toISOString();

  const out = await mutateTasks(root, (tasks) => {
    const o = pause(tasks, target, who, now, opts.reason);
    return { tasks: o.ok ? o.tasks : null, result: o };
  });

  report(out, (t) => {
    console.log(`✓ ${t.slug} handed back — queued, not done.`);
    console.log(`  The worktree and branch are untouched: ${t.worktreePath}`);
    if (t.stoppedReason) console.log(`  reason: ${t.stoppedReason}`);
    console.log(`  Anyone can continue it with: baton take ${t.slug}`);
  });
}

export async function blockCmd(slug: string | undefined, reason: string): Promise<void> {
  const root = await activeBatonRoot();
  const target = await resolveSlug(root, slug);
  if (!target) {
    console.error(slug ? `No task '${slug}'. See: baton ls` : 'Not inside a task worktree — pass a slug: baton block <slug> "<why>"');
    process.exitCode = 1;
    return;
  }
  const who = { agent: await resolveAgentId(), sessionSlug: resolveSessionSlug() };

  const out = await mutateTasks(root, (tasks) => {
    const o = block(tasks, target, who, reason, new Date().toISOString());
    return { tasks: o.ok ? o.tasks : null, result: o };
  });

  report(out, (t) => {
    // Owned, not returned to the pool: the next agent would hit the same wall.
    console.log(`⊘ ${t.slug} blocked — still yours, waiting on a person.`);
    console.log(`  ${t.stoppedReason}`);
    console.log('  It shows on `baton ls` and `baton next` until someone resolves it.');
  });
}
