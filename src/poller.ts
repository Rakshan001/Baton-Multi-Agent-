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
import { loadTasks } from './store.js';
import { bus } from './events.js';

const INTERVAL_MS = 2000;

export class StatusPoller {
  private root: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners = 0;
  private prev: StatusRow[] | null = null;
  private running = false;

  constructor(root: string) {
    this.root = root;
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
    } catch {
      // transient git failure — try again next tick
    } finally {
      this.running = false;
    }
  }

  private async publishNewCommits(slug: string, count: number): Promise<void> {
    try {
      const task = (await loadTasks(this.root)).find((t) => t.slug === slug);
      if (!task) return;
      const commits = await branchCommits(task.branch, task.baseBranch, this.root);
      for (const c of commits.slice(0, count)) {
        bus.publish({ type: 'commit.created', slug, sha: c.sha, message: c.message });
      }
    } catch {
      /* commit detail is best-effort */
    }
  }
}
