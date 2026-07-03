/**
 * Shared graphify backends: one HTTP graphify.serve process per project,
 * lazily started and idle-reaped, so N agents share 1 process instead of each
 * spawning their own 6 (the RAM explosion the perf audit measured). --stateless
 * --json-response makes each backend a plain request/response server the daemon
 * can proxy without session affinity or SSE.
 *
 * Graph freshness: graphify.serve --stateless re-reads the graph file on every
 * request (verified empirically: 100-node graph → modify to 10 nodes → next
 * graph_stats call returns 10). No flush-on-rebuild is needed; agents see updated
 * graphs immediately after a `baton kb rebuild` without a daemon restart.
 */
import { createServer } from 'node:net';
import { execa, type ResultPromise } from 'execa';

export interface Backend { projectId: string; port: number; lastAccess: number; }

/** Ask the OS for a free loopback port (same trick as setup.ts). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

async function waitReady(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} }),
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error(`graphify backend on :${port} did not become ready`);
}

interface Live extends Backend { proc: ResultPromise; exited: boolean; }

/**
 * Send SIGTERM, then SIGKILL after 5 s if the process hasn't exited.
 * The timer is unref'd so it doesn't keep the event loop alive.
 */
function killHard(entry: Live): void {
  if (entry.exited) return;
  entry.proc.kill('SIGTERM');
  const t = setTimeout(() => { if (!entry.exited) entry.proc.kill('SIGKILL'); }, 5_000);
  if (typeof t === 'object' && t !== null && 'unref' in t) (t as NodeJS.Timeout).unref();
}

export class GraphifyPool {
  private live = new Map<string, Live>();
  private starting = new Map<string, Promise<number>>();
  private readonly idleMs: number;
  constructor(private graphFor: (id: string) => string | null, opts: { idleMs?: number } = {}) {
    this.idleMs = opts.idleMs ?? 15 * 60_000;
  }

  async ensure(projectId: string): Promise<number> {
    const existing = this.live.get(projectId);
    if (existing) { existing.lastAccess = Date.now(); return existing.port; }
    const pending = this.starting.get(projectId);
    if (pending) return pending;
    const p = this.spawn(projectId);
    this.starting.set(projectId, p);
    try { return await p; } finally { this.starting.delete(projectId); }
  }

  private async spawn(projectId: string): Promise<number> {
    const graph = this.graphFor(projectId);
    if (!graph) throw new Error(`no graph for project '${projectId}'`);
    const port = await freePort();
    // Create the entry object before attaching the finally so the identity
    // guard in finally can compare against it (fixes stale-deletion race).
    const entry: Live = { projectId, port, lastAccess: Date.now(), proc: null!, exited: false };
    const proc = execa('uv', [
      'run', '--with', 'graphifyy', '--with', 'mcp', '-m', 'graphify.serve',
      '--transport', 'http', '--host', '127.0.0.1', '--port', String(port),
      '--stateless', '--json-response', graph,
    ], { stdout: 'ignore', stderr: 'ignore', env: { ...process.env } });
    entry.proc = proc;
    proc.catch(() => undefined).finally(() => {
      entry.exited = true;
      // Only delete our own entry — guards against a reap+respawn of the same
      // projectId arriving before this finally fires (identity check).
      if (this.live.get(projectId) === entry) this.live.delete(projectId);
    });
    try {
      await waitReady(port);
    } catch (e) {
      killHard(entry);
      throw e;
    }
    this.live.set(projectId, entry);
    return port;
  }

  note(projectId: string): void {
    const b = this.live.get(projectId);
    if (b) b.lastAccess = Date.now();
  }

  async reapIdle(now = Date.now()): Promise<string[]> {
    const reaped: string[] = [];
    for (const [id, b] of this.live) {
      if (now - b.lastAccess >= this.idleMs) {
        killHard(b);
        this.live.delete(id);
        reaped.push(id);
      }
    }
    return reaped;
  }

  async shutdown(): Promise<void> {
    // Fire-and-forget: daemon is exiting, so we don't await process termination.
    for (const b of this.live.values()) killHard(b);
    this.live.clear();
  }

  ports(): Backend[] {
    return [...this.live.values()].map(({ projectId, port, lastAccess }) => ({ projectId, port, lastAccess }));
  }
}
