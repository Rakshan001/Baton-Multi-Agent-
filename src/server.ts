/**
 * Local JSON API for the Baton web dashboard. Binds to 127.0.0.1 only and
 * allows CORS from localhost origins — it exposes your repo's task data, so it
 * must never be reachable off-machine.
 *
 * Endpoints:
 *   GET /api/status       → live board rows (collectStatus)
 *   GET /api/history      → tasks + commits (listHistory)
 *   GET /api/tasks/:slug  → one task: row + commits + worktree path
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { collectStatus } from './board.js';
import { gitRoot } from './git.js';
import { listHistory } from './history.js';
import { loadTasks } from './store.js';

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'http://localhost:3000',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  });
  res.end(json);
}

async function handle(req: IncomingMessage, res: ServerResponse, root: string): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (path === '/api/status') return send(res, 200, await collectStatus(root));
  if (path === '/api/history') return send(res, 200, listHistory(root));

  const m = path.match(/^\/api\/tasks\/([^/]+)$/);
  if (m) {
    const slug = decodeURIComponent(m[1]);
    const [rows, tasks, history] = [
      await collectStatus(root),
      await loadTasks(root),
      listHistory(root),
    ];
    const row = rows.find((r) => r.slug === slug);
    const task = tasks.find((t) => t.slug === slug);
    if (!row || !task) return send(res, 404, { error: `no task '${slug}'` });
    const commits = history.find((h) => h.slug === slug)?.commits ?? [];
    return send(res, 200, { ...row, worktreePath: task.worktreePath, branch: task.branch, commits });
  }

  send(res, 404, { error: 'not found' });
}

export async function serve(port: number): Promise<void> {
  const root = await gitRoot();
  const server = createServer((req, res) => {
    void handle(req, res, root).catch((e) =>
      send(res, 500, { error: (e as Error).message }),
    );
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  console.log(`baton serve → http://localhost:${port}`);
  console.log('  GET /api/status · /api/history · /api/tasks/:slug   (Ctrl+C to stop)');
}
