/**
 * `baton snapshot [slug]` — refresh a task worktree's HANDOFF.md from git +
 * transcript ground truth, WITHOUT committing and WITHOUT re-routing, so a
 * usable continuation brief always exists on disk *before* a hard cutoff
 * (ISS-03). Unlike `baton pass` (an explicit, routed, commit-checkpointing
 * handoff), a snapshot is a debounced background checkpoint: the edit-guard
 * fires it detached on every edit, but the mtime debounce means an actual
 * rebuild happens at most once per window.
 *
 * The key property for "another agent continues after a session limit": the
 * exact event you want to survive (rate-limit cutoff) never fires Claude's
 * Stop/PreCompact hook — so we capture DURING the session, not at its end. This
 * is the "durable notes beat live hooks" model (Anthropic's Claude-plays-Pokémon
 * agent resumes across hard resets purely from a persisted NOTES.md).
 *
 * Agent-agnostic: buildBrief derives state from `git diff` (works for Cursor,
 * Codex, hand-edits — anything), enriched by a Claude transcript when present.
 */
import { parseFrontmatter } from '../util/frontmatter.js';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { batonDir, resolveMcpRoot } from '../store.js';
import { gitTry } from '../util/exec.js';
import { buildBrief, handoffPath, readBrief, setBriefStatus, writeBrief, type HandoffBrief } from '../handoff/brief.js';
import { renderContinuationHead, renderCursorRule, CURSOR_RULE_REL } from '../handoff/continuation.js';
import { resolveTask } from './pass.js';

/** At most one rebuild per worktree per window — the guard calls this on every edit. */
export const SNAPSHOT_DEBOUNCE_MS = 5 * 60_000;

/**
 * How long a snapshot may hold its burst lock before another run treats the
 * holder as dead and breaks it. Generously above a real snapshot's cost (a few
 * git calls + buildBrief) so a slow-but-alive run is never stolen from, yet far
 * below SNAPSHOT_DEBOUNCE_MS so a crash can't suppress the next due checkpoint.
 */
export const SNAPSHOT_LOCK_STALE_MS = 60_000;

/**
 * Per-task burst lock. Lives beside `tasks.lock` in the owning `.baton/` rather
 * than in the worktree: a lock file inside the checkout would show up in the very
 * `git status` the brief reports on (and risk being committed).
 */
function snapshotLock(root: string, slug: string): string {
  return join(batonDir(root), `snapshot-${slug}.lock`);
}

/**
 * Try to become the one snapshot running for this task — never waits. The mtime
 * debounce alone can't collapse a burst: it reads HANDOFF.md's mtime, which only
 * moves AFTER buildBrief's git work finishes, so every snapshot fired inside that
 * window passes the gate and rebuilds the same brief (ISS-03 depth).
 *
 * Losing the race means a fresh brief is already being written, so the loser has
 * nothing to add and bails — hence try-lock, not the queueing `withTasksLock`.
 * `mkdir` is the atomic primitive (same as tasks.lock): exactly one winner.
 */
async function acquireSnapshotLock(root: string, slug: string): Promise<boolean> {
  const lock = snapshotLock(root, slug);
  await mkdir(dirname(lock), { recursive: true }).catch(() => undefined);
  try {
    await mkdir(lock);
    return true;
  } catch {
    // Held. Break it only if the holder looks dead, then retry once — a snapshot
    // that crashed mid-flight must not suppress checkpoints until the stale
    // window passes on every future burst.
    try {
      const st = await stat(lock);
      if (Date.now() - st.mtimeMs < SNAPSHOT_LOCK_STALE_MS) return false; // alive — let it work
      await rm(lock, { recursive: true, force: true });
      await mkdir(lock);
      return true;
    } catch {
      return false; // another run beat us to breaking/retaking it — it can do the work
    }
  }
}

async function releaseSnapshotLock(root: string, slug: string): Promise<void> {
  await rm(snapshotLock(root, slug), { recursive: true, force: true }).catch(() => undefined);
}

/** Is a fresh snapshot due? True when no brief exists or the last one is stale. */
export async function snapshotDue(worktreePath: string, debounceMs: number = SNAPSHOT_DEBOUNCE_MS): Promise<boolean> {
  try {
    const st = await stat(handoffPath(worktreePath));
    return Date.now() - st.mtimeMs >= debounceMs;
  } catch {
    return true; // no HANDOFF.md yet — always due
  }
}

export interface SnapshotOptions {
  root?: string;
  /** The agent currently working (recorded as the brief's `from`). */
  from?: string;
  /** Skip the debounce (a human ran `baton snapshot` explicitly). */
  force?: boolean;
}

