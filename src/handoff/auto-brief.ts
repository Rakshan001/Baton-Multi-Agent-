// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The automatic stall brief — the plan's `wt-stall-brief`.
 *
 * Baton already had every part of a handoff: `buildBrief` (`brief.ts:193`), the
 * contributor chain, `save_progress`, and `takeover` (`lifecycle.ts:149`). What
 * it did not have was the brief EXISTING at the moment it becomes needed. A
 * half-finished worktree could only be handed on by someone first noticing it
 * had stopped, then running `baton pass` — so the artifact appeared exactly
 * when somebody was already paying attention, which is the one case it is not
 * needed. This module composes it on the transition instead, so the dashboard's
 * handoff inbox has something to click before anyone goes looking.
 *
 * Three rules hold the whole thing up:
 *
 * 1. **One brief format.** `buildBrief` is called wholesale; the stall-specific
 *    facts ride in as `opts.stall` and are rendered by `brief.ts:stallSectionMd`.
 *    A second brief shape here would be the drift this repo has already paid
 *    for once, and the receiving agent cannot tell which builder wrote the file
 *    it is reading.
 *
 * 2. **One definition of health.** `stalled` comes from `deriveHealth`
 *    (`worktrees.ts:171`) on rows the caller already collected. Nothing here
 *    re-derives it, and nothing here decides what "stalled" means — it consumes
 *    the word.
 *
 * 3. **`quiet` composes nothing.** `quiet` is the 10-minute period before the
 *    45-minute grace (`worktrees.ts:44`); it exists precisely so that a worktree
 *    merely between commits is visible without anything shouting. A brief for
 *    that is noise, and noise is how a signal gets ignored. Only `stalled`
 *    composes — see `enteredStall`.
 *
 * Cost: composing runs one `git log -1` plus `getSignals` for the slug. That is
 * affordable because it happens on the EDGE (once per stall), never per tick
 * while a worktree sits stalled — the same discipline `poller.ts:snapshotAtRisk`
 * keeps for WIP refs.
 *
 * Side effects: this WRITES `HANDOFF.md` into the worktree. Like the poller's
 * ref writes it therefore belongs on a tick path in a write-enabled daemon, and
 * must never be reachable from a GET handler.
 */
import { bus } from '../events.js';
import { getProgress, getSignals } from '../signals.js';
import { loadTasks, type Task } from '../store.js';
import { gitTry } from '../util/exec.js';
import type { WorktreeHealth, WorktreeRow } from '../worktrees.js';
import { buildBrief, readBrief, writeBrief, type StallContext } from './brief.js';

/**
 * How far back to look for the `report_progress` line.
 *
 * `getProgress`'s 30-minute default is tuned for "who is working on what right
 * now", and a stalled worktree is silent for at least `STALL_GRACE_MS` (45m) by
 * definition — so the default window would drop the note in every single case
 * this module cares about. The STALE note is the valuable one here: it is what
 * the agent said it was doing just before it stopped. It is rendered with its
 * timestamp so nobody mistakes it for current.
 */
const PROGRESS_LOOKBACK_MIN = 7 * 24 * 60;

/** A brief lists the paths still held; past a handful it is a wall, not a hint. */
const CLAIMED_FILES_CAP = 20;

export type StallBriefReason =
  /** A brief was written. */
  | 'composed'
  /** Still stalled since the last look — the level, not the edge. */
  | 'no-transition'
  /** A brief is already sitting there unresolved. */
  | 'brief-open'
  /** The row names a slug no task owns (an orphan worktree on disk). */
  | 'no-task'
  /** Something threw. Best-effort by design: the next transition retries. */
  | 'failed';

export interface StallBriefResult {
  slug: string;
  composed: boolean;
  reason: StallBriefReason;
  /** Where the brief was written, when one was. */
  path?: string;
}

