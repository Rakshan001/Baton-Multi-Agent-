// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `baton memory` — inspect/curate the shared project memory from the terminal.
 * Facts are written by agents via the `save_memory` MCP tool (or the
 * dashboard); this command is the human curation surface.
 */
import { activeBatonRoot } from '../store.js';
import { askYesNo } from './setup-prompts.js';
import { consolidateOnce } from '../daemons.js';
import {
  gcMemories, listMemories, migrateMemory, readJournal, removeMemory, repairMemories, saveMemory,
  MemoryValidationError, type MemoryStatus,
} from '../memory.js';

const FRESHNESS_LABEL: Record<MemoryStatus['freshness'], string> = {
  fresh: '●',
  aging: '◐',
  stale: '○',
};

function printFact(f: MemoryStatus): void {
  const age = f.commitsBehind ? ` · ${f.commitsBehind} commits old` : '';
  const stale = f.staleReason ? ` · STALE: ${f.staleReason}` : '';
  // Local-only is marked, tracked is not. The default should be silent and the
  // exception visible — a badge on every line teaches nothing.
  const where = f.area === 'local' ? ' · local-only' : '';
  console.log(`${FRESHNESS_LABEL[f.freshness]} [${f.type}] ${f.id}${age}${stale}${where}`);
  console.log(`    ${f.fact.replace(/\n/g, '\n    ')}`);
  const attribution = [f.agent && `by ${f.agent}`, f.task && `task ${f.task}`, f.anchors.files.length && `anchors: ${f.anchors.files.map((a) => a.path).join(', ')}`]
    .filter(Boolean).join(' · ');
  if (attribution) console.log(`    ${attribution}`);
}

export async function memoryListCmd(): Promise<void> {
  const root = await activeBatonRoot();
  const facts = await listMemories(root);
  if (!facts.length) {
    console.log('no memories yet — agents save them with the `save_memory` MCP tool');
    return;
  }
  const stale = facts.filter((f) => f.freshness === 'stale').length;
  for (const f of facts) printFact(f);
  console.log(`\n${facts.length} fact${facts.length === 1 ? '' : 's'}${stale ? ` · ${stale} stale (run: baton memory gc)` : ''}`);
}

export async function memoryAddCmd(fact: string, opts: { type?: string; files?: string; task?: string; localOnly?: boolean }): Promise<void> {
  const root = await activeBatonRoot();
  try {
    const saved = await saveMemory(root, {
      fact,
      type: opts.type,
      files: opts.files?.split(',').map((f) => f.trim()).filter(Boolean),
      agent: 'cli',
      task: opts.task,
      localOnly: opts.localOnly,
    });
    console.log(`✓ saved ${saved.id}${saved.supersedes ? ` (supersedes ${saved.supersedes})` : ''}`);
    console.log(saved.area === 'local'
      ? '  local-only — stays out of git, so it reaches nobody else'
      : '  in baton/memory/facts — commit it to share it');
  } catch (e) {
    if (e instanceof MemoryValidationError) {
      console.error(`✗ ${e.message}`);
      process.exitCode = 1;
      return;
    }
    throw e;
  }
}

/**
 * `baton memory migrate [--dry-run]` — move facts into git (§12).
 *
 * Explicit on purpose. Reads already merge both areas, so nothing here is
 * urgent and nothing is lost by never running it; what this decides is whether
 * the facts travel to other clones. Moving files into git's view changes what a
 * following `git commit -a` publishes, which is a choice to make deliberately.
 */
export async function memoryMigrateCmd(opts: { dryRun?: boolean } = {}): Promise<void> {
  const root = await activeBatonRoot();
  const r = await migrateMemory(root, { dryRun: opts.dryRun });

  if (!r.moved.length && !r.kept.length) {
    console.log('Nothing to migrate — no facts in the local-only area.');
    return;
  }

  if (r.moved.length) {
    console.log(`${r.dryRun ? 'Would move' : 'Moved'} ${r.moved.length} fact${r.moved.length === 1 ? '' : 's'} → baton/memory/facts`);
    for (const m of r.moved) console.log(`  · ${m.id}`);
  }
  if (r.kept.length) {
    // Named individually, never just counted. "2 kept local" reads as a
    // rounding note; the reason is the whole content of the message, and one of
    // them means a credential is sitting in the store.
    console.log(`\n${r.kept.length} staying local:`);
    for (const k of r.kept) console.log(`  · ${k.id} — ${k.keptLocal}`);
  }
  console.log(r.dryRun
    ? '\n(dry run — nothing moved)'
    : '\nThey are in the working tree now, not in history. Commit them to share them.');
}

export async function memoryRmCmd(id: string): Promise<void> {
  const root = await activeBatonRoot();
  const ok = await removeMemory(root, id);
  console.log(ok ? `✓ removed ${id}` : `no memory '${id}'`);
  if (!ok) process.exitCode = 1;
}

