// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
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
// `.baton/*` + a negation, NOT `.baton/`: git never descends into an ignored
// DIRECTORY, so `!.baton/agents.json` would be dead under `.baton/` — and that
// file is the one .baton artifact meant to be committed (the per-project agent
// registry the docs tell teams to share).
// `**/` rather than a bare `.baton/*`: a pattern containing a slash is anchored
// to the repo root, so in a monorepo whose sub-projects each got a `.baton/`
// under one git root, only the top one was ignored.
// All three project-scoped MCP configs, not just Claude's: `setup` writes
// whichever ones the chosen agents need, and `baton kb mcp --agent cursor`
// prints a snippet carrying `/mcp/g/<token>/` for the user to paste into
// `.cursor/mcp.json`. Ignoring one of the three for that reason is half a rule.
const BASE_ENTRIES = [
  '**/.baton/*',
  '!**/.baton/agents.json',
  'graphify-out/',
  '.graphifyignore',
  '.mcp.json',
  '**/.cursor/mcp.json',
  '**/.agents/mcp_config.json',
];

/** Directories whose whole contents are Baton's, keyed for `git rm -r --cached`. */
const FOOTPRINT_DIRS = ['.baton', 'graphify-out'];
/** Individual files Baton writes into a directory the user also owns. */
const FOOTPRINT_FILES = ['.graphifyignore', '.mcp.json', '.cursor/mcp.json', '.agents/mcp_config.json'];

/**
 * Which of these already-tracked paths the managed block now claims.
 *
 * Adding a line to `.gitignore` does nothing to a file git is already tracking,
 * so a repo set up before this block existed keeps committing `.baton/kb.json`
 * forever while setup cheerfully prints `✓ .gitignore updated`. Pure: git does
 * the ignore-matching upstream (`ls-files -ci`), this only picks out the paths
 * that are ours, so a file the user chose to track-and-ignore is left out of it.
 */
export function batonFootprint(trackedIgnored: string[]): string[] {
  return trackedIgnored.filter((raw) => {
    const p = raw.trim().replace(/^\.\//, '');
    if (!p) return false;
    // The one .baton file meant to be committed — never suggest untracking it.
    if (p === '.baton/agents.json' || p.endsWith('/.baton/agents.json')) return false;
    if (FOOTPRINT_DIRS.some((d) => p.startsWith(`${d}/`) || p.includes(`/${d}/`))) return true;
    return FOOTPRINT_FILES.some((f) => p === f || p.endsWith(`/${f}`));
  });
}

/**
 * The one-line `git rm` the user can run, naming each directory once.
 *
 * Collapsing `.baton/kb.json` and `.baton/tasks.json` down to `.baton` is what
 * keeps the command readable in a repo with a dozen tracked skill files — and
 * it is also what would untrack `.baton/agents.json`, the one file in there
 * teams are told to commit. Git's exclude pathspec buys back that single file
 * without giving up the collapse.
 */
export function untrackCommand(paths: string[]): string {
  const targets = new Set<string>();
  for (const p of paths) {
    const dir = FOOTPRINT_DIRS.find((d) => p.startsWith(`${d}/`) || p.includes(`/${d}/`));
    targets.add(dir ? p.slice(0, p.indexOf(dir) + dir.length) : p);
  }
  const spared = [...targets]
    .filter((t) => t === '.baton' || t.endsWith('/.baton'))
    .map((t) => `':(exclude)${t}/agents.json'`);
  return `git rm -r --cached ${[...targets].sort().join(' ')}${spared.length ? ` ${spared.sort().join(' ')}` : ''}`;
}

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
