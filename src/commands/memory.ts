/**
 * `baton memory` — inspect/curate the shared project memory from the terminal.
 * Facts are written by agents via the `save_memory` MCP tool (or the
 * dashboard); this command is the human curation surface.
 */
import { gitRoot } from '../git.js';
import {
  gcMemories, listMemories, mainRepoRoot, removeMemory, saveMemory,
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
  const root = await mainRepoRoot(await gitRoot());
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
  const root = await mainRepoRoot(await gitRoot());
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
  const root = await mainRepoRoot(await gitRoot());
  const ok = await removeMemory(root, id);
  console.log(ok ? `✓ removed ${id}` : `no memory '${id}'`);
  if (!ok) process.exitCode = 1;
}

export async function memoryGcCmd(): Promise<void> {
  const root = await mainRepoRoot(await gitRoot());
  const removed = await gcMemories(root);
  console.log(removed.length ? `✓ removed ${removed.length} stale fact${removed.length === 1 ? '' : 's'}: ${removed.join(', ')}` : 'nothing stale to remove');
}
