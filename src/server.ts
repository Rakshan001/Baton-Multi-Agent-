/**
 * Local JSON API for the Baton web dashboard. Binds to 127.0.0.1 only and
 * allows CORS from localhost origins — it exposes your repo's task data, so it
 * must never be reachable off-machine.
 *
 * Endpoints:
 *   GET    /api/status       → live board rows (collectStatus)
 *   GET    /api/history      → tasks + commits (listHistory)
 *   GET    /api/tasks/:slug  → one task: row + commits + worktree path
 *   GET    /api/meta         → repo root, current branch, capabilities, version
 *   POST   /api/tasks        → create a task (branch + worktree); body { task }
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { collectStatus } from './board.js';
import { currentBranch, gitRoot } from './git.js';
import { listHistory } from './history.js';
import { loadTasks, TaskNotFoundError } from './store.js';
import { createTask, EmptyTaskError } from './commands/new.js';
import { mergeTaskBranch, MergeConflictError } from './commands/merge.js';
import { removeTaskWorktree, MainWorktreeError, DirtyWorktreeError } from './commands/rm.js';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { buildGraph, detectGraphify, mergeGraphs, update } from './kb/graphify.js';
import { buildQueue, kbStatus, loadKb, saveKb } from './kb/state.js';
import { allSnippets } from './kb/mcp.js';
import { bus } from './events.js';
import { WorktreeWatcher } from './watch.js';
import { StatusPoller } from './poller.js';
import { checkFiles, getSignals, SignalTracker } from './signals.js';
import { getReport, listReports } from './reports.js';
import { queryFile } from './history.js';
import { passTask } from './commands/pass.js';
import { readBrief } from './handoff/brief.js';
import { getTask } from './store.js';

const require = createRequire(import.meta.url);
const VERSION: string = (() => {
  try {
    return (require('../package.json') as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

interface ServeOptions {
  port: number;
  /** When true, advertise write capability to the dashboard (merge/remove land in a later phase). */
  writeEnabled?: boolean;
}

/** Lazily-started per-daemon live infrastructure (one per `serve()`). */
let poller: StatusPoller | null = null;

/**
 * GET /api/events — Server-Sent Events stream of every bus event.
 * Replays missed events via Last-Event-ID; heartbeats keep proxies open.
 */
