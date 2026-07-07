/**
 * `baton guard` — the PreToolUse edit-guard for Claude Code hooks. Reads the
 * hook payload on stdin; if the file the agent is about to Edit/Write is under
 * live edit by ANOTHER session (or diverges on an unmerged branch), it injects
 * an advisory note into the agent's context via hookSpecificOutput.
 *
 * Advise-only by design: agents work in isolated worktrees, so a collision is
 * a future merge conflict, not a live clobber — we inform, never block.
 * Fail-open: any error, missing store, or slow check exits 0 with no output so
 * editing is never stalled by coordination plumbing.
 */
import { relative, isAbsolute, dirname, basename, join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { gitRoot } from '../git.js';
import { resolveMcpRoot } from '../store.js';
import { checkFiles, type FileCheck } from '../signals.js';

/** Everything the guard must finish within — past this we fail open silently. */
const GUARD_BUDGET_MS = 1500;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export interface GuardPayload {
  tool_name?: string;
  tool_input?: { file_path?: string };
  cwd?: string;
}

/** The worktree-relative path an edit targets, or null if this call is not our business. */
export function guardTarget(payload: GuardPayload, worktreeRoot: string): string | null {
  if (!payload.tool_name || !EDIT_TOOLS.has(payload.tool_name)) return null;
  const file = payload.tool_input?.file_path;
  if (!file || !isAbsolute(file)) return null;
  const rel = relative(worktreeRoot, file);
  if (!rel || rel.startsWith('..')) return null; // outside this worktree
  return rel;
}

const age = (iso: string): string => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 90 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
};

/** The advisory note for a busy file — null when free (zero happy-path tokens). */
export function formatGuardMessage(path: string, check: FileCheck): string | null {
  if (!check.busy || check.by.length === 0) return null;
  const holders = check.by
    .map((h) => `${h.slug}${h.agent ? ` (${h.agent})` : ''}${h.lastEditAt ? `, last edit ${age(h.lastEditAt)}` : ', unmerged branch changes'}`)
    .join('; ');
  return (
    `⚠ baton: ${path} is also being worked on by ${holders}. ` +
    `Their changes will land in a merge — consider check_files/get_report before overlapping, or pick other work and re-check.`
  );
}

/** Self-identity fallback: derive the task slug from a `.baton/wt/<slug>` path. */
export function slugFromWorktreePath(p: string): string | undefined {
  return /\.baton\/wt\/([^/]+)/.exec(p)?.[1] ?? undefined;
}

async function readStdin(): Promise<string> {
  let data = '';
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

/**
 * Canonicalize the edit target so it compares against git's canonical worktree
 * root (macOS /var→/private/var, any symlinked checkout). The file itself may
 * not exist yet (Write creates it) — canonicalize its parent instead.
 */
async function canonicalTarget(payload: GuardPayload): Promise<GuardPayload> {
  const file = payload.tool_input?.file_path;
  if (!file || !isAbsolute(file)) return payload;
  try {
    const dir = await realpath(dirname(file));
    return { ...payload, tool_input: { ...payload.tool_input, file_path: join(dir, basename(file)) } };
  } catch {
    return payload; // parent missing too — leave as-is, guardTarget will bail
  }
}

async function runGuard(): Promise<string | null> {
  const payload = JSON.parse(await readStdin()) as GuardPayload;
  const cwd = payload.cwd ?? process.cwd();
  const worktreeRoot = await gitRoot(cwd);
  const rel = guardTarget(await canonicalTarget(payload), worktreeRoot);
  if (!rel) return null;
  const root = await resolveMcpRoot(cwd);
  const selfSlug = process.env.BATON_SLUG?.trim() || slugFromWorktreePath(worktreeRoot);
  const check = (await checkFiles(root, [rel], selfSlug))[rel];
  return check ? formatGuardMessage(rel, check) : null;
}

export async function guardCmd(): Promise<void> {
  const timeout = new Promise<null>((res) => setTimeout(res, GUARD_BUDGET_MS, null).unref?.());
  let message: string | null = null;
  try {
    message = await Promise.race([runGuard(), timeout]);
  } catch {
    /* fail open — a broken guard must never stall an edit */
  }
  if (message) {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: message } }));
  }
  process.exitCode = 0;
}
