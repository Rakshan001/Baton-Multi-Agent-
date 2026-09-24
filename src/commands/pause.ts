// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
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
import { quotedInline } from '../handoff/untrusted.js';
import { bus } from '../events.js';

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
  const who = { agent: await resolveAgentId(process.env, root), sessionSlug: resolveSessionSlug() };
  const now = new Date().toISOString();

  const out = await mutateTasks(root, (tasks) => {
    const o = pause(tasks, target, who, now, opts.reason);
    return { tasks: o.ok ? o.tasks : null, result: o };
  });

  report(out, (t) => {
    // Inside `report`, so it fires only on the success branch — a refusal
    // changed nothing and must not look like a hand-back on the dashboard.
    // Only the reason typed just now: `pause` keeps an older `stoppedReason`,
    // and re-broadcasting it would attribute another session's words to this
    // stop (same reason the echo below is hedged).
    bus.publish({ type: 'task.paused', slug: t.slug, agent: who.agent, ...(opts.reason ? { reason: opts.reason } : {}) });
    console.log(`✓ ${t.slug} handed back — queued, not done.`);
    console.log(`  The worktree and branch are untouched: ${t.worktreePath}`);
    // Usually the reason this caller just typed — but not always. `pause` keeps
    // an existing `stoppedReason` when none is given, and only checks the AGENT
    // id, not the session, so `baton pause <slug>` on a task another session
    // blocked echoes THAT session's text. Quoted for the same reason the rest
    // of this bug's sites are: it is a terminal, this line sits between two
    // lines Baton wrote, and a break would forge a third.
    if (t.stoppedReason) console.log(`  reason: ${quotedInline(t.stoppedReason)}`);
    console.log(`  Anyone can continue it with: baton take ${t.slug}`);
  });
}

export async function blockCmd(slug: string | undefined, reason: string): Promise<void> {
  const root = await activeBatonRoot();
  // One argument is the reason — but one that names a task is far likelier a
  // slug whose reason was forgotten than a reason that happens to be a slug.
  if (!slug && (await getTask(root, reason))) {
    console.error(`✗ '${reason}' is a task, not a reason. Did you mean: baton block ${reason} "<why>"`);
    process.exitCode = 1;
    return;
  }
  const target = await resolveSlug(root, slug);
  if (!target) {
    console.error(slug ? `No task '${slug}'. See: baton ls` : 'Not inside a task worktree — pass a slug: baton block <slug> "<why>"');
    process.exitCode = 1;
    return;
  }
  const who = { agent: await resolveAgentId(process.env, root), sessionSlug: resolveSessionSlug() };

  const out = await mutateTasks(root, (tasks) => {
    const o = block(tasks, target, who, reason, new Date().toISOString());
    return { tasks: o.ok ? o.tasks : null, result: o };
  });

  report(out, (t) => {
    // `block` refuses an empty reason, so the stored one is always the one this
    // caller just gave — no hedging needed here, unlike `pause` above.
    bus.publish({ type: 'task.blocked', slug: t.slug, agent: who.agent, reason: t.stoppedReason ?? reason });
    // Owned, not returned to the pool: the next agent would hit the same wall.
    console.log(`⊘ ${t.slug} blocked — still yours, waiting on a person.`);
    // The most forgeable of the terminal sites: the reason gets a LINE OF ITS
    // OWN at the same indent as the sentence under it, so a raw break puts
    // attacker text at column 2 directly above `It shows on \`baton ls\`…` and
    // it reads as another line of Baton's. One line, capped.
    console.log(`  ${quotedInline(t.stoppedReason)}`);
    console.log('  It shows on `baton ls` and `baton next` until someone resolves it.');
  });
}
