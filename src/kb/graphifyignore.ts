/**
 * `.graphifyignore` seeding for the knowledge base.
 *
 * graphify reads, per directory, `.graphifyignore` OR ELSE that dir's
 * `.gitignore` — never both. So the moment Baton writes a `.graphifyignore`
 * (to keep its own generated CODEBASE.md/AGENTS.md/kb/ out of the graph), it
 * stops graphify from honouring that dir's `.gitignore`. graphify's built-in
 * skip list still drops node_modules/dist/.venv/coverage/etc., but a repo's
 * *custom* root ignores (out-tsc/, logs/, secrets/, generated/) would slip in.
 *
 * Fix: when creating the file, mirror the repo's `.gitignore` in first, then
 * append our managed block. `kb init`/`rebuild` seed this at EVERY scanned
 * project (not just the hub root), and an existing *bare* managed file (the
 * pre-mirror format) is upgraded in place. A user-customised file is left alone.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const GRAPHIFY_IGNORE_MARKER = '# baton: generated knowledge-base files (do not index)';
export const GRAPHIFY_IGNORE_ENTRIES = ['CODEBASE.md', 'AGENTS.md', 'kb/'];
const MIRROR_HEADER = '# mirrored from .gitignore so graphify keeps honouring it';

const managedBlock = () => `${GRAPHIFY_IGNORE_MARKER}\n${GRAPHIFY_IGNORE_ENTRIES.join('\n')}`;

/** The full correct contents: optional gitignore mirror + the managed block. */
function renderManaged(gitignore: string | null): string {
  const g = (gitignore ?? '').replace(/\r\n/g, '\n').trimEnd();
  const mirror = g ? `${MIRROR_HEADER}\n${g}\n\n` : '';
  return `${mirror}${managedBlock()}\n`;
}

/** The legacy bare managed file: just our block, no gitignore mirror. */
function isBareManaged(existing: string): boolean {
  return existing.trim() === managedBlock();
}

/**
 * Decide what (if anything) to write to `.graphifyignore`. Pure + unit-tested.
 * Returns the new contents, or null when the file is already fine / user-owned.
 */
export function composeGraphifyIgnore(existing: string, gitignore: string | null): string | null {
  const desired = renderManaged(gitignore);
  if (!existing.trim()) return desired;                              // fresh create
  if (existing.trim() === desired.trim()) return null;              // already correct
  if (isBareManaged(existing) && (gitignore ?? '').trim()) return desired; // upgrade stale bare → mirrored
  if (existing.includes(GRAPHIFY_IGNORE_MARKER)) return null;       // managed + user extras (or already mirrored) → leave
  // A user-authored .graphifyignore without our block: append the block, but
  // don't mirror .gitignore (they've chosen to own the ignore policy).
  return `${existing.trimEnd()}\n\n${managedBlock()}\n`;
}

/** Ensure `<dir>/.graphifyignore` is present and mirrors `<dir>/.gitignore`. Returns true if it wrote. */
export async function ensureGraphifyIgnore(dir: string): Promise<boolean> {
  const file = join(dir, '.graphifyignore');
  const existing = existsSync(file) ? await readFile(file, 'utf-8') : '';
  let gitignore: string | null = null;
  const gi = join(dir, '.gitignore');
  if (existsSync(gi)) {
    try { gitignore = await readFile(gi, 'utf-8'); } catch { gitignore = null; }
  }
  const next = composeGraphifyIgnore(existing, gitignore);
  if (next === null) return false;
  await writeFile(file, next, 'utf-8');
  return true;
}

/** Seed/upgrade `.graphifyignore` across many project dirs (deduped). Returns dirs written. */
export async function ensureGraphifyIgnores(dirs: string[]): Promise<string[]> {
  const wrote: string[] = [];
  for (const dir of [...new Set(dirs)]) {
    try {
      if (await ensureGraphifyIgnore(dir)) wrote.push(dir);
    } catch { /* best-effort — never block a build on ignore seeding */ }
  }
  return wrote;
}
