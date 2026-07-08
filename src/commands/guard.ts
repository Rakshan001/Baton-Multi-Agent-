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
import { checkFiles, recordHookEdit, sessionSlug, type FileCheck } from '../signals.js';

/** Everything the guard must finish within — past this we fail open silently. */
const GUARD_BUDGET_MS = 1500;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export interface GuardPayload {
  tool_name?: string;
  tool_input?: { file_path?: string };
  cwd?: string;
  /** The host agent's session id (Claude Code includes it in every hook payload). */
  session_id?: string;
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
    .map((h) => {
      const who = `${h.slug}${h.agent ? ` (${h.agent})` : ''}`;
      const when = h.lastEditAt ? `, last edit ${age(h.lastEditAt)}` : ', unmerged branch changes';
      const doing = h.note ? ` — "${h.note}"` : '';
      return `${who}${when}${doing}`;
    })
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

/**
 * Who is this session (G2)? A worktree session IS its task; a session at the
 * repo root has no task, so it is identified by the agent's own session id and
 * registers its agent + checkout root for attribution/reconciliation. The
 * guard hook is installed by `baton hooks install claude`, hence agent: claude.
 */
export function selfIdentity(
  payload: GuardPayload,
  worktreeRoot: string,
  envSlug?: string,
): { slug: string | undefined; session?: { agent: string; sessionRoot: string } } {
  const taskSlug = envSlug?.trim() || slugFromWorktreePath(worktreeRoot);
  if (taskSlug) return { slug: taskSlug };
  if (payload.session_id) {
    return { slug: sessionSlug(payload.session_id), session: { agent: 'claude', sessionRoot: worktreeRoot } };
  }
  return { slug: undefined };
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
  const self = selfIdentity(payload, worktreeRoot, process.env.BATON_SLUG);
  // G2: the guard WRITES the signal too — the daemon-less path that makes
  // sessions at the repo root (and worktree sessions with no daemon) visible
  // to each other. Never let recording break the advisory.
  if (self.slug) {
    try {
      recordHookEdit(root, { slug: self.slug, path: rel, session: self.session });
    } catch { /* advisory still runs */ }
  }
  const check = (await checkFiles(root, [rel], self.slug))[rel];
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
