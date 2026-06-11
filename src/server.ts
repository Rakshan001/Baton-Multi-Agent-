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
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
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
import { refreshCodebaseDocs } from './kb/codebasemd.js';
import { loadRouting, suggestAgent } from './routing.js';
import { detectTar, importKb, stageForExport } from './kb/transfer.js';
import { execa } from 'execa';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { basename } from 'node:path';

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
 * Built dashboard location. Compiled server lives at dist/server.js, so
 * ../web/dist resolves to <repo>/web/dist; the same is true when running
 * from src/ via tsx.
 */
const WEB_DIST = fileURLToPath(new URL('../web/dist', import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/** Serve the built dashboard (SPA) for non-/api requests. Localhost-only by bind. */
async function serveStatic(req: IncomingMessage, res: ServerResponse, urlPath: string, origin: string): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { error: 'method not allowed' }, origin);
  }
  if (!existsSync(WEB_DIST)) {
    return send(res, 404, { error: 'dashboard not built', hint: 'run: npm run build --prefix web' }, origin);
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return send(res, 400, { error: 'bad path' }, origin);
  }
  if (decoded === '/') decoded = '/index.html';

  // Traversal guard: the resolved file must stay inside web/dist.
  let file = normalize(join(WEB_DIST, decoded));
  if (file !== WEB_DIST && !file.startsWith(WEB_DIST + sep)) {
    return send(res, 403, { error: 'forbidden' }, origin);
  }

  let st = await stat(file).catch(() => null);
  if (!st || st.isDirectory()) {
    // SPA fallback for routes; assets (anything with an extension) 404 plainly.
    if (extname(decoded)) return send(res, 404, { error: 'not found' }, origin);
    file = join(WEB_DIST, 'index.html');
    st = await stat(file).catch(() => null);
    if (!st) return send(res, 404, { error: 'dashboard not built', hint: 'run: npm run build --prefix web' }, origin);
  }

  const isIndex = file.endsWith(`${sep}index.html`);
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
    'Content-Length': st.size,
    // Vite hashes asset filenames, so assets are immutable; index.html must revalidate.
    'Cache-Control': isIndex ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  if (req.method === 'HEAD') return void res.end();
  createReadStream(file).pipe(res);
}

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
  // GET /api/routing[?task=…] — routing config + suggestion for a task text
  if (method === 'GET' && path === '/api/routing') {
    const { config, path: configPath, errors } = await loadRouting(root);
    const taskText = url.searchParams.get('task');
    return send(res, 200, {
      config,
      path: configPath,
      errors,
      suggestion: taskText ? suggestAgent(taskText, config) : null,
    }, origin);
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

  // GET /api/kb/export — stream the KB pack as a .tar.gz download
  if (method === 'GET' && path === '/api/kb/export') {
    const state = await loadKb(root);
    if (!state) return send(res, 404, { error: 'knowledge base not initialized', hint: 'run: baton kb init' }, origin);
    if (!(await detectTar())) return send(res, 500, { error: 'tar not found on PATH' }, origin);
    const staging = await stageForExport(root, state);
    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="baton-kb-${basename(root)}.tar.gz"`,
      'Access-Control-Allow-Origin': origin,
      'Vary': 'Origin',
    });
    const child = execa('tar', ['-czf', '-', '-C', staging, '.'], { buffer: false });
    child.stdout?.pipe(res);
    const cleanup = () => void rm(staging, { recursive: true, force: true });
    child.once('exit', cleanup);
    req.once('close', () => child.kill());
    return;
  }

  // POST /api/kb/import — raw .tar.gz body (write-gated, 200MB cap)
  if (method === 'POST' && path === '/api/kb/import') {
    if (!opts.writeEnabled) return send(res, 403, { error: 'read-only', hint: 'start: baton serve --write' }, origin);
    const tmpDir = join(root, '.baton', 'tmp');
    await mkdir(tmpDir, { recursive: true });
    const upload = join(tmpDir, `upload-${Date.now()}.tar.gz`);
    const MAX = 200 * 1024 * 1024;
    let bytes = 0;
    try {
      await new Promise<void>((resolvePromise, reject) => {
        const out = createWriteStream(upload);
        req.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX) {
            out.destroy();
            req.destroy();
            reject(new Error('upload exceeds 200MB'));
          }
        });
        req.pipe(out);
        out.on('finish', resolvePromise);
        out.on('error', reject);
        req.on('error', reject);
      });
      const result = await importKb(root, upload);
      for (const p of result.projects) {
        if (p.status === 'ok') bus.publish({ type: 'kb.rebuilt', project: p.id });
      }
      return send(res, 200, result, origin);
    } catch (e) {
      return send(res, 400, { error: (e as Error).message }, origin);
    } finally {
      void rm(upload, { force: true });
    }
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
      // toAgent absent or "auto" → routed by baton.config.json rules
      const result = await passTask(slug, { to: body.toAgent, note: body.note, commitPending: body.commitPending }, root);
      if (!result) return send(res, 404, { error: `no task '${slug}'` }, origin);
      const { brief, routed } = result;
      return send(res, 201, {
        slug, toAgent: brief.meta.to, model: brief.meta.model ?? null,
        routed: routed !== null, matched: routed?.matched ?? [],
        estTokens: brief.meta.est_tokens, estCostUsd: brief.meta.est_cost_usd,
        briefPath: brief.path, markdown: brief.markdown,
      }, origin);
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

  // Anything outside /api/* is the dashboard (SPA).
  if (!path.startsWith('/api/')) return serveStatic(req, res, path, origin);

  send(res, 404, { error: 'not found' }, origin);
}

export async function serve(portOrOpts: number | ServeOptions): Promise<void> {
  const opts: ServeOptions = typeof portOrOpts === 'number' ? { port: portOrOpts } : portOrOpts;
  const root = await gitRoot();
  poller = new StatusPoller(root);
  const watcher = new WorktreeWatcher(root);
  await watcher.start();
  new SignalTracker(root).start();
  // Keep CODEBASE.md in step with graph rebuilds. A multi-project rebuild
  // fires several kb.rebuilt events — debounce so we regenerate once.
  let docsTimer: ReturnType<typeof setTimeout> | null = null;
  bus.onType('kb.rebuilt', () => {
    if (docsTimer) clearTimeout(docsTimer);
    docsTimer = setTimeout(() => {
      void loadKb(root).then((kb) => (kb ? refreshCodebaseDocs(root, kb) : undefined)).catch(() => undefined);
    }, 2000);
  });
  const server = createServer((req, res) => {
    void handle(req, res, root, opts).catch((e) =>
      send(res, 500, { error: (e as Error).message }, corsOrigin(req)),
    );
  });

  await new Promise<void>((resolve) => server.listen(opts.port, '127.0.0.1', resolve));
  if (existsSync(WEB_DIST)) {
    console.log(`baton serve → dashboard http://localhost:${opts.port}`);
  } else {
    console.log(`baton serve → http://localhost:${opts.port}  (dashboard not built — run: npm run build --prefix web)`);
  }
  console.log('  API: /api/status · /api/history · /api/meta · /api/tasks/:slug · /api/events (SSE) · /api/kb   (Ctrl+C to stop)');
}
