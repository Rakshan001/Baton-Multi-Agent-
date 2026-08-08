// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `baton handoff export` / `baton handoff import` — move a half-finished task
 * to another machine, another device, or another person's agent.
 *
 * The gap this closes: `baton pass` writes a brief that explains the work, but
 * the work itself — the uncommitted diff — never leaves the worktree it was made
 * in. See src/handoff/bundle.ts for the design rules.
 */
import { resolve } from 'node:path';
import { gitRoot } from '../git.js';
import { getTask, loadTasks, type Task , activeBatonRoot } from '../store.js';
import {
  buildBundle, importBundle, readBundle, restoreContext, writeBundle, BundleError,
} from '../handoff/bundle.js';

/** The task named by `slug`, or the one whose worktree contains the cwd. */
async function resolveTask(root: string, slug?: string): Promise<Task | null> {
  if (slug) return (await getTask(root, slug)) ?? null;
  const here = resolve(process.cwd());
  const tasks = await loadTasks(root);
  return tasks.find((t) => here === resolve(t.worktreePath) || here.startsWith(`${resolve(t.worktreePath)}/`)) ?? null;
}

export interface HandoffExportOpts {
  out?: string;
  allowSecrets?: boolean;
}

export async function handoffExportCmd(slug: string | undefined, opts: HandoffExportOpts = {}): Promise<void> {
  const root = await activeBatonRoot();
  const task = await resolveTask(root, slug);
  if (!task) {
    console.error(slug ? `No task '${slug}'.` : 'Not inside a task worktree — pass a slug: baton handoff export <slug>');
    process.exitCode = 1;
    return;
  }

  const { bundle, skipped } = await buildBundle(root, task, { allowSecrets: opts.allowSecrets });
  const file = resolve(opts.out ?? `${task.slug}.bundle.json`);
  await writeBundle(file, bundle);

  const patchKb = Math.round(bundle.patch.length / 100) / 10;
  console.log(`✓ ${task.slug} → ${file}`);
  console.log(`    diff        ${bundle.patch ? `${patchKb} KB` : 'none (working tree clean)'}`);
  console.log(`    new files   ${bundle.untracked.length}`);
  console.log(`    brief       ${bundle.brief ? 'included' : 'none written'}`);
  console.log(`    ledger      ${bundle.progress ? `${bundle.progress.plan.length} plan item(s)` : 'none'}`);
  console.log(`    findings    ${bundle.findings.length} open`);
  console.log(`    memory      ${bundle.memory.length} fact(s)`);
  console.log(`    base commit ${bundle.head ? bundle.head.slice(0, 8) : 'none (unborn HEAD)'}`);

  // Never silent: a file left out of the bundle is work that will not arrive.
  for (const s of skipped) console.error(`  ! left out: ${s}`);

  console.log(`\n  On the other machine, in the matching checkout:\n      baton handoff import ${file}`);
}

export interface HandoffImportOpts {
  into?: string;
  force?: boolean;
  /** Apply the diff only; skip writing HANDOFF.md and the progress ledger. */
  context?: boolean;
}

export async function handoffImportCmd(file: string, opts: HandoffImportOpts = {}): Promise<void> {
  const bundle = await readBundle(file);
  const dir = resolve(opts.into ?? process.cwd());
  const root = await gitRoot(dir).catch(() => dir);

  console.log(`bundle: ${bundle.slug} — ${bundle.task}`);
  console.log(`  from ${bundle.author} on ${bundle.createdAt.slice(0, 16).replace('T', ' ')}`);
  console.log(`  branch ${bundle.branch} (base ${bundle.baseBranch})\n`);

  const result = await importBundle(dir, bundle, { force: opts.force });

  if (result.status === 'head-mismatch' || result.status === 'would-conflict') {
    console.error(`✗ ${result.detail}`);
    process.exitCode = 1;
    return;
  }

  console.log(`✓ ${result.detail}`);
  for (const f of result.filesWritten) console.log(`    ${f}`);

  if (opts.context !== false) {
    const written = await restoreContext(root, dir, bundle);
    for (const w of written) console.log(`    ${w}`);
  }

  if (bundle.findings.length) {
    console.log(`\n  ${bundle.findings.length} open review finding(s) came with this work:`);
    for (const f of bundle.findings.slice(0, 8)) {
      console.log(`    [${f.axis}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}`);
    }
  }

  /*
   * Memory is printed, never re-saved. Facts are anchored to the EXPORTER's
   * commit + file hashes; re-saving them here would mint facts anchored to a
   * history this clone may not share, bypassing the staleness check that is
   * supposed to decide whether they still hold.
   */
  if (bundle.memory.length) {
    console.log(`\n  ${bundle.memory.length} memory fact(s) carried for reference (not imported):`);
    for (const m of bundle.memory.slice(0, 5)) console.log(`    [${m.type}] ${m.fact.split('\n')[0].slice(0, 110)}`);
  }

  console.log(`\n  Continue with:  baton resume ${bundle.slug}`);
}

export { BundleError };
