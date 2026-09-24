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
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { collectStatus, type StatusRow } from './board.js';
import { isBatonWorktree } from './cleanup.js';
import { listWorktrees, type RepoState } from './git.js';
import { loadKb } from './kb/state.js';
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
  | 'unknown' | 'unmanaged';

/**
 * Who made this worktree. `task` and `orphan` are Baton's own; `main` (a repo's
 * primary checkout) and `external` (a plain `git worktree add`, another tool's
 * `.claude/worktrees/*`) are listed so they can be SEEN, and Baton acts on
 * neither.
 */
export type WorktreeKind = 'task' | 'orphan' | 'main' | 'external';

/**
 * The id of a row no task owns: `<basename>~<10 hex of sha1(path)>`.
 *
 * A basename can equal a task slug or another orphan's basename, so it cannot
 * be the id. `slugify` (store.ts) only emits `[a-z0-9-]`, so an id carrying `~`
 * can never equal a task slug, and `isSafeProgressSlug` rejects it, so no
 * ledger route reads it. `path` is used exactly as git reports it: no second
 * realpath, so the id is stable across polls at no extra syscall.
 */
export function worktreeId(path: string): string {
  const base = basename(path).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40) || 'wt';
  return `${base}~${createHash('sha1').update(path).digest('hex').slice(0, 10)}`;
}

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
  /** The task slug for a task row, `worktreeId(path)` for every other kind. */
  slug: string;
  kind: WorktreeKind;
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
  /** `kind === 'orphan'`, kept so every existing orphan consumer reads on. */
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
  kind: WorktreeKind;
  /** false for a non-task row whose directory is gone (git still records it).
   *  Omitted for rows that were not checked. */
  onDisk?: boolean;
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
  // An orphan whose directory is gone holds no uncommitted work to lose. Its
  // commits were never counted (null) and stay that way — but the disk has
  // nothing on it, which is the question `atRisk` answers.
  if (f.kind === 'orphan' && f.onDisk === false) return { lines: 0, commits: f.localOnlyCommits, atRisk: false };
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
  // 0. Baton did not create this worktree. A known fact, like `orphan-disk`,
  //    and not a guess: nobody reads its status (git: null) and nothing here
  //    may call it stalled or abandoned.
  if (f.kind === 'main' || f.kind === 'external') return 'unmanaged';
  // 1. On disk with no task behind it. A known fact, and more useful than
  //    anything we could say about how busy it looks. First, because an orphan
  //    carries no git facts at all (we never read it) and must not read `unknown`.
  if (f.kind === 'orphan') return 'orphan-disk';
  // 2. Git did not answer. Everything below this line would be a guess.
  if (f.git === null) return 'unknown';
  // 3. A recorded worktree whose directory is gone. A known fact, not a guess —
  //    `worktreeStatus` keeps `missing` separate from `clean` precisely so this
  //    rung can exist (git.ts:105).
  if (f.git.status === 'missing') return 'missing';
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
    kind: f.kind,
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
    orphan: f.kind === 'orphan',
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
  /** Task rows only: skips every `git worktree list`. For a caller that acts
   *  on task rows alone (the poller's stall briefs). */
  tasksOnly?: boolean;
}

/**
 * The repos whose worktrees are listed: `root`, every task's `repoRoot`, every
 * kb project — deduped by real path BEFORE any spawn. A repo is listed only if
 * it has a `.git` (dir or file), so a hub that is not a repo never asks git,
 * which would answer for whatever repo encloses it.
 */
async function reposToList(root: string, tasks: Task[]): Promise<string[]> {
  const kb = await loadKb(root);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const repo of [root, ...tasks.map((t) => t.repoRoot ?? root), ...(kb?.projects ?? []).map((p) => p.path)]) {
    const key = samePath(repo);
    if (seen.has(key) || !existsSync(join(repo, '.git'))) continue;
    seen.add(key);
    out.push(repo);
  }
  return out;
}

/** `p` is `dir` or below it, by real path and by path segment. */
function within(dir: string, p: string): boolean {
  const d = samePath(dir);
  const q = samePath(p);
  return q === d || q.startsWith(d.endsWith(sep) ? d : d + sep);
}