/**
 * The edge into `stalled`, and only into `stalled`.
 *
 * `quiet` is deliberately not a trigger (see rule 3 above), and neither is
 * `abandoned`: that rung of the ladder means the worktree is holding work
 * nobody is running (`worktrees.ts:186`), which is a data-loss problem that
 * `wip-snapshot.ts` already answers by saving the diff to a ref. A brief is for
 * work somebody can CONTINUE.
 *
 * A first sighting (`before === undefined`) counts as a transition, unlike
 * `poller.ts`'s baseline rule. The poller is diffing a stream it owns end to
 * end; this runs against a daemon that may have started long after the agent
 * died, and refusing to look at what is already stalled would mean the worst
 * case — the one that has been sitting there for hours — is the one case that
 * never gets a brief. Composing twice is prevented by the brief on disk, not by
 * the in-memory edge.
 */
export function enteredStall(before: WorktreeHealth | null | undefined, after: WorktreeHealth): boolean {
  return after === 'stalled' && before !== 'stalled';
}

/**
 * Everything the stall section states, gathered best-effort.
 *
 * Every lookup here can fail independently (git gone, sqlite locked, signals
 * unreadable) and each one degrades to "say nothing about it". A brief that is
 * missing the claimed-files list is still worth having; a brief that failed to
 * be written because a progress query threw is worth nothing.
 */
export async function stallContextFor(root: string, task: Task, row: WorktreeRow): Promise<StallContext> {
  // `%cr` (relative) rather than an ISO stamp: the reader's question is "how old
  // is the newest thing here", and a date makes them do the subtraction.
  const last = await gitTry(['-C', task.worktreePath, 'log', '-1', '--format=%h %s (%cr)']);

  let progressNote: StallContext['progressNote'];
  try {
    const p = getProgress(root, PROGRESS_LOOKBACK_MIN).get(task.slug);
    if (p?.note) progressNote = { note: p.note, at: p.at };
  } catch { /* no signals db yet — the brief simply says nothing about it */ }

  let claimedFiles: string[] = [];
  try {
    const signals = await getSignals(root);
    claimedFiles = signals
      // `state: 'active'` only: a settled holder has committed the path, so
      // listing it would tell the next agent to take over work that already
      // landed (the same ISS-15 distinction `SignalOpts.includeSettled` draws).
      .filter((s) => s.holders.some((h) => h.slug === task.slug && h.state === 'active'))
      .map((s) => s.path)
      .slice(0, CLAIMED_FILES_CAP);
  } catch { /* signals are an enhancement — never block a brief */ }

  return {
    health: row.health,
    quietForMs: row.quietForMs,
    // The RECORD's holder, not `row.agent`: by the time this runs the process is
    // usually gone, and the name of whoever left the work is the fact that makes
    // the brief attributable.
    claimedBy: task.claimedBy?.agent ?? row.claimedBy,
    lastCommit: last.ok && last.stdout.trim() ? last.stdout.trim().split('\n')[0]! : null,
    ...(task.stoppedReason ? { blockReason: task.stoppedReason } : {}),
    ...(progressNote ? { progressNote } : {}),
    claimedFiles,
  };
}

/**
 * Compose and write the brief for one stalled worktree, unless one is already
 * open there.
 *
 * The open-brief check reads the artifact rather than a flag in memory, so it
 * survives a daemon restart and covers the case the plan calls out: a worktree
 * that wakes up, goes silent again, and would otherwise get a second brief
 * stacked on the first one nobody has read yet. `status: 'done'` is the only
 * state that frees the slot, which is exactly what `baton resume` and
 * `GET /api/handoffs` already treat as closed (`resume.ts:closeBriefBySlug`).
 *
 * A HANDOFF.md that is not a Baton brief also blocks: overwriting a file a
 * human wrote in a worktree they were handing over by hand would be the worst
 * possible way for this feature to introduce itself.
 */
