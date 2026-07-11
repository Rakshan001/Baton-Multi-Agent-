/**
 * `baton memory` — inspect/curate the shared project memory from the terminal.
 * Facts are written by agents via the `save_memory` MCP tool (or the
 * dashboard); this command is the human curation surface.
 */
import { gitRoot } from '../git.js';
import {
  gcMemories, listMemories, readJournal, removeMemory, repairMemories, saveMemory,
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
  console.log(`${FRESHNESS_LABEL[f.freshness]} [${f.type}] ${f.id}${age}${stale}`);
  console.log(`    ${f.fact.replace(/\n/g, '\n    ')}`);
  const attribution = [f.agent && `by ${f.agent}`, f.task && `task ${f.task}`, f.anchors.files.length && `anchors: ${f.anchors.files.map((a) => a.path).join(', ')}`]
    .filter(Boolean).join(' · ');
  if (attribution) console.log(`    ${attribution}`);
}

export async function memoryListCmd(): Promise<void> {
  const root = await gitRoot(); // memory.ts resolves the main repo root internally
  const facts = await listMemories(root);
  if (!facts.length) {
    console.log('no memories yet — agents save them with the `save_memory` MCP tool');
    return;
  }
  const stale = facts.filter((f) => f.freshness === 'stale').length;
  for (const f of facts) printFact(f);
  console.log(`\n${facts.length} fact${facts.length === 1 ? '' : 's'}${stale ? ` · ${stale} stale (run: baton memory gc)` : ''}`);
}

export async function memoryAddCmd(fact: string, opts: { type?: string; files?: string; task?: string }): Promise<void> {
  const root = await gitRoot(); // memory.ts resolves the main repo root internally
  try {
    const saved = await saveMemory(root, {
      fact,
      type: opts.type,
      files: opts.files?.split(',').map((f) => f.trim()).filter(Boolean),
      agent: 'cli',
      task: opts.task,
    });
    console.log(`✓ saved ${saved.id}${saved.supersedes ? ` (supersedes ${saved.supersedes})` : ''}`);
  } catch (e) {
    if (e instanceof MemoryValidationError) {
      console.error(`✗ ${e.message}`);
      process.exitCode = 1;
      return;
    }
    throw e;
  }
}

export async function memoryRmCmd(id: string): Promise<void> {
  const root = await gitRoot(); // memory.ts resolves the main repo root internally
  const ok = await removeMemory(root, id);
  console.log(ok ? `✓ removed ${id}` : `no memory '${id}'`);
  if (!ok) process.exitCode = 1;
}

export async function memoryRepairCmd(): Promise<void> {
  const root = await gitRoot(); // memory.ts resolves the main repo root internally
  const r = await repairMemories(root);
  if (r.reanchored.length) console.log(`⚓ re-anchored ${r.reanchored.length} fact${r.reanchored.length === 1 ? '' : 's'} (still true, evidence refreshed): ${r.reanchored.join(', ')}`);
  if (r.needsReview.length) {
    console.log(`○ ${r.needsReview.length} need${r.needsReview.length === 1 ? 's' : ''} review (verify, then re-save or \`baton memory rm\`):`);
    for (const id of r.needsReview) console.log(`    ${id}`);
  }
  if (!r.reanchored.length && !r.needsReview.length) console.log('nothing stale — memory is healthy');
}

export async function memoryGcCmd(): Promise<void> {
  const root = await gitRoot(); // memory.ts resolves the main repo root internally
  // Rescue what is mechanically verifiable BEFORE dropping anything (M3) —
  // gc used to be the knowledge-loss path for facts that were still true.
  const repaired = await repairMemories(root);
  if (repaired.reanchored.length) console.log(`⚓ re-anchored ${repaired.reanchored.length} still-true fact${repaired.reanchored.length === 1 ? '' : 's'} instead of dropping`);
  const removed = await gcMemories(root);
  console.log(removed.length ? `✓ removed ${removed.length} stale fact${removed.length === 1 ? '' : 's'}: ${removed.join(', ')}` : 'nothing stale to remove');
}

const OP_LABEL: Record<'supersede' | 'remove' | 'reanchor', string> = { supersede: '↻', remove: '✗', reanchor: '⚓' };

export async function memoryLogCmd(): Promise<void> {
  const root = await gitRoot(); // memory.ts resolves the main repo root internally
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
