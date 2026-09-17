// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Server-side change detector: the daemon polls its own status collector and
 * publishes diffs to the bus, so N dashboard clients get push updates from
 * ONE git scan instead of N independent polling loops.
 *
 * Only runs while someone is listening (SSE clients > 0) — an idle daemon
 * does no git work.
 */
import { collectStatus, type StatusRow } from './board.js';
import { branchCommits } from './git.js';
import { livenessProbe } from './liveness.js';
import { isStalled, type PipelineTask } from './pipeline.js';
import { loadTasks } from './store.js';
import { bus } from './events.js';
import { enteredRisk, snapshotWip } from './wip-snapshot.js';

const INTERVAL_MS = 2000;

/**
 * How often the tick may go looking for a STALLED holder (as opposed to a
 * departed one, which is an edge the diff below already sees for free).
 *
 * `isStalled` needs `livenessProbe`, and that walks each worktree for mtimes
 * (`src/liveness.ts:33-37`) — far too much to do on a 2s tick. A stall is 45
 * minutes old by definition (`STALL_GRACE_MS`), so looking once a minute loses
 * nothing and costs ~1/30th as much.
 */
const STALL_SCAN_MS = 60_000;

/** What a WIP snapshot would capture, cheaply. Same numbers ⇒ same work ⇒ the
 *  ref we already wrote still describes it, so don't spend git on it again. */
function wipSignature(row: StatusRow): string {
  return `${row.status}:${row.filesChanged}:${row.insertions}:${row.deletions}`;
}

export class StatusPoller {
  private root: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = 0;
  private prev: StatusRow[] | null = null;
  private prevAt = 0;
  private running = false;
  /** slug → the signature last written to `refs/baton/wip/<slug>`. */
  private wipSigs = new Map<string, string>();
  private wipBusy = false;
  private lastStallScan = 0;

  constructor(root: string) {
    this.root = root;
  }

  /**
   * The latest collected rows, if fresh enough to serve — so HTTP reads ride
   * the poller's shared scan instead of spawning their own ~10 git processes
   * per task. Null when the poller is idle (no SSE client) or the snapshot
   * has aged out; callers then collect directly.
   */
  snapshot(maxAgeMs: number = INTERVAL_MS + 500): StatusRow[] | null {
    if (!this.prev || Date.now() - this.prevAt > maxAgeMs) return null;
    return this.prev;
  }