/**
 * Join everything into rows: one per task, plus one per worktree git lists in
 * any repo above that no task owns — `orphan` when `isBatonWorktree` says Baton
 * made it (the predicate `baton clean` uses), `main` for a repo's primary
 * checkout, `external` for everything else.
 *
 * Cost, because this is a route and the discipline here is explicit:
 *
 *   CACHED   — the whole `StatusRow` set: working-tree status, repoState,
 *              ahead, behind, filesChanged, churn, and the detected agent. It
 *              comes from the poller's 2s snapshot when a dashboard is
 *              connected (`statusRows` in server.ts), so a request adds no git
 *              spawn for any of it. Only an idle daemon pays for a fresh
 *              `collectStatus`.
 *   LIVE     — one `listWorktrees` per DISTINCT repo (root, task repoRoots,
 *              kb projects), run in parallel — measured 62-125 ms each — plus,
 *              per distinct task repo, one `for-each-ref` for upstream tracking
 *              and one for the wip namespace. O(repos), not O(worktrees): no
 *              per-request fan-out, which is the thing this daemon cannot
 *              afford. Non-task rows are never status-read (`git: null`).
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
      // a ref that is gone. NaN = no upstream, so `ahead` is the exposure — but
      // only if git could count it: an uncountable `ahead` reads 0, and 0 here
      // would call every commit on the branch safe.
      if (lead === undefined) localOnly = 0;
      else localOnly = Number.isNaN(lead) ? (st?.aheadKnown === true ? git.ahead : null) : lead;
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
      kind: 'task',
      wipRef: refs?.wip.get(t.slug) ?? null,
    };
  };

  const rows = materialized.map((t) => buildWorktreeRow(factsFor(t), now, opts));

  if (opts.tasksOnly) return sortRows(rows);

  // Worktrees git knows about that no task claims. They are the ones most
  // likely to be forgotten, so they belong in this list rather than only in a
  // doctor report that has no client at all.
  const taskPaths = new Set(materialized.map((t) => samePath(t.worktreePath)));
  const listings = await Promise.all((await reposToList(root, tasks)).map(async (repo) => {
    const entries = await listWorktrees(repo);
    // git lists the main worktree first. When that main is outside this root
    // (root is a linked worktree of an outer repo), the outer checkout is some
    // other project's business: keep only what lives under root.
    const kept = entries[0] && within(root, entries[0].path) ? entries : entries.filter((e) => within(root, e.path));
    return { repo: samePath(repo), main: entries[0], entries: kept };
  }));
  const listed = new Set<string>();
  for (const { repo, main, entries } of listings) {
    for (const e of entries) {
      // A bare repo's "main" has no checkout to show.
      if (e === main && e.head === null) continue;
      const key = samePath(e.path);
      if (taskPaths.has(key) || listed.has(key)) continue;
      // The listed repo's own checkout is its main, even when git's index 0
      // is an outer repo's.
      const kind: WorktreeKind = e === main || key === repo ? 'main' : isBatonWorktree(root, e) ? 'orphan' : 'external';
      const onDisk = existsSync(e.path);
      // A prunable entry is git metadata, not a worktree.
      if (kind === 'external' && !onDisk) continue;
      listed.add(key);
      rows.push(buildWorktreeRow({
        slug: worktreeId(e.path),
        branch: e.branch,
        worktreePath: e.path,
        state: null,
        // Deliberately NOT `worktreeStatus` here: one spawn per row is the
        // fan-out the cost discipline forbids, and `orphan-disk`/`unmanaged`
        // outrank anything a status call could add. `auditJunk` is where a
        // caller that wants the dirty check on orphans pays for it. Not read =
        // not known: null, never a stubbed "clean, 0 files", which sorted real
        // unsaved work last.
        git: null,
        localOnlyCommits: null,
        agent: null,
        claimedBy: null,
        holderRunning: false,
        lastActivityAt: 0,
        planId: null,
        phase: null,
        dependsOn: [],
        kind,
        onDisk,
        wipRef: null,
      }, now, opts));
    }
  }

  return sortRows(rows);
}

/**
 * Baton's rows first, most exposed first: sorting by risk descending answers
 * the reporter's fear directly — the row at the top is what you lose if the
 * disk dies. Every unmanaged row follows, main checkouts first, then by path.
 */
function sortRows(rows: WorktreeRow[]): WorktreeRow[] {
  const tier = (r: WorktreeRow) => (r.kind === 'task' || r.kind === 'orphan' ? 0 : r.kind === 'main' ? 1 : 2);
  const risk = (r: WorktreeRow) => (r.unprotected.atRisk ? 1 : 0);
  return rows.sort((a, b) => tier(a) - tier(b) || (tier(a) > 0
    ? a.worktreePath.localeCompare(b.worktreePath)
    : risk(b) - risk(a)
      || b.unprotected.lines - a.unprotected.lines
      || (b.unprotected.commits ?? 0) - (a.unprotected.commits ?? 0)
      || a.slug.localeCompare(b.slug)));
}