export async function memoryRepairCmd(): Promise<void> {
  const root = await activeBatonRoot();
  const r = await repairMemories(root);
  if (r.reanchored.length) console.log(`⚓ re-anchored ${r.reanchored.length} fact${r.reanchored.length === 1 ? '' : 's'} (still true, evidence refreshed): ${r.reanchored.join(', ')}`);
  if (r.needsReview.length) {
    console.log(`○ ${r.needsReview.length} need${r.needsReview.length === 1 ? 's' : ''} review (verify, then re-save or \`baton memory rm\`):`);
    for (const id of r.needsReview) console.log(`    ${id}`);
  }
  if (!r.reanchored.length && !r.needsReview.length) console.log('nothing stale — memory is healthy');
}

/**
 * The manual half of the background pass. The daemon runs exactly this when
 * the machine is idle; someone who never leaves `baton serve` running gets the
 * same feature by typing it, rather than silently getting a lesser product.
 *
 * The idle gate is deliberately NOT applied here: a person asking for the pass
 * has already decided it is a good moment, and refusing because an agent is
 * mid-task would make the manual equivalent useless on exactly the machines
 * that need it.
 */
export async function memoryConsolidateCmd(): Promise<void> {
  const root = await activeBatonRoot();
  const r = await consolidateOnce(root, { isBusy: () => false, log: (m) => console.error(m) });
  if (r.status === 'failed') {
    process.exitCode = 1;
    return;
  }
  if (r.status === 'unchanged') {
    console.log('nothing new since the last pass — memory is already consolidated');
    return;
  }
  if (r.superseded.length) {
    console.log(`↻ superseded ${r.superseded.length} duplicate fact${r.superseded.length === 1 ? '' : 's'} (archived, not deleted): ${r.superseded.join(', ')}`);
  }
  for (const c of r.contradictions) {
    // Reported, never resolved — picking a winner mechanically is how a store
    // starts asserting things nobody wrote.
    console.log(`⚠ contradiction for a human: ${c.ids.join(' vs ')} — ${c.reason}`);
  }
  if (!r.superseded.length && !r.contradictions.length) console.log('nothing to consolidate — no duplicates or contradictions');
}

/**
 * `baton memory gc [--dry-run] [--yes]` — the only command that destroys
 * knowledge, so it is the one that shows its work first.
 *
 * The order is repair → preview → ask → remove. Repair runs even under
 * `--dry-run`: it is the rescue, not the deletion, and a preview computed
 * without it would name facts real gc would never touch — a preview that
 * over-reports is a preview nobody can act on.
 *
 * Everything still listed after the repair is, by definition, what gc cannot
 * mechanically justify keeping. That is precisely what the plan says a person
 * must sign off on, so the confirmation covers all of it.
 */
export async function memoryGcCmd(opts: { dryRun?: boolean; yes?: boolean } = {}): Promise<void> {
  const root = await activeBatonRoot();
  // Rescue what is mechanically verifiable BEFORE dropping anything (M3) —
  // gc used to be the knowledge-loss path for facts that were still true.
  const repaired = await repairMemories(root);
  if (repaired.reanchored.length) console.log(`⚓ re-anchored ${repaired.reanchored.length} still-true fact${repaired.reanchored.length === 1 ? '' : 's'} instead of dropping`);

  const doomed = await gcMemories(root, { dryRun: true });
  if (!doomed.length) {
    console.log('nothing stale to remove');
    return;
  }
  const plural = doomed.length === 1 ? '' : 's';
  console.log(`${doomed.length} stale fact${plural} would be removed (archived under .baton/memory/archive, not destroyed):`);
  for (const id of doomed) console.log(`  · ${id}`);

  if (opts.dryRun) {
    console.log('\n(dry run — nothing removed)');
    return;
  }

  if (!opts.yes) {
    // A pipe or a CI job cannot answer, and askYesNo would take the safe
    // default silently — which reads as "it worked" to a script. Say so.
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error(`✗ not a terminal, so nothing was removed — re-run with --yes if you meant it (or --dry-run to look first)`);
      process.exitCode = 1;
      return;
    }
    console.log('  Recover one afterwards with `baton memory log` + the archive.');
    if (!(await askYesNo(`\n  Remove ${doomed.length} stale fact${plural}?`, false))) {
      console.log('  Nothing removed.');
      return;
    }
  }

  const removed = await gcMemories(root);
  console.log(removed.length ? `✓ removed ${removed.length} stale fact${removed.length === 1 ? '' : 's'}: ${removed.join(', ')}` : 'nothing stale to remove');
}

const OP_LABEL: Record<'supersede' | 'remove' | 'reanchor', string> = { supersede: '↻', remove: '✗', reanchor: '⚓' };

export async function memoryLogCmd(): Promise<void> {
  const root = await activeBatonRoot();
  const journal = await readJournal(root);
  if (!journal.length) {
    console.log('no memory history yet — supersessions and removals are logged here');
    return;
  }
  for (const e of journal) {
    const when = e.at.replace('T', ' ').replace(/\..*/, '');
    const to = e.supersededBy ? ` → ${e.supersededBy}` : '';
    console.log(`${OP_LABEL[e.op]} ${when}  ${e.id}${to}  (${e.reason})`);
  }
  console.log(`\n${journal.length} entr${journal.length === 1 ? 'y' : 'ies'} · archived facts kept under .baton/memory/archive/`);
}
