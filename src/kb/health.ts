/**
 * Knowledge-base health checks for `baton doctor`.
 *
 * loadKb() already drops a project whose path is bogus, and warns once — but a
 * warning on a 2s poll path is not a diagnosis. The result was a KB that had
 * been pointing at a directory with no graph in it for weeks while doctor said
 * "✓ no junk found". These checks give doctor something to actually report.
 *
 * Read-only by design, like `doctor --docs`: rebuilding a KB is a human call.
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { sep } from 'node:path';
import { kbFile, type KbProject, type KbState } from './state.js';

export type KbHealthLevel = 'error' | 'warn' | 'info';

export interface KbFinding {
  level: KbHealthLevel;
  /** what is wrong, in one line */
  message: string;
  /** the command that fixes it, when there is one */
  fix?: string;
}

/** A KB not rebuilt in this long is reported as stale — long enough not to nag. */
export const KB_STALE_DAYS = 30;

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Is `p` the root itself or below it, comparing resolved paths? */
async function isInside(root: string, p: string): Promise<boolean> {
  try {
    const [r, q] = await Promise.all([realpath(root), realpath(p)]);
    return q === r || q.startsWith(r + sep);
  } catch {
    return false;
  }
}

async function auditProject(root: string, p: KbProject, out: KbFinding[]): Promise<void> {
  if (!(await isDir(p.path))) {
    out.push({
      level: 'error',
      message: `project '${p.id}' points at ${p.path}, which is not a directory`,
      fix: 'baton kb init',
    });
    return;
  }
  // Checked separately from existence: a path that resolves outside the root is
  // a different repo, which is the failure that actually happened here.
  if (!(await isInside(root, p.path))) {
    out.push({
      level: 'error',
      message: `project '${p.id}' points outside this repo (${p.path}) — its graph is never loaded`,
      fix: 'baton kb init',
    });
    return;
  }
  if (!(await exists(p.graphPath))) {
    out.push({
      level: 'error',
      message: `project '${p.id}' has no graph on disk (${p.graphPath})`,
      fix: 'baton kb rebuild',
    });
  }
}

/**
 * Audit the KB for this root. Returns [] when everything checks out; a missing
 * kb.json is reported as info, not a failure — the KB is optional.
 */
export async function auditKb(root: string, now = new Date()): Promise<KbFinding[]> {
  const file = kbFile(root);
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch {
    return [{ level: 'info', message: 'no knowledge base in this repo', fix: 'baton kb init' }];
  }

  let state: KbState;
  try {
    state = JSON.parse(raw) as KbState;
  } catch {
    return [{ level: 'error', message: `${file} is unreadable — agents get no code graph at all`, fix: 'baton kb init' }];
  }

  const out: KbFinding[] = [];
  if (state.root && !(await isInside(root, state.root))) {
    out.push({
      level: 'error',
      message: `kb.json was built for a different repo (${state.root}) — every graph query here resolves against it`,
      fix: 'baton kb init',
    });
  }

  const projects = Array.isArray(state.projects) ? state.projects : [];
  for (const p of projects) await auditProject(root, p, out);

  if (!projects.length) {
    out.push({ level: 'error', message: 'kb.json lists no projects — graph tools return nothing', fix: 'baton kb init' });
  }

  if (state.mergedGraphPath && !(await exists(state.mergedGraphPath))) {
    out.push({ level: 'error', message: `the merged graph is missing (${state.mergedGraphPath})`, fix: 'baton kb rebuild' });
  }

  // Staleness is a warning, never an error: an old graph is still usable, it
  // just may not know about recent code.
  if (state.lastBuiltAt) {
    const built = new Date(state.lastBuiltAt);
    const days = Math.floor((now.getTime() - built.getTime()) / 86_400_000);
    if (Number.isFinite(days) && days >= KB_STALE_DAYS) {
      out.push({ level: 'warn', message: `the graph was last built ${days} days ago`, fix: 'baton kb rebuild' });
    }
  } else if (!out.length) {
    out.push({ level: 'warn', message: 'the graph has never been built', fix: 'baton kb rebuild' });
  }

  return out;
}