function handleEvents(req: IncomingMessage, res: ServerResponse, origin: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const lastId = Number(req.headers['last-event-id'] ?? 0);
  const write = (id: number, type: string, data: unknown) =>
    res.write(`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  if (lastId > 0) for (const e of bus.since(lastId)) write(e.id, e.event.type, e.event);

  const unsub = bus.onAny((e) => write(e.id, e.event.type, e.event));
  const release = poller?.retain() ?? (() => undefined);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsub();
    release();
  });
}

/** Echo a loopback Origin so the Vite dev server (any localhost port) works; deny others. */
function corsOrigin(req: IncomingMessage): string {
  const origin = req.headers.origin;
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return origin;
  return 'http://localhost:5173';
}

function send(res: ServerResponse, status: number, body: unknown, origin: string): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
  });
  res.end(json);
}

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) { reject(new Error('payload too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, root: string, opts: ServeOptions): Promise<void> {
  const origin = corsOrigin(req);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    });
    res.end();
    return;
  }

  if (method === 'GET' && path === '/api/events') return handleEvents(req, res, origin);

  // GET /api/signals — live edit signals across all worktrees
  if (method === 'GET' && path === '/api/signals') {
    return send(res, 200, { signals: await getSignals(root) }, origin);
  }
  // GET /api/signals/check?files=a,b,c — "ask before editing" for agents without MCP
  if (method === 'GET' && path === '/api/signals/check') {
    const files = (url.searchParams.get('files') ?? '').split(',').map((f) => f.trim()).filter(Boolean);
    if (!files.length) return send(res, 400, { error: 'pass ?files=path1,path2' }, origin);
    return send(res, 200, { files: await checkFiles(root, files) }, origin);
  }
  // GET /api/reports[/:slug] — completion reports of merged tasks
  if (method === 'GET' && path === '/api/reports') {
    return send(res, 200, listReports(root), origin);
  }
  const rm_ = path.match(/^\/api\/reports\/([^/]+)$/);
  if (rm_ && method === 'GET') {
    const report = getReport(root, decodeURIComponent(rm_[1]));
    return report ? send(res, 200, report, origin) : send(res, 404, { error: 'no report' }, origin);
  }
  // GET /api/blame?file=path — merged attribution + live editors for a file
  if (method === 'GET' && path === '/api/blame') {
    const file = url.searchParams.get('file');
    if (!file) return send(res, 400, { error: 'pass ?file=path' }, origin);
    const [merged, live] = [queryFile(root, file), await checkFiles(root, [file])];
    return send(res, 200, { file, merged, live: live[file]?.by ?? [] }, origin);
  }

  if (method === 'GET' && path === '/api/kb') {
    const [{ state, projects, merged }, det] = await Promise.all([kbStatus(root), detectGraphify()]);
    return send(res, 200, {
      initialized: !!state,
      graphifyInstalled: det.ok,
      projects: projects.map((p) => ({
        id: p.id, name: p.name, path: p.path,
        nodes: p.stats?.nodes ?? 0, edges: p.stats?.edges ?? 0,
        communities: p.stats?.communities ?? 0,
        lastBuiltAt: p.stats?.builtAt ?? null, building: p.building,
      })),
      merged: merged
        ? {
            id: 'merged', name: 'Merged', path: state?.root ?? root,
            nodes: merged.stats?.nodes ?? 0, edges: merged.stats?.edges ?? 0,
            communities: merged.stats?.communities ?? 0,
            lastBuiltAt: merged.stats?.builtAt ?? null, building: merged.building,
          }
        : null,
    }, origin);
  }

  // GET /api/kb/graph?project=<id|merged> — stream the (potentially multi-MB) graph.json
  if (method === 'GET' && path === '/api/kb/graph') {
    const state = await loadKb(root);
    if (!state) return send(res, 404, { error: 'knowledge base not initialized', hint: 'run: baton kb init' }, origin);
    const id = url.searchParams.get('project') ?? (state.mergedGraphPath ? 'merged' : state.projects[0]?.id);
    const graphPath = id === 'merged' ? state.mergedGraphPath : state.projects.find((p) => p.id === id)?.graphPath;
    if (!graphPath) return send(res, 404, { error: `no project '${id}'` }, origin);
    let st;
    try {
      st = await stat(graphPath);
    } catch {
      return send(res, 404, { error: `graph not built yet for '${id}'`, hint: 'run: baton kb rebuild' }, origin);
    }
    const etag = `"${st.size}-${st.mtimeMs}"`;
    const headers = {
      'Access-Control-Allow-Origin': origin,
      'Vary': 'Origin',
      'ETag': etag,
      'Cache-Control': 'no-cache',
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Type': 'application/json', 'Content-Length': st.size });
    createReadStream(graphPath).pipe(res);
    return;
  }

  // POST /api/kb/rebuild — queue an incremental (or full) rebuild (write-gated)
  if (method === 'POST' && path === '/api/kb/rebuild') {
    if (!opts.writeEnabled) return send(res, 403, { error: 'read-only', hint: 'start: baton serve --write' }, origin);
    const state = await loadKb(root);
    if (!state) return send(res, 404, { error: 'knowledge base not initialized', hint: 'run: baton kb init' }, origin);
    let body: { project?: string; full?: boolean } = {};
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return send(res, 400, { error: 'invalid JSON body' }, origin);
    }
    const targets = body.project ? state.projects.filter((p) => p.id === body.project) : state.projects;
    if (body.project && targets.length === 0) return send(res, 404, { error: `no project '${body.project}'` }, origin);
    for (const p of targets) {
      buildQueue.enqueue(p.id, () => (body.full ? buildGraph(p.path) : update(p.path)), (err) => {
        if (!err) bus.publish({ type: 'kb.rebuilt', project: p.id });
      });
    }
    if (state.mergedGraphPath && state.projects.length > 1) {
      const merged = state.mergedGraphPath;
      buildQueue.enqueue('merged', async () => {
        await mergeGraphs(state.projects.map((p) => p.graphPath), merged);
        state.lastBuiltAt = new Date().toISOString();
        await saveKb(root, state);
      }, (err) => {
        if (!err) bus.publish({ type: 'kb.rebuilt', project: 'merged' });
      });
    }
    return send(res, 202, { building: buildQueue.buildingIds().length ? buildQueue.buildingIds() : targets.map((t) => t.id) }, origin);
  }

  if (method === 'GET' && path === '/api/kb/mcp') {
    const state = await loadKb(root);
    if (!state) return send(res, 404, { error: 'knowledge base not initialized', hint: 'run: baton kb init' }, origin);
    return send(res, 200, { agents: allSnippets(state) }, origin);
  }

  if (method === 'GET' && path === '/api/status') return send(res, 200, await collectStatus(root), origin);
  if (method === 'GET' && path === '/api/history') return send(res, 200, listHistory(root), origin);
  if (method === 'GET' && path === '/api/meta') {
    return send(res, 200, { repo: root, branch: await currentBranch(root), writeEnabled: !!opts.writeEnabled, version: VERSION }, origin);
  }

  if (method === 'POST' && path === '/api/tasks') {
    let parsed: { task?: unknown };
    try {
      parsed = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return send(res, 400, { error: 'invalid JSON body' }, origin);
    }
    const text = typeof parsed.task === 'string' ? parsed.task : '';
    try {
      const task = await createTask(text, root);
      return send(res, 201, task, origin);
    } catch (e) {
      if (e instanceof EmptyTaskError) return send(res, 400, { error: e.message }, origin);
      return send(res, 500, { error: (e as Error).message }, origin);
    }
  }

  const m = path.match(/^\/api\/tasks\/([^/]+)$/);
  if (m && method === 'GET') {
    const slug = decodeURIComponent(m[1]);
    const [rows, tasks, history] = [
      await collectStatus(root),
      await loadTasks(root),
      listHistory(root),
    ];
    const row = rows.find((r) => r.slug === slug);
    const task = tasks.find((t) => t.slug === slug);
    if (!row || !task) return send(res, 404, { error: `no task '${slug}'` }, origin);
    const commits = history.find((h) => h.slug === slug)?.commits ?? [];
    return send(res, 200, { ...row, worktreePath: task.worktreePath, branch: task.branch, commits }, origin);
  }

  // DELETE /api/tasks/:slug — remove worktree + branch (write-gated)
  if (m && method === 'DELETE') {
    if (!opts.writeEnabled) return send(res, 403, { error: 'read-only', hint: 'start: baton serve --write' }, origin);
    const slug = decodeURIComponent(m[1]);
    const force = url.searchParams.get('force') === 'true';
    try {
      return send(res, 200, await removeTaskWorktree(slug, { force }, root), origin);
    } catch (e) {
      if (e instanceof TaskNotFoundError) return send(res, 404, { error: e.message }, origin);
      if (e instanceof MainWorktreeError) return send(res, 400, { error: e.message }, origin);
      if (e instanceof DirtyWorktreeError) return send(res, 409, { error: e.message, state: e.state }, origin);
      return send(res, 500, { error: (e as Error).message }, origin);
    }
  }

  // POST /api/tasks/:slug/handoff — generate a HANDOFF.md brief (write-gated)
  // GET  /api/tasks/:slug/handoff — read the current brief
  const hm = path.match(/^\/api\/tasks\/([^/]+)\/handoff$/);
  if (hm && method === 'POST') {
    if (!opts.writeEnabled) return send(res, 403, { error: 'read-only', hint: 'start: baton serve --write' }, origin);
    const slug = decodeURIComponent(hm[1]);
    let body: { toAgent?: string; note?: string; commitPending?: boolean } = {};
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return send(res, 400, { error: 'invalid JSON body' }, origin);
    }
    try {
      const brief = await passTask(slug, { to: body.toAgent ?? 'any', note: body.note, commitPending: body.commitPending }, root);
      if (!brief) return send(res, 404, { error: `no task '${slug}'` }, origin);
      return send(res, 201, { slug, toAgent: brief.meta.to, estTokens: brief.meta.est_tokens, estCostUsd: brief.meta.est_cost_usd, briefPath: brief.path, markdown: brief.markdown }, origin);
    } catch (e) {
      return send(res, 500, { error: (e as Error).message }, origin);
    }
  }
  if (hm && method === 'GET') {
    const slug = decodeURIComponent(hm[1]);
    const task = await getTask(root, slug);
    if (!task) return send(res, 404, { error: `no task '${slug}'` }, origin);
    const brief = await readBrief(task.worktreePath);
    if (!brief) return send(res, 404, { error: 'no handoff brief' }, origin);
    return send(res, 200, { slug, meta: brief.meta, body: brief.body }, origin);
  }

  // POST /api/tasks/:slug/merge — merge branch into current (write-gated)
  const mm = path.match(/^\/api\/tasks\/([^/]+)\/merge$/);
  if (mm && method === 'POST') {
    if (!opts.writeEnabled) return send(res, 403, { error: 'read-only', hint: 'start: baton serve --write' }, origin);
    const slug = decodeURIComponent(mm[1]);
    let body: { squash?: boolean; archive?: boolean } = {};
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return send(res, 400, { error: 'invalid JSON body' }, origin);
    }
    try {
      return send(res, 200, await mergeTaskBranch(slug, body, root), origin);
    } catch (e) {
      if (e instanceof TaskNotFoundError) return send(res, 404, { error: e.message }, origin);
      if (e instanceof MergeConflictError) {
        return send(res, 409, { error: 'merge conflicts', conflicts: e.conflicts.map((c) => ({ path: c.path, label: c.label })) }, origin);
      }
      return send(res, 500, { error: (e as Error).message }, origin);
    }
  }

  send(res, 404, { error: 'not found' }, origin);
}

export async function serve(portOrOpts: number | ServeOptions): Promise<void> {
  const opts: ServeOptions = typeof portOrOpts === 'number' ? { port: portOrOpts } : portOrOpts;
  const root = await gitRoot();
  poller = new StatusPoller(root);
  const watcher = new WorktreeWatcher(root);
  await watcher.start();
  new SignalTracker(root).start();
  const server = createServer((req, res) => {
    void handle(req, res, root, opts).catch((e) =>
      send(res, 500, { error: (e as Error).message }, corsOrigin(req)),
    );
  });

  await new Promise<void>((resolve) => server.listen(opts.port, '127.0.0.1', resolve));
  console.log(`baton serve → http://localhost:${opts.port}`);
  console.log('  GET /api/status · /api/history · /api/meta · /api/tasks/:slug · /api/events (SSE) · /api/kb   POST /api/tasks   (Ctrl+C to stop)');
}
