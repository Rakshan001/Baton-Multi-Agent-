/**
 * `baton memory` — inspect/curate the shared project memory from the terminal.
 * Facts are written by agents via the `save_memory` MCP tool (or the
 * dashboard); this command is the human curation surface.
 */
import { activeBatonRoot } from '../store.js';
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

export async function memoryGcCmd(): Promise<void> {
  const root = await activeBatonRoot();
  // Rescue what is mechanically verifiable BEFORE dropping anything (M3) —
  // gc used to be the knowledge-loss path for facts that were still true.
  const repaired = await repairMemories(root);
  if (repaired.reanchored.length) console.log(`⚓ re-anchored ${repaired.reanchored.length} still-true fact${repaired.reanchored.length === 1 ? '' : 's'} instead of dropping`);
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
