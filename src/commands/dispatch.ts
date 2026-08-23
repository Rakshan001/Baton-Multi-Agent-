// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `baton plan approve <plan>` — read what would run, then vouch for it.
 * `baton dispatch [plan]`      — claim, brief and launch an approved plan.
 *
 * Explicit command only. There is no daemon loop watching for approved plans: a
 * machine that starts paid agents on its own schedule is one you have to
 * supervise, and the whole point of the approval gate is that a human was there.
 * That is a deferred decision, not an oversight.
 *
 * The resolution itself lives in `executors/dispatch-resolve.ts` because the
 * daemon serves the same answer to a phone (P10). This file is the printing.
 */
import { activeBatonRoot, loadTasks, mutateTasks } from '../store.js';
import { resolveAuthor } from '../identity.js';
import { requireOperator } from '../operator.js';
import { authorWarning, loadTrust, recordApproval, trustVerdict } from '../plan-trust.js';
import { relayFor } from '../dispatch.js';
import { runDispatch, exitOutcome, type DispatchReport } from '../dispatch-run.js';
import {
  dispatchDeps, resolvePlanDispatch, DispatchUnresolvable, type ResolvedDispatch,
} from '../executors/dispatch-resolve.js';
import { readRun, recordRun } from '../executors/runs.js';
import { stopAgent, waitForAgent } from '../spawn.js';
import { block } from '../lifecycle.js';
import { stateOf } from '../pipeline.js';
import { gitTry } from '../util/exec.js';
import { bus } from '../events.js';

export interface DispatchOpts {
  dryRun?: boolean;
  max?: string;
  agent?: string;
  backend?: string;
  yes?: boolean;
  /** P16 step 3: let a task whose gateway is down move onto a paid model.
   *  Off by default, and every promotion is named in the report. */
  allowPaidFallback?: boolean;
}

/** Resolve, printing every refusal the CLI way. `null` means it already said so. */
async function resolved(root: string, file: string, opts: DispatchOpts): Promise<ResolvedDispatch | null> {
  try {
    const r = await resolvePlanDispatch(root, file, opts);
    for (const w of r.warnings) console.error(`  ! ${w}`);
    return r;
  } catch (e) {
    if (!(e instanceof DispatchUnresolvable)) throw e;
    console.error(`✗ ${e.message}${e.detail.length ? ':\n' : ''}`);
    for (const line of e.detail) console.error(`  ${line}`);
    process.exitCode = 1;
    return null;
  }
}

function printDecision(r: ResolvedDispatch): void {
  const { launches, refusals } = r.decision;
  console.log(`${r.plan.id} — ${launches.length} to start, ${refusals.length} not starting`);
  for (const l of launches) {
    const cap = r.caps.get(l.agentId);
    const via = l.source === 'flag' ? '--agent' : l.source === 'plan' ? 'plan' : 'routing';
    const skipped = l.skipped?.length ? ` (skipped ${l.skipped.join(', ')})` : '';
    console.log(`  ▶ ${l.slug} → ${l.agentId}${l.model ? ` (model: ${l.model})` : ''} · ${l.mode} · via ${via}${skipped}`);
    // P16-E7. Consent is not silence: a promotion someone allowed still gets
    // named, with what it moved from and why.
    if (l.promoted) console.log(`      ⚠ paid fallback: ${l.promoted.from} → ${l.promoted.to} — ${l.promoted.reason}`);
    console.log(`      runs: ${cap?.nativeId ?? l.agentId}${l.skills.length ? ` · skills: ${l.skills.join(', ')}` : ''}`);
  }
  const relay = relayFor(refusals);
  const relayed = new Set(relay.map((r) => r.slug));
  for (const x of refusals) {
    // A relayed task is printed once, below, as something to do — not twice,
    // once as a failure and once as an instruction.
    if (!relayed.has(x.slug)) console.log(`  · ${x.slug} — ${x.reason}`);
  }
  printRelay(relay, r.plan.id);
}

/**
 * The tasks Baton cannot start, written as something for a person to do.
 *
 * `@antigravity` refusing is the feature — Baton has no spawn args for it and
 * refuses to guess rather than quietly run Claude instead. But that refusal is
 * a fact about Baton, not an instruction, and the work is entirely doable by
 * hand: the plan already says which agent, and `baton take` builds the worktree
 * and prints the objective, scope and acceptance criteria.
 */
function printRelay(relay: ReturnType<typeof relayFor>, planId: string): void {
  if (!relay.length) return;
  const n = relay.length;
  console.log(`\n  ⇢ ${n} task${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you to start the agent — Baton has no launcher for ${n === 1 ? 'it' : 'them'}:\n`);
  for (const r of relay) {
    console.log(`    ${r.slug} → ${r.agentId}`);
    console.log(`      why:  ${r.why}`);
    console.log(`      open: ${r.where}`);
    console.log(`      run:  ${r.command}`);
    console.log('');
  }
  console.log(`    Run it in the agent, not in your own shell — \`baton take\` claims as`);
  console.log(`    whoever runs it, and from your shell the claim is refused as "assigned`);
  console.log(`    to ${relay[0]!.agentId}". Re-run \`baton dispatch ${planId}\` afterwards for the rest.`);
}

