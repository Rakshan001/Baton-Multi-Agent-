// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The worktree read-model — one row per worktree, for `GET /api/worktrees`.
 *
 * Nothing here is new knowledge. Four subsystems already know all of it and
 * none of them is joined to the others, so the one question an agent actually
 * asks — "what worktrees exist, who holds them, and is that holder still
 * alive?" — has no answer anywhere in the product:
 *
 *   git's own truth     `listWorktrees`   (git.ts:201 — called only from
 *                                          cleanup.ts and the CLI, never a route)
 *   the task record     `loadTasks`       (store.ts:22)
 *   the working tree    `collectStatus`   (board.ts:30 — the poller's rows)
 *   is anyone home      `livenessProbe`   (liveness.ts:69) + `isStalled` (pipeline.ts:229)
 *   junk on disk        `auditWorktrees`  (cleanup.ts:80, the pure half of auditJunk)
 *
 * Two rules the rest of the file is built around:
 *
 * `health` is DERIVED and never stored, exactly like `isStalled` and the
 * pipeline's locks. It is NOT a peer of `state`: `state` is the lifecycle value
 * the daemon owns (queued|claimed|active|…) and `health` is the evidence layer
 * underneath it. A task can be `active` and `abandoned` at the same time — that
 * pair is the entire point of the feature.
 *
 * And it FAILS CLOSED. A row whose git calls did not answer reports `unknown`,
 * never `working` and never `ok`. Guessing "fine" when we cannot see is worse
 * than having no health model at all, because the dashboard then launders dead
 * work into looking fresh — which is the reported bug.
 */
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { collectStatus, type StatusRow } from './board.js';
import { auditWorktrees } from './cleanup.js';
import { listWorktrees, type RepoState } from './git.js';
import { livenessProbe } from './liveness.js';
import { STALL_GRACE_MS, stateOf, type TaskState } from './pipeline.js';
import { isMaterialized, loadTasks, type Task } from './store.js';
import { gitTry } from './util/exec.js';

/**
 * The quiet *period*, before the stall *grace* — the two-number shape cron
 * monitoring settled on (Healthchecks' period-then-grace). A single 45-minute
 * binary is what trains people to ignore a signal; `quiet` is visible on the
 * card, notifies nobody, and offers no takeover. It is the state that buys zero
 * false alarms, because a human sees it before anything shouts.
 */
export const STALL_QUIET_MS = 10 * 60_000;

/**
 * `working|quiet|stalled|abandoned` is the liveness vocabulary; the rest are the
 * git-truth modifiers that outrank it (there is no useful "is it moving" answer
 * about a worktree that is mid-rebase or not on disk). `unknown` is the
 * fail-closed answer and is never omitted.
 */
export type WorktreeHealth =
  | 'working' | 'quiet' | 'stalled' | 'abandoned'
  | 'ok' | 'dirty' | 'conflict' | 'rebasing' | 'missing' | 'orphan-disk'
  | 'unknown';

/**
 * What you lose if this disk dies: uncommitted lines, plus commits that exist
 * only on this branch on this machine. `board.ts:56` already counts `ahead`
 * against the *local* base branch, which cannot tell "committed but nowhere
 * else on earth" from "safely on a remote" — so `commits` is counted against
 * the upstream when there is one, and is the full local lead when there is not.
 *
 * `commits: null` means the refs read failed. `atRisk` then stays true: not
 * knowing is not the same as being safe.
 */
export interface Unprotected {
  lines: number;
  commits: number | null;
  atRisk: boolean;
}

/** One worktree, as `GET /api/worktrees` serves it. */
export interface WorktreeRow {
  slug: string;
  branch: string | null;
  worktreePath: string;
  /** null for an orphan worktree on disk: no task owns it, so it has no lifecycle. */
  state: TaskState | null;
  health: WorktreeHealth;
  /** ms since the progress token last advanced; null when there is no evidence at all. */
  quietForMs: number | null;
  lastActivityAt: string | null;
  unprotected: Unprotected;
  filesChanged: number | null;
  ahead: number | null;
  behind: number | null;
  repoState: RepoState | null;
  /** The process actually detected in the worktree (board.ts:43,62). */
  agent: string | null;
  /** The agent the task RECORD says holds it. Differs from `agent` exactly when
   *  the holder died — the highest-value fact this route can state. */
  claimedBy: string | null;
  holderRunning: boolean;
  planId: string | null;
  phase: number | null;
  dependsOn: string[];
  orphan: boolean;
  wipRef: string | null;
}

/** Git's answer about one worktree, or `null` when git could not answer at all. */
export interface WorktreeGitFacts {
  status: 'clean' | 'dirty' | 'conflict' | 'missing';
  repoState: RepoState;
  ahead: number;
  behind: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/** Everything the derivation needs, with no I/O in sight — so it is testable. */
export interface WorktreeFacts {
  slug: string;
  branch: string | null;
  worktreePath: string;
  state: TaskState | null;
  git: WorktreeGitFacts | null;
  /** Commits that exist nowhere but here. `null` = the refs read failed. */
  localOnlyCommits: number | null;
  agent: string | null;
  claimedBy: string | null;
  holderRunning: boolean;
  /** Epoch ms of the newest liveness evidence; 0 = none at all. */
  lastActivityAt: number;
  planId: string | null;
  phase: number | null;
  dependsOn: string[];
  orphan: boolean;
  wipRef: string | null;
}

export interface HealthOpts {
  /** Silence before `working` becomes `quiet`. */
  quietMs?: number;
  /** Silence before `quiet` becomes `stalled` — the pipeline's own grace window. */
  graceMs?: number;
}

/** Is this worktree claimed by somebody, whether or not they are still there? */
function isHeld(f: WorktreeFacts): boolean {
  return f.claimedBy !== null || f.state === 'active' || f.state === 'claimed';
}

/** Uncommitted lines + commits nowhere else. Unknown counts as at risk. */
export function unprotectedOf(f: WorktreeFacts): Unprotected {
  const lines = f.git ? f.git.insertions + f.git.deletions : 0;
  const commits = f.localOnlyCommits;
  const dirty = f.git?.status === 'dirty' || f.git?.status === 'conflict';
  return {
    lines,
    commits,
    // A brand-new untracked file contributes no `--numstat` line, so `lines`
    // alone would call a worktree full of unsaved new code safe.
    atRisk: lines > 0 || dirty || commits === null || commits > 0,
  };
}

/**
 * The evidence ladder. The ORDER is the design, so each rung says why it sits
 * where it does.
 */
export function deriveHealth(f: WorktreeFacts, now: number, opts: HealthOpts = {}): WorktreeHealth {
  // 1. Git did not answer. Everything below this line would be a guess.
  if (f.git === null) return 'unknown';
  // 2. A recorded worktree whose directory is gone. A known fact, not a guess —
  //    `worktreeStatus` keeps `missing` separate from `clean` precisely so this
  //    rung can exist (git.ts:105).
  if (f.git.status === 'missing') return 'missing';
  // 3. On disk with no task behind it. Also a known fact, and more useful than
  //    anything we could say about how busy it looks.
  if (f.orphan) return 'orphan-disk';
  // 4. We could not count what exists only here, so we cannot claim it is safe.
  if (f.localOnlyCommits === null) return 'unknown';

  const risk = unprotectedOf(f);
  // 5. The terminal state the reporter is afraid of: nobody is running, and the
  //    worktree still holds work that exists nowhere else. Above conflict and
  //    rebase on purpose — a half-finished rebase with no one driving it is
  //    abandoned first and rebasing second.
  if (isHeld(f) && !f.holderRunning && risk.atRisk) return 'abandoned';

  // 6. Git states a human has to resolve before "is it moving" means anything.
  if (f.git.status === 'conflict') return 'conflict';
  // Any in-progress operation — merging, cherry-picking, reverting — lands here;
  // the exact one is on the row as `repoState`.
  if (f.git.repoState !== 'clean') return 'rebasing';

  // 7. Held: the four-name liveness vocabulary, driven by the progress token.
  if (isHeld(f)) {
    if (f.lastActivityAt <= 0) return 'unknown'; // held, but no evidence either way
    const quietFor = now - f.lastActivityAt;
    if (quietFor <= (opts.quietMs ?? STALL_QUIET_MS)) return 'working';
    if (quietFor <= (opts.graceMs ?? STALL_GRACE_MS)) return 'quiet';
    return 'stalled';
  }

  // 8. Unheld: plain git truth. Nobody is expected to be moving it.
  if (f.git.status === 'dirty') return 'dirty';
  return 'ok';
}

/** Facts → the served row. Pure. */
export function buildWorktreeRow(f: WorktreeFacts, now: number, opts: HealthOpts = {}): WorktreeRow {
  return {
    slug: f.slug,
    branch: f.branch,
    worktreePath: f.worktreePath,
    state: f.state,
    health: deriveHealth(f, now, opts),
    quietForMs: f.lastActivityAt > 0 ? Math.max(0, now - f.lastActivityAt) : null,
    lastActivityAt: f.lastActivityAt > 0 ? new Date(f.lastActivityAt).toISOString() : null,
    unprotected: unprotectedOf(f),
    filesChanged: f.git ? f.git.filesChanged : null,
    ahead: f.git ? f.git.ahead : null,
    behind: f.git ? f.git.behind : null,
    repoState: f.git ? f.git.repoState : null,
    agent: f.agent,
    claimedBy: f.claimedBy,
    holderRunning: f.holderRunning,
    planId: f.planId,
    phase: f.phase,
    dependsOn: f.dependsOn,
    orphan: f.orphan,
    wipRef: f.wipRef,
  };
}

/* ------------------------------------------------------------------ */
/* Collection                                                          */
/* ------------------------------------------------------------------ */

/**
 * Path identity as the filesystem sees it, not as the string looks.
 *
 * `git worktree list` reports the resolved path (`/private/var/...` on macOS)
 * while `tasks.json` stores whatever the caller typed (`/var/...`), so comparing
 * `resolve()`d strings decides a perfectly ordinary task worktree is an orphan
 * nobody owns — and this route would then list it twice, once as each. Falls
 * back to `resolve` for a path that is gone, which is the case `missing` covers.
 */
function samePath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

/** Sentinel in the branch→lead map: this branch has no upstream at all. */
const NO_UPSTREAM = Number.NaN;

/**
 * Local-only commit lead for every `refs/heads/*` in one repo, from ONE
 * `for-each-ref`.
 *
 * `%(upstream:track)` is git's own answer to "how far ahead of the remote am
 * I", rendered as `[ahead 3]`. When a branch has no upstream at all, nothing it
 * carries exists anywhere else, so its whole lead over the base branch is
 * unprotected — and `ahead` (already computed by `collectStatus`) is that count.
 * Returns null on failure, so callers report `unknown` instead of inventing a
 * zero. US (0x1f) separates the fields because a ref name cannot contain it.
 */
async function localLeadByBranch(repo: string): Promise<Map<string, number> | null> {
  const r = await gitTry([
    '-C', repo, 'for-each-ref',
    '--format=%(refname:short)%1f%(upstream:short)%1f%(upstream:track)',
    'refs/heads/',
  ]);
  if (!r.ok) return null;
  const out = new Map<string, number>();
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const [name, upstream, track] = line.split('\x1f');
    if (!name) continue;
    if (!upstream) {
      out.set(name, NO_UPSTREAM);
      continue;
    }
    const m = /ahead (\d+)/.exec(track ?? '');
    out.set(name, m ? parseInt(m[1]!, 10) : 0);
  }
  return out;
}

/**
 * `refs/baton/wip/<slug>` → refname, from ONE `for-each-ref`.
 *
 * The ref is WRITTEN by `src/wip-snapshot.ts`, which is being built separately
 * and is deliberately not imported here. This only reads the namespace: it
 * either has refs in it or it does not, and an empty map is the correct answer
 * until the writer lands.
 */
async function wipRefs(repo: string): Promise<Map<string, string>> {
  const r = await gitTry(['-C', repo, 'for-each-ref', '--format=%(refname)', 'refs/baton/wip/']);
  if (!r.ok || !r.stdout) return new Map();
  const out = new Map<string, string>();
  for (const ref of r.stdout.split('\n').filter(Boolean)) {
    out.set(ref.slice('refs/baton/wip/'.length), ref);
  }
  return out;
}

export interface CollectOpts extends HealthOpts {
  now?: number;
  /**
   * The poller's cached board rows. The daemon passes its `statusRows()`, which
   * rides the 2s snapshot — see the cost note below.
   */
  status?: () => Promise<StatusRow[]>;
}

/**
 * Join everything into rows.
 *
 * Cost, because this is a route and the discipline here is explicit:
 *
 *   CACHED   — the whole `StatusRow` set: working-tree status, repoState,
 *              ahead, behind, filesChanged, churn, and the detected agent. It
 *              comes from the poller's 2s snapshot when a dashboard is
 *              connected (`statusRows` in server.ts), so a request adds no git
 *              spawn for any of it. Only an idle daemon pays for a fresh
 *              `collectStatus`.
 *   LIVE     — `listWorktrees` (1 spawn) plus, per DISTINCT repo root, one
 *              `for-each-ref` for upstream tracking and one for the wip
 *              namespace. O(repos), not O(worktrees): no per-request fan-out,
 *              which is the thing this daemon cannot afford.
 *   LIVE-ish — `livenessProbe` reads the in-memory presence table and walks each
 *              worktree's mtimes, capped at 2000 entries / depth 6
 *              (liveness.ts:33-37). The same bounded walk the board already does.
 *
 * Read-only throughout: no ref is created, no file written, nothing reclaimed.
 */
export async function collectWorktrees(root: string, opts: CollectOpts = {}): Promise<WorktreeRow[]> {
  const now = opts.now ?? Date.now();
  const tasks = await loadTasks(root);
  const materialized = tasks.filter(isMaterialized);

  // `collectStatus` is the one call that can fail wholesale (a served root that
  // is not a git repo, git missing from PATH). Losing it must not turn into a
  // page full of healthy-looking rows, so the whole set degrades to `unknown`.
  let statusBySlug: Map<string, StatusRow> | null = null;
  try {
    const rows = await (opts.status ? opts.status() : collectStatus(root));
    statusBySlug = new Map(rows.map((r) => [r.slug, r]));
  } catch {
    statusBySlug = null;
  }

  const worktrees = await listWorktrees(root);
  // The orphan half of `auditJunk` (cleanup.ts:216) without its cost: auditJunk
  // also probes tmux, scans two tmp directories, and runs `worktreeStatus` per
  // item — exactly the per-request fan-out this route must not do.
  // `auditWorktrees` is its pure detector and yields the same orphan items from
  // the tasks and worktree list already in hand.
  const junk = auditWorktrees(root, tasks, worktrees, existsSync);
  // …and re-checked against the real paths of the tasks we are already about to
  // serve, because `auditWorktrees` compares path STRINGS. See `samePath`.
  const taskPaths = new Set(materialized.map((t) => samePath(t.worktreePath)));
  const orphansOnDisk = junk.filter(
    (j) => j.kind === 'orphan-worktree-disk' && j.path && !taskPaths.has(samePath(j.path)),
  );

  // One pair of ref reads per repo, not per task: a hub's tasks are spread over
  // a handful of sub-projects, and every task in one shares its refs.
  const repos = [...new Set(materialized.map((t) => t.repoRoot ?? root))];
  const refsByRepo = new Map(await Promise.all(repos.map(async (repo) => {
    const [local, wip] = await Promise.all([localLeadByBranch(repo), wipRefs(repo)]);
    return [repo, { local, wip }] as const;
  })));

  const liveness = livenessProbe(root);

  const factsFor = (t: Task): WorktreeFacts => {
    const st = statusBySlug?.get(t.slug);
    const refs = refsByRepo.get(t.repoRoot ?? root);
    // A materialized task with no board row means the board could not speak for
    // it — fail closed rather than call it clean.
    const git: WorktreeGitFacts | null = st
      ? {
        status: st.status,
        repoState: st.repoState,
        ahead: st.ahead,
        behind: st.behind,
        // `worktreeStatus` returns conflicts in their own list, so the plain
        // changed-file count is 0 exactly when the count matters most.
        filesChanged: st.status === 'conflict' ? st.conflictFiles.length : st.filesChanged,
        insertions: st.insertions,
        deletions: st.deletions,
      }
      : null;
    let localOnly: number | null = null;
    if (refs?.local && git) {
      const lead = refs.local.get(t.branch);
      // Absent from the map = the branch no longer exists; nothing is at risk on
      // a ref that is gone. NaN = no upstream, so `ahead` is the exposure.
      if (lead === undefined) localOnly = 0;
      else localOnly = Number.isNaN(lead) ? git.ahead : lead;
    }
    return {
      slug: t.slug,
      branch: t.branch,
      worktreePath: t.worktreePath,
      state: stateOf(t),
      git,
      localOnlyCommits: localOnly,
      agent: st?.agent ?? null,
      claimedBy: t.claimedBy?.agent ?? null,
      // `StatusRow.agent` is already `detectAgents` ∪ the headless registry
      // (board.ts:43,62) — a detected PROCESS, not a stored claim. That gap is
      // the difference between "an agent claimed this" and "an agent is here",
      // and it is the fact nothing in the product surfaces today.
      holderRunning: (st?.agent ?? null) !== null,
      lastActivityAt: liveness(t),
      planId: t.planId ?? null,
      phase: t.phase ?? null,
      dependsOn: t.dependsOn ?? [],
      orphan: false,
      wipRef: refs?.wip.get(t.slug) ?? null,
    };
  };

  const rows = materialized.map((t) => buildWorktreeRow(factsFor(t), now, opts));

  // Worktrees git knows about that no task claims. They are the ones most
  // likely to be forgotten, so they belong in this list rather than only in a
  // doctor report that has no client at all.
  for (const item of orphansOnDisk) {
    const entry = worktrees.find((w) => resolve(w.path) === resolve(item.path!));
    rows.push(buildWorktreeRow({
      slug: item.id,
      branch: entry?.branch ?? item.branch ?? null,
      worktreePath: item.path!,
      state: null,
      // Deliberately NOT `worktreeStatus` here: one spawn per orphan is the
      // fan-out the cost discipline forbids, and `orphan-disk` outranks
      // anything a status call could add. `auditJunk` is where a caller that
      // wants the dirty check on these pays for it.
      git: { status: 'clean', repoState: 'clean', ahead: 0, behind: 0, filesChanged: 0, insertions: 0, deletions: 0 },
      localOnlyCommits: 0,
      agent: null,
      claimedBy: null,
      holderRunning: false,
      lastActivityAt: 0,
      planId: null,
      phase: null,
      dependsOn: [],
      orphan: true,
      wipRef: null,
    }, now, opts));
  }

  // Most exposed first: sorting by this descending answers the reporter's fear
  // directly — the row at the top is what you lose if the disk dies.
  const risk = (r: WorktreeRow) => (r.unprotected.atRisk ? 1 : 0);
  return rows.sort((a, b) => risk(b) - risk(a)
    || b.unprotected.lines - a.unprotected.lines
    || (b.unprotected.commits ?? 0) - (a.unprotected.commits ?? 0)
    || a.slug.localeCompare(b.slug));
}