  /** Call when an SSE client connects; returns a release fn for disconnect. */
  retain(): () => void {
    this.listeners++;
    if (this.listeners === 1) this.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.listeners--;
      if (this.listeners === 0) this.stop();
    };
  }

  private start(): void {
    this.prev = null;
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
    void this.tick();
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return; // skip a beat rather than stack git scans
    this.running = true;
    try {
      const rows = await collectStatus(this.root);
      const prev = this.prev;
      this.prev = rows;
      this.prevAt = Date.now();
      if (!prev) return; // first snapshot is a baseline, not a change
      if (JSON.stringify(rows) !== JSON.stringify(prev)) {
        bus.publish({ type: 'status.changed', rows });
      }
      const prevBySlug = new Map(prev.map((r) => [r.slug, r]));
      for (const row of rows) {
        const before = prevBySlug.get(row.slug);
        if (!before) continue;
        if (before.agent !== row.agent) {
          if (before.agent) bus.publish({ type: 'agent.stopped', slug: row.slug, agent: before.agent });
          if (row.agent) bus.publish({ type: 'agent.started', slug: row.slug, agent: row.agent });
        }
        if (row.ahead > before.ahead) void this.publishNewCommits(row.slug, row.ahead - before.ahead);
      }
      // Side effects belong on the tick path and nowhere else: this WRITES a
      // git ref, so it must never be reachable from a GET handler. Fire and
      // forget — a snapshot runs git plumbing and can take seconds, and the
      // board must not wait on it.
      void this.snapshotAtRisk(rows, prev);
    } catch {
      // transient git failure — try again next tick
    } finally {
      this.running = false;
    }
  }

  /**
   * Save the uncommitted work in any worktree that just stopped being looked
   * after — see `src/wip-snapshot.ts` for what lands in the ref and why.
   *
   * Two ways in, both of them edges rather than levels:
   *   - the holder disappeared while the worktree is dirty (`enteredRisk`),
   *     free of charge from the diff the tick already computed; and
   *   - the holder is still attached but has shown no sign of life past the
   *     stall grace — the only case needing real work, hence STALL_SCAN_MS.
   *
   * A signature per slug keeps a worktree that sits stalled for hours from
   * re-running git every minute for a ref that already says the same thing.
   */
  private async snapshotAtRisk(rows: StatusRow[], prev: StatusRow[]): Promise<void> {
    if (this.wipBusy) return; // never stack snapshots behind a slow one
    const now = Date.now();
    const prevBySlug = new Map(prev.map((r) => [r.slug, r]));
    const due: string[] = [];
    const maybeStalled: StatusRow[] = [];
    const scanStalls = now - this.lastStallScan >= STALL_SCAN_MS;

    for (const row of rows) {
      if (row.status === 'clean') {
        this.wipSigs.delete(row.slug); // committed or reverted — start fresh
        continue;
      }
      if (row.status === 'missing') continue; // nothing left on disk to read
      if (this.wipSigs.get(row.slug) === wipSignature(row)) continue;
      const before = prevBySlug.get(row.slug);
      if (!before) continue; // first sighting is a baseline, not a transition
      if (enteredRisk(before, row)) due.push(row.slug);
      else if (scanStalls) maybeStalled.push(row);
    }
    if (scanStalls) this.lastStallScan = now;
    if (due.length === 0 && maybeStalled.length === 0) return;

    this.wipBusy = true;
    try {
      const tasks = await loadTasks(this.root);
      if (maybeStalled.length > 0) {
        const stalledSlugs = new Set(maybeStalled.map((r) => r.slug));
        const liveness = livenessProbe(this.root);
        for (const t of tasks) {
          if (!stalledSlugs.has(t.slug)) continue;
          if (isStalled(t as PipelineTask, { now, livenessOf: liveness })) due.push(t.slug);
        }
      }
      const rowBySlug = new Map(rows.map((r) => [r.slug, r]));
      for (const slug of due) {
        const task = tasks.find((t) => t.slug === slug);
        const row = rowBySlug.get(slug);
        if (!task?.worktreePath || !row) continue;
        const snap = await snapshotWip(slug, task.worktreePath);
        // Only a written ref earns the skip: a failed snapshot should be
        // retried the next time this worktree comes up, not marked done.
        if (snap) this.wipSigs.set(slug, wipSignature(row));
      }
    } catch {
      // best-effort, exactly like the rest of the tick
    } finally {
      this.wipBusy = false;
    }
  }

  private async publishNewCommits(slug: string, count: number): Promise<void> {
    try {
      const task = (await loadTasks(this.root)).find((t) => t.slug === slug);
      if (!task) return;
      // task.repoRoot, not this.root: in a hub the branch lives in the
      // SUB-PROJECT and the served root is often not a git repo at all. Asking
      // the wrong repo made `branchCommits` fail into `[]`, so `commit.created`
      // never fired for any hub task — the Live feed stayed empty, and worse,
      // that event is one of only two things that settle a signal, so committed
      // files kept reading as busy to every other agent. Sixth instance of the
      // wrong-root shape; every other consumer already spells it this way.
      const commits = await branchCommits(task.branch, task.baseBranch, task.repoRoot ?? this.root);
      for (const c of commits.slice(0, count)) {
        bus.publish({ type: 'commit.created', slug, sha: c.sha, message: c.message });
      }
    } catch {
      /* commit detail is best-effort */
    }
  }
}
