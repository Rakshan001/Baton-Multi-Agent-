/**
 * `.gitignore` seeding for a single-repo `baton kb init`. The init writes
 * several artifacts (.baton/, graphify-out/, .graphifyignore, .mcp.json,
 * CODEBASE.md) that otherwise show up as untracked noise in `git status` — Baton
 * adding to the very sprawl it's meant to reduce. We add ONE marker-fenced
 * managed block, preserving the user's own ignores.
 *
 * Hub roots already ship a `/*` ignore-all .gitignore (ensureHubGitignore), so
 * this self-detects that and no-ops — safe to call unconditionally in kb init.
 *
 * Share mode keeps CODEBASE.md tracked (teammates get the token-cheap map); the
 * committed KB lives under kb/, which is never ignored.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const BATON_GITIGNORE_START = '# >>> baton (generated coordination + KB files — managed block, do not edit)';
const BATON_GITIGNORE_END = '# <<< baton';
const BASE_ENTRIES = ['.baton/', 'graphify-out/', '.graphifyignore', '.mcp.json'];

function managedBlock(share: boolean): string {
  const entries = share ? BASE_ENTRIES : [...BASE_ENTRIES, 'CODEBASE.md'];
  return [BATON_GITIGNORE_START, ...entries, BATON_GITIGNORE_END].join('\n');
}

/** True if a .gitignore already ignores everything (hub root) — nothing to add. */
function ignoresEverything(text: string): boolean {
  return text.split('\n').some((l) => l.trim() === '/*');
}

/**
 * The new `.gitignore` contents, or null when no change is needed. Pure +
 * unit-tested. Replaces an existing managed block (so a share-mode toggle
 * updates it) and appends after the user's own lines otherwise.
 */
export function composeBatonGitignore(existing: string, share: boolean): string | null {
  const text = (existing ?? '').replace(/\r\n/g, '\n');
  if (ignoresEverything(text)) return null;

  const desired = managedBlock(share);
  const start = text.indexOf(BATON_GITIGNORE_START);
  let base: string;
  if (start === -1) {
    base = text.trimEnd();
  } else {
    const end = text.indexOf(BATON_GITIGNORE_END, start);
    const tail = end === -1 ? '' : text.slice(end + BATON_GITIGNORE_END.length);
    base = (text.slice(0, start) + tail).replace(/\n{3,}/g, '\n\n').trim();
  }

  const next = base ? `${base}\n\n${desired}\n` : `${desired}\n`;
  const normalizedCurrent = text.trim() ? `${text.trimEnd()}\n` : '';
  return next === normalizedCurrent ? null : next;
}

/** Ensure `<root>/.gitignore` ignores the kb-init footprint. Returns true if it wrote. */
export async function ensureBatonGitignore(root: string, share: boolean): Promise<boolean> {
  const file = join(root, '.gitignore');
  const existing = existsSync(file) ? await readFile(file, 'utf-8') : '';
  const next = composeBatonGitignore(existing, share);
  if (next === null) return false;
  await writeFile(file, next, 'utf-8');
  return true;
}