/**
 * Write/refresh the task worktree's HANDOFF.md. Returns the brief, or null when
 * there is no task here, the debounce has not elapsed, or the brief is already
 * `done` (never clobber a completed handoff). Preserves an `in-progress` (taken)
 * brief's status and its routing target so a snapshot never silently "un-takes"
 * an active handoff.
 */
export async function snapshotTask(slug: string | undefined, opts: SnapshotOptions = {}): Promise<HandoffBrief | null> {
  // A worktree's own gitRoot is a shadow store; resolveMcpRoot honors BATON_ROOT
  // and escapes the worktree to the owning .baton (hub-safe), so getTask finds
  // the task whether we run at the repo root, in a linked worktree, or in a hub.
  const root = opts.root ?? (await resolveMcpRoot());
  const task = await resolveTask(root, slug);
  if (!task) return null;

  const existing = await readBrief(task.worktreePath);
  if (existing?.meta.status === 'done') return null; // a finished handoff is not ours to overwrite
  if (!opts.force && !(await snapshotDue(task.worktreePath))) return null;

  // Collapse an edit burst to one rebuild. A human running `baton snapshot
  // --force` proceeds regardless: they asked for a rebuild now, and writes are
  // last-writer-wins anyway — the lock exists to stop redundant background work,
  // not to police explicit intent.
  const locked = await acquireSnapshotLock(root, task.slug);
  if (!locked && !opts.force) return null; // another snapshot is already rebuilding this brief

  try {
    // Re-check under the lock: a burst's loser may have been waiting on the
    // filesystem while the winner wrote a brand-new brief, and rebuilding it
    // immediately would defeat the debounce we just passed.
    if (!opts.force && !(await snapshotDue(task.worktreePath))) return null;

    const brief = await buildBrief(task, {
      from: opts.from ?? existing?.meta.from ?? 'claude',
      to: existing?.meta.to ?? 'any',
      ...(existing?.meta.model ? { model: existing.meta.model } : {}),
      root,
    });
    await writeBrief(brief);

    // buildBrief stamps status 'ready'; keep a taken brief in-progress.
    if (existing?.meta.status === 'in-progress') {
      await setBriefStatus(task.worktreePath, 'in-progress');
      brief.meta.status = 'in-progress';
    }

    // Mirror the resume head into the Cursor auto-load channel so a manual Cursor
    // launch in this worktree also picks the task up (ISS-01, read side).
    await writeCursorRule(task.worktreePath, brief);
    return brief;
  } finally {
    if (locked) await releaseSnapshotLock(root, task.slug);
  }
}

/**
 * Write the continuation head to `.cursor/rules/baton-continuation.mdc` and keep
 * it out of git (so a later `baton pass` checkpoint commit never sweeps a Baton
 * artifact into the user's branch). Convenience only — a failure here never
 * fails the snapshot.
 */
async function writeCursorRule(worktreePath: string, brief: HandoffBrief): Promise<void> {
  try {
    const head = renderContinuationHead(brief.meta, parseFrontmatter(brief.markdown).content);
    const rule = renderCursorRule(head);
    if (!rule) return;
    const file = join(worktreePath, CURSOR_RULE_REL);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, rule, 'utf-8');
    await gitExcludeLocal(worktreePath, CURSOR_RULE_REL);
  } catch { /* the Cursor rule is a convenience — never block a snapshot for it */ }
}

/** Add a repo-root-anchored pattern to the checkout's local `.git/info/exclude` (idempotent). */
async function gitExcludeLocal(worktreePath: string, rel: string): Promise<void> {
  const common = await gitTry(['-C', worktreePath, 'rev-parse', '--git-common-dir']);
  if (!common.ok) return;
  const excludeFile = join(resolve(worktreePath, common.stdout.trim()), 'info', 'exclude');
  let current = '';
  try { current = await readFile(excludeFile, 'utf-8'); } catch { /* not created yet */ }
  const pattern = `/${rel}`;
  if (current.split('\n').some((l) => l.trim() === pattern || l.trim() === rel)) return;
  await mkdir(dirname(excludeFile), { recursive: true });
  await writeFile(excludeFile, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${pattern}\n`, 'utf-8');
}

export async function snapshotCmd(slug: string | undefined, opts: { force?: boolean; from?: string; quiet?: boolean } = {}): Promise<void> {
  try {
    const brief = await snapshotTask(slug, { force: opts.force, from: opts.from });
    if (!brief) {
      if (!opts.quiet) console.log('No task worktree here to snapshot (or a fresh brief already exists). Use --force to rebuild.');
      return;
    }
    if (!opts.quiet) console.log(`✓ snapshot → ${brief.path} (status: ${brief.meta.status})`);
  } catch (e) {
    if (opts.quiet) return; // detached hook mode must never surface an error
    throw e;
  }
}