export async function planApproveCmd(file: string, opts: DispatchOpts = {}): Promise<void> {
  const root = await activeBatonRoot();
  if (!(await requireOperator(root, 'baton plan approve'))) return;
  const r = await resolved(root, file, opts);
  if (!r) return;

  printDecision(r);

  // P3-E2 — advisory. A plan a teammate wrote is normal; a plan a teammate
  // wrote that you are about to run unattended is worth one line.
  const author = await resolveAuthor(root);
  // %an%n%ae: both identities, because `resolveAuthor` may hold either one.
  const last = await gitTry(['-C', root, 'log', '-1', '--format=%an%n%ae', '--', r.path]);
  const [name, email] = last.ok ? last.stdout.trim().split('\n') : [];
  const warn = authorWarning({ name: name ?? null, email: email ?? null }, author);
  if (warn) console.log(`\n  ! ${warn}`);

  await recordApproval(root, {
    planId: r.plan.id, sha256: r.digest, approvedBy: author, at: new Date().toISOString(),
  });
  console.log(`\n✓ approved ${r.plan.id} (${r.digest.slice(0, 12)}…) — run \`baton dispatch ${file}\``);
}

function printReport(report: DispatchReport, planId: string): void {
  if (report.dryRun) {
    console.log(`\n(dry run — nothing was claimed, written or started)`);
    return;
  }
  for (const s of report.started) {
    console.log(`  ▶ ${s.slug} → ${s.agentId}${s.model ? ` (model: ${s.model})` : ''} · pid ${s.pid ?? '?'}`);
    for (const n of s.notes) console.log(`      ! ${n}`);
  }
  for (const f of report.failed) console.error(`  ✗ ${f.slug} — ${f.reason}`);
  console.log(`\n${report.started.length} started, ${report.failed.length} failed · \`baton status\` to watch ${planId}`);
  if (report.failed.length) process.exitCode = 1;
}

export async function dispatchCmd(file: string, opts: DispatchOpts = {}): Promise<void> {
  const root = await activeBatonRoot();
  if (!(await requireOperator(root, 'baton dispatch'))) return;
  const r = await resolved(root, file, opts);
  if (!r) return;

  const verdict = trustVerdict((await loadTrust(root))[r.plan.id] ?? null, r.digest);
  if (!verdict.ok) {
    if (!opts.yes) {
      console.error(`✗ ${r.plan.id}: ${verdict.reason}`);
      console.error('  `baton plan approve` prints exactly what would run, then records that you read it.');
      process.exitCode = 1;
      return;
    }
    // --yes is the non-interactive escape hatch, and it says so out loud: the
    // approval is still a human's, it just arrived as a flag instead of a
    // second command.
    const author = await resolveAuthor(root);
    await recordApproval(root, { planId: r.plan.id, sha256: r.digest, approvedBy: author, at: new Date().toISOString() });
    console.log(`! --yes: approving ${r.plan.id} (${r.digest.slice(0, 12)}…) as ${author} without a separate read.`);
  }

  printDecision(r);
  if (!r.decision.launches.length) return;

  const report = await runDispatch(root, r.decision.launches, dispatchDeps(root, r.executor), { dryRun: opts.dryRun });
  printReport(report, r.plan.id);
  if (report.dryRun || !report.started.length) return;

  if (r.backend === 'orca') {
    // Orca owns these processes and they outlive this command, so there is
    // nothing here to supervise and nothing Ctrl+C could stop. Saying otherwise
    // would be the more comfortable message and the false one.
    console.log(`\n${report.started.length} agent(s) are running in Orca — watch them there. \`baton status\` tracks the tasks.`);
    return;
  }
  await superviseUntilDone(root, report);
}

/**
 * Stay with the agents until they are done.
 *
 * Not a daemon loop — nothing here looks for new work. It is the same contract
 * `baton start` has, and it is not optional: `spawn.ts` arms a `process.once
 * ('exit')` that SIGKILLs every headless run, so a dispatcher that printed its
 * report and returned would kill every agent it had just started, having
 * already written their claims and briefs. It would look like it worked.
 *
 * Ctrl-C stops them all, and each stop is recorded, because a claimed task with
 * no process is the state this whole phase is built to avoid.
 */
async function superviseUntilDone(root: string, report: DispatchReport): Promise<void> {
  const slugs = report.started.map((s) => s.slug);
  const unsub = bus.onType('agent.output', (e) => {
    if (e.event.type !== 'agent.output' || !slugs.includes(e.event.slug)) return;
    const out = e.event.stream === 'err' ? process.stderr : process.stdout;
    out.write(`[${e.event.slug}] ${e.event.line}\n`);
  });
  console.log(`\nwatching ${slugs.length} agent(s) — Ctrl+C stops them\n`);
  process.on('SIGINT', () => { for (const s of slugs) stopAgent(s); });

  try {
    const exits = await Promise.all(slugs.map(async (slug) => ({ slug, exit: await waitForAgent(slug) })));
    for (const { slug, exit } of exits) {
      if (!exit) continue;                       // never ran under this process
      // Stamp the ledger before anything else. Without it the record outlives
      // the process and `inFlight` keeps counting it: after a reboot the pid
      // can belong to something else entirely, and the phantom run holds a
      // concurrency slot against every future dispatch. `endedAt` is the field
      // runs.ts documents as outranking a recycled pid.
      const run = await readRun(root, slug);
      if (run) await recordRun(root, { ...run, endedAt: new Date().toISOString() });

      const task = (await loadTasks(root)).find((t) => t.slug === slug);
      if (!task) continue;
      const verdict = exitOutcome(slug, stateOf(task), exit);
      if (!verdict.block) continue;
      const agent = task.claimedBy?.agent ?? '';
      const outcome = await mutateTasks(root, (tasks) => {
        const o = block(tasks, slug, { agent, sessionSlug: slug }, verdict.reason, new Date().toISOString());
        return { tasks: o.ok ? o.tasks : null, result: o };
      });
      console.error(outcome.ok
        ? `  ⊘ ${slug} — ${verdict.reason}`
        : `  ⊘ ${slug} — ${verdict.reason} (could not record it: ${outcome.refusal.message})`);
    }
  } finally {
    unsub();
  }
}
