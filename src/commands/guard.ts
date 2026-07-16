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
import { spawn } from 'node:child_process';
import { relative, isAbsolute, dirname, basename, join } from 'node:path';
import { realpath, stat, mkdir, writeFile } from 'node:fs/promises';
import { gitRoot } from '../git.js';
import { resolveMcpRoot, batonDir } from '../store.js';
import { checkFiles, recordHookEdit, sessionSlug, type FileCheck } from '../signals.js';
import { snapshotDue } from './snapshot.js';
import { guardrailReminderDue, formatGuardrailReminder } from '../handoff/guardrails.js';

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

/** The union of hook dialects the guard accepts on stdin. */
interface RawHookPayload extends GuardPayload {
  /** Cursor afterFileEdit fields. */
  conversation_id?: string;
  file_path?: string;
  workspace_roots?: string[];
}

/**
 * One guard for every hook dialect (M2): Cursor's `afterFileEdit` sends
 * `{conversation_id, file_path, workspace_roots}` instead of Claude's
 * `{tool_name, tool_input, cwd, session_id}` — map it onto the guard shape.
 * Anything already in guard shape passes through untouched.
 */
export function normalizeGuardPayload(raw: RawHookPayload): GuardPayload {
  if (raw.file_path && !raw.tool_name) {
    return {
      tool_name: 'Edit',
      tool_input: { file_path: raw.file_path },
      cwd: raw.workspace_roots?.[0] ?? raw.cwd,
      session_id: raw.conversation_id ?? raw.session_id,
    };
  }
  return raw;
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
  agent = 'claude',
): { slug: string | undefined; session?: { agent: string; sessionRoot: string } } {
  const taskSlug = envSlug?.trim() || slugFromWorktreePath(worktreeRoot);
  if (taskSlug) return { slug: taskSlug };
  if (payload.session_id) {
    return { slug: sessionSlug(payload.session_id), session: { agent, sessionRoot: worktreeRoot } };
  }
  return { slug: undefined };
}

/**
 * ISS-07 — mid-session guardrail re-injection. Prohibition-type instructions
 * decay across a long session, so the guard re-surfaces the (positive-phrased)
 * rules on a debounce keyed to the task, not on every edit. Returns the reminder
 * when due (and stamps the marker), else null. Best-effort: any FS error yields
 * no reminder rather than blocking the edit.
 */
function guardrailMarker(root: string, slug: string): string {
  return join(batonDir(root), 'guardrail', slug.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80) || 'session');
}

export async function maybeGuardrailReminder(root: string, slug: string, now: number = Date.now()): Promise<string | null> {
  const marker = guardrailMarker(root, slug);
  let lastMs: number | null = null;
  try {
    lastMs = (await stat(marker)).mtimeMs;
  } catch { /* never sent — treat as due */ }
  if (!guardrailReminderDue(lastMs, now)) return null;
  try {
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, '', 'utf-8');
  } catch { return null; /* can't debounce reliably → stay quiet rather than spam */ }
  return formatGuardrailReminder(`\`baton done ${slug}\``);
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

async function runGuard(agent: string): Promise<string | null> {
  const payload = normalizeGuardPayload(JSON.parse(await readStdin()) as GuardPayload);
  const cwd = payload.cwd ?? process.cwd();
  const worktreeRoot = await gitRoot(cwd);
  const rel = guardTarget(await canonicalTarget(payload), worktreeRoot);
  if (!rel) return null;
  const root = await resolveMcpRoot(cwd);
  const self = selfIdentity(payload, worktreeRoot, process.env.BATON_SLUG, agent);
  // G2: the guard WRITES the signal too — the daemon-less path that makes
  // sessions at the repo root (and worktree sessions with no daemon) visible
  // to each other. Never let recording break the advisory.
  if (self.slug) {
    try {
      recordHookEdit(root, { slug: self.slug, path: rel, session: self.session });
    } catch { /* advisory still runs */ }
    // ISS-03: keep a resumable HANDOFF.md fresh DURING the session. Only for a
    // real task worktree (self.session is set only for a synthetic root
    // session, which has no task to snapshot). Fire-and-forget, gated by the
    // cheap mtime debounce so the guard never blocks on a brief rebuild.
    if (!self.session) void maybeSnapshot(self.slug, worktreeRoot, root, agent);
  }
  const check = (await checkFiles(root, [rel], self.slug))[rel];
  const collision = check ? formatGuardMessage(rel, check) : null;
  // ISS-07: only a real task worktree session (self.session unset) has a task to
  // keep on-plan; re-inject its guardrails on the debounce, alongside any advisory.
  // Claude-only: guardCmd surfaces context only to Claude's hook protocol, and
  // Cursor already re-injects via its always-apply .mdc rule — so skip the marker
  // write for other agents rather than stamping a debounce nobody reads.
  const reminder = agent === 'claude' && self.slug && !self.session
    ? await maybeGuardrailReminder(root, self.slug).catch(() => null)
    : null;
  const combined = [collision, reminder].filter(Boolean).join('\n\n');
  return combined || null;
}

/**
 * Spawn a detached `baton snapshot` when one is due. The mtime gate means the
 * common case is a single stat() and no spawn; when a rebuild IS due we detach
 * it so the guard's 1500ms advisory budget is never spent on brief generation.
 */
async function maybeSnapshot(slug: string, worktreeRoot: string, root: string, agent: string): Promise<void> {
  try {
    if (!(await snapshotDue(worktreeRoot))) return;
    const cli = process.argv[1];
    if (!cli) return;
    const child = spawn(process.execPath, [cli, 'snapshot', slug, '--from', agent, '--quiet'], {
      cwd: worktreeRoot,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, BATON_ROOT: root },
    });
    child.on('error', () => { /* snapshot is best-effort — never affect the edit */ });
    child.unref();
  } catch { /* best-effort */ }
}

export async function guardCmd(opts: { agent?: string } = {}): Promise<void> {
  const agent = opts.agent ?? 'claude';
  const timeout = new Promise<null>((res) => setTimeout(res, GUARD_BUDGET_MS, null).unref?.());
  let message: string | null = null;
  try {
    message = await Promise.race([runGuard(agent), timeout]);
  } catch {
    /* fail open — a broken guard must never stall an edit */
  }
  // Only Claude's hook protocol understands hookSpecificOutput; for other
  // agents the guard is a silent signal writer (their post-edit hooks don't
  // document a context-injection reply — printing could confuse the host).
  if (message && agent === 'claude') {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: message } }));
  }
  process.exitCode = 0;
}