export async function composeStallBrief(root: string, row: WorktreeRow, tasks?: Task[]): Promise<StallBriefResult> {
  try {
    const task = (tasks ?? await loadTasks(root)).find((t) => t.slug === row.slug);
    if (!task?.worktreePath) return { slug: row.slug, composed: false, reason: 'no-task' };

    const existing = await readBrief(task.worktreePath);
    if (existing && existing.meta.status !== 'done') {
      return { slug: row.slug, composed: false, reason: 'brief-open' };
    }

    const brief = await buildBrief(task, {
      from: task.claimedBy?.agent ?? row.claimedBy ?? 'unknown',
      // No named recipient: nobody chose one, and inventing a target would
      // misreport a brief that exists so whoever is free can pick it up.
      // `listBriefs` renders an absent `to` as `any` already.
      to: 'any',
      root,
      stall: await stallContextFor(root, task, row),
    });
    await writeBrief(brief);
    // The bus type the manual handoff path already publishes — a new event for
    // "same artifact, composed by the daemon" would make every client subscribe
    // twice to learn one thing (CLAUDE.md: new types go to `events.ts` first,
    // and this one does not need to be new).
    bus.publish({ type: 'handoff.created', slug: row.slug, toAgent: 'any' });
    return { slug: row.slug, composed: true, reason: 'composed', path: brief.path };
  } catch {
    // Best-effort like the rest of the tick path: the next transition retries,
    // and a failed compose must never take down the caller.
    return { slug: row.slug, composed: false, reason: 'failed' };
  }
}

/**
 * Edge detector over successive `collectWorktrees` results.
 *
 * Holds one `slug → health` map, exactly the shape `poller.ts` uses for its WIP
 * signatures, so a worktree that sits stalled for six hours costs nothing after
 * the first look.
 *
 * NOT wired to a caller by this task — `src/server.ts` and `src/poller.ts` were
 * both owned by other work in flight. The trigger belongs on the poller's tick
 * (it already gates expensive stall work behind `STALL_SCAN_MS`, and it is the
 * one place in the daemon allowed to have side effects), which needs a single
 * line: `void stallBriefComposer(root).onWorktrees(rows)` with rows from
 * `collectWorktrees`.
 */
export class StallBriefComposer {
  private root: string;
  /** slug → the health last seen. Absent = never seen; see `enteredStall`. */
  private seen = new Map<string, WorktreeHealth>();
  /** Never stack composes behind a slow one, same guard as `poller.wipBusy`. */
  private busy = false;

  constructor(root: string) {
    this.root = root;
  }

  /**
   * Feed one poll's worth of rows. Returns a result per row that is stalled —
   * and nothing at all for any other health, `quiet` included, so a caller
   * cannot accidentally act on one.
   */
  async onWorktrees(rows: readonly WorktreeRow[]): Promise<StallBriefResult[]> {
    if (this.busy) return [];
    this.busy = true;
    try {
      const candidates = rows.filter((r) => r.health === 'stalled');
      const out: StallBriefResult[] = [];
      // Loaded once for the whole batch rather than per row: a plan stalling as
      // a group is the normal case, not the exception.
      const tasks = candidates.length ? await loadTasks(this.root).catch(() => [] as Task[]) : [];
      for (const row of candidates) {
        if (!enteredStall(this.seen.get(row.slug), row.health)) {
          out.push({ slug: row.slug, composed: false, reason: 'no-transition' });
          continue;
        }
        out.push(await composeStallBrief(this.root, row, tasks));
      }
      // Recorded AFTER composing, and for every row — a worktree that recovers
      // to `working` must be able to arm the edge again.
      for (const r of rows) this.seen.set(r.slug, r.health);
      // Forget slugs that are gone, so a long-lived daemon does not accumulate
      // a row per worktree ever created.
      const live = new Set(rows.map((r) => r.slug));
      for (const slug of [...this.seen.keys()]) if (!live.has(slug)) this.seen.delete(slug);
      return out;
    } finally {
      this.busy = false;
    }
  }
}

/**
 * One composer per root, so a caller on a 2s tick does not have to own the
 * state (and two callers cannot each keep half of it).
 */
const composers = new Map<string, StallBriefComposer>();
export function stallBriefComposer(root: string): StallBriefComposer {
  let c = composers.get(root);
  if (!c) composers.set(root, (c = new StallBriefComposer(root)));
  return c;
}
