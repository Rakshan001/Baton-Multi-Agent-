// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `baton plan check <file>`  — parse and validate, write nothing.
 * `baton plan apply <file>`  — turn a plan into queued tasks.
 *
 * Apply always shows the diff before it writes, and refuses outright when the
 * change would land under a working agent. `--dry-run` is the same code path
 * with the write suppressed, so what you are shown is what would happen — not a
 * second implementation that can drift from the first.
 */
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { activeBatonRoot, batonDir, mutateTasks } from '../store.js';
import { loadPlan, PlanError } from '../plan.js';
import { applyPlan, renderDiff } from '../plan-apply.js';
import { resolveAuthor } from '../identity.js';
import { requireOperator } from '../operator.js';

/** Where tracked plans live. Inside git on purpose: a plan is a shared
 *  statement of intent, and in team mode it is how a teammate's plan arrives. */
export const PLANS_DIR = 'baton/plans';

async function readPlanFile(root: string, file: string): Promise<{ text: string; path: string }> {
  // Bare name → look under the tracked plans directory, so `baton plan apply
  // auth` works from anywhere in the repo.
  const candidates = file.includes('/') || file.endsWith('.md')
    ? [resolve(process.cwd(), file), join(root, file)]
    : [join(root, PLANS_DIR, `${file}.md`), resolve(process.cwd(), file)];
  for (const path of candidates) {
    try {
      return { text: await readFile(path, 'utf-8'), path };
    } catch { /* try the next spelling */ }
  }
  throw new Error(`No plan file at ${candidates.join(' or ')}`);
}

function reportPlanError(e: unknown, path: string): void {
  if (!(e instanceof PlanError)) throw e;
  console.error(`✗ ${path} — ${e.issues.length} problem${e.issues.length === 1 ? '' : 's'}:\n`);
  for (const i of e.issues) console.error(`  ${i.where}: ${i.message}`);
  console.error('\nNothing was applied. A plan is all-or-nothing: a half-applied one gates phases on tasks nobody meant to create.');
  process.exitCode = 1;
}

export async function planCheckCmd(file: string): Promise<void> {
  const root = await activeBatonRoot();
  const { text, path } = await readPlanFile(root, file);
  try {
    const plan = loadPlan(text, basename(path, '.md'));
    const phases = [...new Set(plan.tasks.map((t) => t.phase))].sort((a, b) => a - b);
    console.log(`✓ ${plan.id} — ${plan.tasks.length} task${plan.tasks.length === 1 ? '' : 's'} across ${phases.length} phase${phases.length === 1 ? '' : 's'}`);
    for (const p of phases) {
      const inPhase = plan.tasks.filter((t) => t.phase === p);
      console.log(`  phase ${p}: ${inPhase.map((t) => t.slug + (t.assignee ? `@${t.assignee}` : '')).join(', ')}`);
    }
  } catch (e) {
    reportPlanError(e, path);
  }
}

export async function planApplyCmd(
  file: string,
  opts: { dryRun?: boolean; force?: boolean } = {},
): Promise<void> {
  const root = await activeBatonRoot();
  // §7.6: the plan belongs to the hub. Checked before the file is even read, so
  // a member gets the rule rather than a parse error about someone else's plan.
  if (!(await requireOperator(root, 'baton plan apply'))) return;
  const { text, path } = await readPlanFile(root, file);
  let plan;
  try {
    plan = loadPlan(text, basename(path, '.md'));
  } catch (e) {
    reportPlanError(e, path);
    return;
  }

  const actor = await resolveAuthor(root);
  const outcome = await mutateTasks(root, (tasks) => {
    // Decided against the list we are about to overwrite, never a stale read.
    const r = applyPlan(tasks, plan, {
      wtRoot: join(batonDir(root), 'wt'),
      now: new Date().toISOString(),
      actor,
      force: opts.force,
    });
    const write = !opts.dryRun && r.dirty && (r.blocking.length === 0 || opts.force) && !r.entries.some((e) => e.change === 'conflict');
    return { tasks: write ? r.tasks : null, result: { ...r, wrote: write } };
  });

  const changed = outcome.entries.filter((e) => e.change !== 'keep');
  console.log(`${plan.id} — ${path}`);
  if (!changed.length) {
    console.log('  already applied — no changes.');
    return;
  }
  for (const line of renderDiff(changed)) console.log(line);

  const conflicts = outcome.entries.filter((e) => e.change === 'conflict');
  if (conflicts.length) {
    // Not forceable: both rows would resolve to the same `baton/<slug>` branch.
    console.error(`\n✗ ${conflicts.length} slug${conflicts.length === 1 ? '' : 's'} already taken — rename in the plan, or remove the existing task. Nothing was applied.`);
    process.exitCode = 1;
    return;
  }
  if (outcome.blocking.length && !opts.force) {
    console.error(`\n✗ ${outcome.blocking.length} in-flight task${outcome.blocking.length === 1 ? '' : 's'} affected. Nothing was applied — re-run with --force to proceed anyway.`);
    process.exitCode = 1;
    return;
  }
  if (opts.dryRun) {
    console.log('\n(dry run — nothing written)');
    return;
  }
  const made = changed.filter((e) => e.change === 'new').length;
  console.log(`\n✓ applied${made ? ` — ${made} task${made === 1 ? '' : 's'} queued` : ''}. Next: baton ls`);
}
