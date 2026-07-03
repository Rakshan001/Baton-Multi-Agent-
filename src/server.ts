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
import { extname, join, normalize, relative, sep } from 'node:path';
import { collectStatus } from './board.js';
import { collectDiff } from './diff.js';
import { currentBranch, isGitRepo } from './git.js';
import { listHistory } from './history.js';
import { loadTasks, resolveBatonRoot, TaskNotFoundError } from './store.js';
import { createTask, EmptyTaskError, ProjectRequiredError, UnknownProjectError } from './commands/new.js';
import { mergeTaskBranch, MergeConflictError } from './commands/merge.js';
import { removeTaskWorktree, MainWorktreeError, DirtyWorktreeError } from './commands/rm.js';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { buildGraph, detectGraphify, mergeGraphs, update } from './kb/graphify.js';
import { ensureGraphifyIgnores } from './kb/graphifyignore.js';
import { buildQueue, kbStatus, loadKb, saveKb } from './kb/state.js';
import { allSnippets } from './kb/mcp.js';
import { collectAgents } from './agents/roster.js';
import { connectAgentMcp, McpConfigParseError, McpUnsupportedError } from './agents/connect.js';
import { KNOWN_AGENT_IDS } from './agents/registry.js';
import {
  importSkill, installSkill, listSkillStatus, uninstallSkill,
  SkillAgentUnsupportedError, SkillImportError, SkillNotFoundError,
} from './skills/install.js';
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
import { loadRouting, suggestRoute } from './routing.js';
import { detectTar, importKb, stageForExport } from './kb/transfer.js';
import { BATON_VERSION } from './version.js';
import { usageForRepo } from './usage.js';
import { AgentRunningError, HEADLESS_AGENTS, runningHeadless, startAgent, stopAgent, TerminalConflictError } from './spawn.js';
import {
  captureScreen, createTerminal, detectTmux, getScrollback, hasTerminal, killTerminal, listTerminals,
  reattachOrphans, resizeTerminal, writeInput,
  HeadlessConflictError, TerminalRunningError, TerminalUnavailableError, INTERACTIVE_AGENTS,
} from './terminals.js';
import {
  bulkRemoveMemory, gcMemories, listMemories, loadRetention, mainRepoRoot, memoryDir,
  MemoryValidationError, pruneMemories, removeMemory, retentionActive, saveMemory, saveRetention,
  type ProjectRel, type RetentionPolicy,
} from './memory.js';
import { storageUsage } from './storage.js';
import { purgePreview, purgeStorage, sanitizeCategories } from './purge.js';
import { watch } from 'node:fs';
import { execa } from 'execa';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, rmdir } from 'node:fs/promises';
import { auditJunk, cleanJunk, sweepTmpFiles } from './cleanup.js';
import { basename } from 'node:path';
import { isLoopbackOrigin, isMutatingMethod } from './util/origin.js';

const require = createRequire(import.meta.url);
const VERSION = BATON_VERSION;

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
  // Headers are already sent, so an error mid-stream (file truncated/deleted after
  // stat, EIO, or the client disconnecting) can only be answered by tearing down the
  // socket — never let it become an uncaught exception that kills the daemon.
  const rs = createReadStream(file);
  rs.on('error', () => res.destroy());
  res.on('error', () => rs.destroy());
  rs.pipe(res);
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

  // Raw terminal bytes flow only on the per-session stream; the global feed
  // carries the low-volume terminal.started/exited markers.
  const unsub = bus.onAny((e) => {
    if (e.event.type === 'terminal.output') return;
    write(e.id, e.event.type, e.event);
  });
  const release = poller?.retain() ?? (() => undefined);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsub();
    release();
  });
}

/**
 * GET /api/tasks/:slug/terminal/stream — per-session SSE byte stream.
 * One snapshot frame (the scrollback ring) so late joiners see the current
 * screen, then live terminal.output frames. Readable on a read-only daemon.
 */
async function handleTerminalStream(req: IncomingMessage, res: ServerResponse, slug: string, origin: string): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const write = (type: string, data: unknown) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

  // Subscribe first and buffer live frames until the snapshot is sent, so the
  // async capture below can't let a delta arrive before its base screen.
  let ready = false;
  const queued: Array<() => void> = [];
  const emit = (fn: () => void) => (ready ? fn() : queued.push(fn));
  const unsub = bus.onAny((e) => {
    const ev = e.event;
    if ((ev.type === 'terminal.output' || ev.type === 'terminal.exited' || ev.type === 'terminal.started') && ev.slug === slug) {
      emit(() => write(ev.type, ev));
    }
  });
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsub();
  });

  // A fresh capture beats the stored ring: it shows the current screen even when
  // the agent's first paint was missed by control mode (the blank-terminal bug).
  const snapshot = (await captureScreen(slug)) ?? getScrollback(slug);
  write('terminal.snapshot', { slug, data: (snapshot ?? Buffer.alloc(0)).toString('base64') });
  ready = true;
  for (const fn of queued.splice(0)) fn();
}

/** Echo a loopback Origin so the Vite dev server (any localhost port) works; deny others. */
function corsOrigin(req: IncomingMessage): string {
  const origin = req.headers.origin;
  if (origin && isLoopbackOrigin(origin)) return origin;
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

/** Single definition of the write-gate response — every mutating route uses it. */
function denyReadOnly(res: ServerResponse, origin: string): void {
  send(res, 403, { error: 'read-only', hint: 'start: baton serve --write' }, origin);
}

/** Parse a JSON request body; null = malformed (route replies 400). */
async function readJsonBody<T>(req: IncomingMessage): Promise<T | null> {
  try {
    const raw = await readBody(req);
    return (raw ? JSON.parse(raw) : {}) as T;
  } catch {
    return null;
  }
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

/** kb sub-projects as (id, path-relative-to-main-root) for per-server memory scoping.
 *  Returns [] for a single-project repo (nothing to scope). */
async function kbProjectRels(root: string): Promise<ProjectRel[]> {
  try {
    const mainRoot = await mainRepoRoot(root);
    const kb = await loadKb(mainRoot);
    if (!kb || kb.projects.length < 2) return [];
    return kb.projects.map((p) => ({ id: p.id, rel: relative(mainRoot, p.path) || '.' }));
  } catch {
    return [];
  }
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

  // Anti-CSRF (applies to EVERY state-changing /api request, not just one route).
  // The daemon is loopback-bound and its CORS policy never lets a third-party
  // site READ a response — but a browser still SENDS a cross-origin "simple"
  // POST (a text/plain body the JSON parser still accepts), and that side effect
  // would run before CORS blocks the unreadable reply. So a malicious page you
  // visit could fire e.g. POST /api/tasks/:slug/agent/start (launch an agent with
  // an attacker prompt) at localhost. Require a loopback Origin for all mutating
  // methods; the legit dashboard (same-origin or :5173) and curl (no Origin) pass.
  if (isMutatingMethod(method) && path.startsWith('/api/') && !isLoopbackOrigin(req.headers.origin)) {
    return send(res, 403, { error: 'cross-origin request refused' }, origin);
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
  // GET /api/usage — real token usage parsed from Claude Code session files
  if (method === 'GET' && path === '/api/usage') {
    return send(res, 200, await usageForRepo(root, await loadTasks(root)), origin);
  }

  // GET /api/routing[?task=…] — routing config + severity-ranked suggestion
  if (method === 'GET' && path === '/api/routing') {
    const { config, path: configPath, errors } = await loadRouting(root);
    const taskText = url.searchParams.get('task');
    return send(res, 200, {
      config,
      path: configPath,
      errors,
      suggestion: taskText ? suggestRoute(taskText, config) : null,
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
        mapTokens: p.mapTokens ?? null, repoTokens: p.repoTokens ?? null,
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
    const rs = createReadStream(graphPath);
    rs.on('error', () => res.destroy());
    res.on('error', () => rs.destroy());
    rs.pipe(res);
    return;
  }

  // POST /api/kb/rebuild — queue an incremental (or full) rebuild (write-gated)
  if (method === 'POST' && path === '/api/kb/rebuild') {
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    const state = await loadKb(root);
    if (!state) return send(res, 404, { error: 'knowledge base not initialized', hint: 'run: baton kb init' }, origin);
    const body = await readJsonBody<{ project?: string; full?: boolean }>(req);
    if (!body) return send(res, 400, { error: 'invalid JSON body' }, origin);
    const targets = body.project ? state.projects.filter((p) => p.id === body.project) : state.projects;
    if (body.project && targets.length === 0) return send(res, 404, { error: `no project '${body.project}'` }, origin);
    // Self-heal .graphifyignore (mirror .gitignore) before rebuilding.
    await ensureGraphifyIgnores([root, ...targets.map((p) => p.path)]);
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
    // Client cancelling the download makes res emit EPIPE/ECONNRESET; without a
    // listener that crashes the daemon. Tear down the other side on either error.
    child.stdout?.on('error', () => res.destroy());
    res.on('error', () => child.kill());
    child.stdout?.pipe(res);
    const cleanup = () => void rm(staging, { recursive: true, force: true });
    child.once('exit', cleanup);
    req.once('close', () => child.kill());
    return;
  }

  // POST /api/kb/import — raw .tar.gz body (write-gated, 200MB cap)
  if (method === 'POST' && path === '/api/kb/import') {
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
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
      // Remove the upload, then the now-empty tmp dir (non-recursive: harmless
      // failure if a concurrent upload is mid-flight). The startup sweep is the
      // backstop for files a crashed request never reached this finally for.
      void rm(upload, { force: true }).then(() => rmdir(tmpDir).catch(() => undefined));
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
    const tmuxOk = await detectTmux();
    // A multi-repo hub root isn't a git repo; tasks must target a sub-project.
    const rootIsRepo = await isGitRepo(root);
    const kb = rootIsRepo ? null : await loadKb(root);
    const hubProjects = kb?.projects.map((p) => ({ id: p.id, name: p.name })) ?? [];
    return send(res, 200, {
      repo: root, branch: rootIsRepo ? await currentBranch(root) : null,
      writeEnabled: !!opts.writeEnabled, version: VERSION,
      // In a hub, the dashboard must ask which project a new task targets.
      hub: !rootIsRepo, projects: hubProjects,
      agents: { headless: HEADLESS_AGENTS, interactive: INTERACTIVE_AGENTS },
      terminals: tmuxOk
        ? { available: true }
        : { available: false, hint: process.platform === 'darwin' ? 'brew install tmux' : 'apt install tmux' },
    }, origin);
  }

  if (method === 'POST' && path === '/api/tasks') {
    let parsed: { task?: unknown; project?: unknown };
    try {
      parsed = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return send(res, 400, { error: 'invalid JSON body' }, origin);
    }
    const text = typeof parsed.task === 'string' ? parsed.task : '';
    const project = typeof parsed.project === 'string' && parsed.project ? parsed.project : undefined;
    try {
      const task = await createTask(text, root, project);
      return send(res, 201, task, origin);
    } catch (e) {
      if (e instanceof EmptyTaskError) return send(res, 400, { error: e.message }, origin);
      // A hub needs a chosen sub-project — 400 with the valid ids so the UI can prompt.
      if (e instanceof ProjectRequiredError) return send(res, 400, { error: e.message, projects: e.projects }, origin);
      if (e instanceof UnknownProjectError) return send(res, 400, { error: e.message }, origin);
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
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    const slug = decodeURIComponent(m[1]);
    const force = url.searchParams.get('force') === 'true';
    try {
      // A live agent process holds the worktree cwd and fights `git worktree remove`.
      await killTerminal(slug);
      stopAgent(slug);
      return send(res, 200, await removeTaskWorktree(slug, { force }, root), origin);
    } catch (e) {
      if (e instanceof TaskNotFoundError) return send(res, 404, { error: e.message }, origin);
      if (e instanceof MainWorktreeError) return send(res, 400, { error: e.message }, origin);
      if (e instanceof DirtyWorktreeError) return send(res, 409, { error: e.message, state: e.state }, origin);
      return send(res, 500, { error: (e as Error).message }, origin);
    }
  }

  // GET /api/tasks/:slug/diff — real changes vs the task's base (commits + working tree)
  const mDiff = path.match(/^\/api\/tasks\/([^/]+)\/diff$/);
  if (mDiff && method === 'GET') {
    const slug = decodeURIComponent(mDiff[1]);
    const task = (await loadTasks(root)).find((t) => t.slug === slug);
    if (!task) return send(res, 404, { error: `no task '${slug}'` }, origin);
    return send(res, 200, { files: await collectDiff(task) }, origin);
  }

  // GET /api/agents — the roster: installed? drivable? MCP wired? live sessions?
  if (method === 'GET' && path === '/api/agents') {
    return send(res, 200, { agents: await collectAgents(root) }, origin);
  }

  // GET /api/agents/running — baton-managed headless agent runs
  if (method === 'GET' && path === '/api/agents/running') {
    return send(res, 200, { running: runningHeadless() }, origin);
  }

  // POST /api/agents/:id/connect — wire an agent's MCP config (write-gated).
  // Project files write immediately; global files need { confirmGlobal: true }
  // and otherwise return a preview the UI confirms first.
  const acm = path.match(/^\/api\/agents\/([^/]+)\/connect$/);
  if (acm && method === 'POST') {
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    const agent = decodeURIComponent(acm[1]);
    if (!KNOWN_AGENT_IDS.includes(agent)) return send(res, 404, { error: `unknown agent '${agent}'` }, origin);
    const body = (await readJsonBody<{ confirmGlobal?: boolean }>(req)) ?? {};
    try {
      const state = await loadKb(root);
      const result = await connectAgentMcp(agent, root, state, { confirmGlobal: body.confirmGlobal === true });
      if (result.wrote) bus.publish({ type: 'agent.connected', agent });
      return send(res, 200, result, origin);
    } catch (e) {
      if (e instanceof McpUnsupportedError) return send(res, 400, { error: e.message }, origin);
      if (e instanceof McpConfigParseError) return send(res, 409, { error: e.message }, origin);
      return send(res, 500, { error: (e as Error).message }, origin);
    }
  }

  // GET /api/skills — the catalog (bundled + imported) with per-agent install state
  if (method === 'GET' && path === '/api/skills') {
    return send(res, 200, { skills: await listSkillStatus(root), agents: ['claude', 'cursor'] }, origin);
  }

  // POST /api/skills/import — add a skill from a path or http(s) URL (write-gated)
  if (method === 'POST' && path === '/api/skills/import') {
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    const body = await readJsonBody<{ source?: string }>(req);
    if (!body) return send(res, 400, { error: 'invalid JSON body' }, origin);
    try {
      const s = await importSkill(root, body.source ?? '');
      // Strip reference content / raw; expose only what the catalog listing carries.
      const skill = { id: s.id, name: s.name, description: s.description, tags: s.tags, produces: s.produces, body: s.body, source: s.source, references: s.references.map((r) => r.rel) };
      return send(res, 201, { skill }, origin);
    } catch (e) {
      if (e instanceof SkillImportError) return send(res, 400, { error: e.message }, origin);
      return send(res, 500, { error: (e as Error).message }, origin);
    }
  }

  // POST/DELETE /api/skills/:id/install — install (write) or uninstall a skill for an agent
  const skm = path.match(/^\/api\/skills\/([^/]+)\/install$/);
  if (skm && (method === 'POST' || method === 'DELETE')) {
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    const id = decodeURIComponent(skm[1]);
    const agent = (method === 'POST'
      ? (await readJsonBody<{ agent?: string }>(req))?.agent
      : url.searchParams.get('agent')) ?? '';
    try {
      if (method === 'DELETE') {
        return send(res, 200, await uninstallSkill(root, id, agent), origin);
      }
      const result = await installSkill(root, id, agent);
      bus.publish({ type: 'skill.installed', skill: id, agent });
      return send(res, 201, result, origin);
    } catch (e) {
      if (e instanceof SkillNotFoundError) return send(res, 404, { error: e.message }, origin);
      if (e instanceof SkillAgentUnsupportedError) return send(res, 400, { error: e.message }, origin);
      return send(res, 500, { error: (e as Error).message }, origin);
    }
  }

  // GET /api/doctor — audit junk (orphaned worktrees/branches/tmux/temp files). Read-only.
  if (method === 'GET' && path === '/api/doctor') {
    return send(res, 200, await auditJunk(root), origin);
  }
  // POST /api/doctor/clean — reclaim junk (write-gated). Dry-run unless { apply: true }.
  if (method === 'POST' && path === '/api/doctor/clean') {
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    const body = (await readJsonBody<{ apply?: boolean; force?: boolean }>(req)) ?? {};
    const report = await auditJunk(root);
    const result = await cleanJunk(root, report, { apply: body.apply === true, force: body.force === true });
    if (result.applied && result.removed.length) bus.publish({ type: 'junk.cleaned', count: result.removed.length });
    return send(res, 200, result, origin);
  }

  // GET /api/memory — all facts with evidence-checked freshness + per-server scoping
  if (method === 'GET' && path === '/api/memory') {
    const projects = await kbProjectRels(root);
    return send(res, 200, { facts: await listMemories(root, { projects }), projects }, origin);
  }
  // POST /api/memory — quick-add from the dashboard (write-gated)
  if (method === 'POST' && path === '/api/memory') {
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    const body = await readJsonBody<{ fact?: string; type?: string; files?: string[]; agent?: string; task?: string }>(req);
    if (!body) return send(res, 400, { error: 'invalid JSON body' }, origin);
    try {
      const saved = await saveMemory(root, { fact: body.fact ?? '', type: body.type, files: body.files, agent: body.agent ?? 'dashboard', task: body.task });
      bus.publish({ type: 'memory.updated' });
      return send(res, 201, saved, origin);
    } catch (e) {
      if (e instanceof MemoryValidationError) return send(res, 400, { error: e.message }, origin);
      return send(res, 500, { error: (e as Error).message }, origin);
    }
  }
  // POST /api/memory/gc — drop stale facts (write-gated)
  if (method === 'POST' && path === '/api/memory/gc') {
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    const removed = await gcMemories(root);
    if (removed.length) bus.publish({ type: 'memory.updated' });
    return send(res, 200, { removed }, origin);
  }
  // POST /api/memory/bulk-delete — delete many facts at once (write-gated)
  if (method === 'POST' && path === '/api/memory/bulk-delete') {
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    const body = await readJsonBody<{ ids?: unknown }>(req);
    const ids = Array.isArray(body?.ids) ? body!.ids.filter((x): x is string => typeof x === 'string') : null;
    if (!ids) return send(res, 400, { error: 'pass { ids: string[] }' }, origin);
    const removed = await bulkRemoveMemory(root, ids);
    if (removed.length) bus.publish({ type: 'memory.updated' });
    return send(res, 200, { removed }, origin);
  }
  // POST /api/memory/prune — apply a retention policy now (write-gated)
  if (method === 'POST' && path === '/api/memory/prune') {
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    const body = (await readJsonBody<RetentionPolicy>(req)) ?? {};
    const removed = await pruneMemories(root, body);
    if (removed.length) bus.publish({ type: 'memory.updated' });
    return send(res, 200, { removed }, origin);
  }
  // GET/POST /api/memory/retention — read or set the auto-retention policy (POST write-gated)
  if (path === '/api/memory/retention') {
    if (method === 'GET') return send(res, 200, await loadRetention(root), origin);
    if (method === 'POST') {
      if (!opts.writeEnabled) return denyReadOnly(res, origin);
      const body = (await readJsonBody<RetentionPolicy>(req)) ?? {};
      const saved = await saveRetention(root, body);
      // Apply immediately so the user sees the effect; future runs apply on daemon start.
      const removed = retentionActive(saved) ? await pruneMemories(root, saved) : [];
      if (removed.length) bus.publish({ type: 'memory.updated' });
      return send(res, 200, { policy: saved, removed }, origin);
    }
  }
  // DELETE /api/memory/:id (write-gated)
  const memDel = path.match(/^\/api\/memory\/([^/]+)$/);
  if (memDel && method === 'DELETE') {
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    const ok = await removeMemory(root, decodeURIComponent(memDel[1]));
    if (ok) bus.publish({ type: 'memory.updated' });
    return send(res, ok ? 200 : 404, ok ? { removed: true } : { error: 'no such memory' }, origin);
  }

  // GET /api/storage — disk footprint (memory / history / reports / graphs)
  if (method === 'GET' && path === '/api/storage') {
    return send(res, 200, await storageUsage(root), origin);
  }

  // GET /api/storage/purge — preview what a purge would permanently delete (read-only)
  if (method === 'GET' && path === '/api/storage/purge') {
    return send(res, 200, await purgePreview(root), origin);
  }

  // POST /api/storage/purge — permanently delete selected data + reclaim git objects.
  // Triple-guarded: --write, a loopback Origin (anti-CSRF, also enforced globally
  // above — kept here as explicit defense-in-depth), and a typed confirm phrase.
  if (method === 'POST' && path === '/api/storage/purge') {
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    if (!isLoopbackOrigin(req.headers.origin)) return send(res, 403, { error: 'cross-origin request refused' }, origin);
    const body = await readJsonBody<{ categories?: unknown; confirm?: string }>(req);
    if (!body) return send(res, 400, { error: 'invalid JSON body' }, origin);
    const categories = sanitizeCategories(body.categories);
    if (!categories.length) return send(res, 400, { error: 'no valid categories selected' }, origin);
    const preview = await purgePreview(root);
    if ((body.confirm ?? '').trim() !== preview.confirmPhrase) {
      return send(res, 400, { error: `confirmation mismatch — type "${preview.confirmPhrase}" exactly to proceed` }, origin);
    }
    const result = await purgeStorage(root, categories);
    if (categories.includes('memory')) bus.publish({ type: 'memory.updated' });
    return send(res, 200, result, origin);
  }

  // GET /api/terminals — capability + live interactive sessions (adopts tmux orphans)
  if (method === 'GET' && path === '/api/terminals') {
    const available = await detectTmux();
    // Adopting tmux orphans spawns control clients — a state change. A read GET
    // shouldn't let a cross-origin page trigger it; only do it for loopback callers.
    if (available && isLoopbackOrigin(req.headers.origin)) await reattachOrphans(root);
    return send(res, 200, {
      available,
      ...(available ? {} : { hint: process.platform === 'darwin' ? 'brew install tmux' : 'apt install tmux' }),
      terminals: listTerminals(),
    }, origin);
  }

  // /api/tasks/:slug/terminal[/input|resize|stream] — interactive terminal control
  const tm = path.match(/^\/api\/tasks\/([^/]+)\/terminal(?:\/(input|resize|stream))?$/);
  if (tm) {
    const slug = decodeURIComponent(tm[1]);
    const sub = tm[2];
    // After a daemon restart the tmux session may outlive the in-memory map.
    // Mutating methods already passed the loopback-Origin gate above; for the
    // read-only stream GET, only adopt orphans for loopback callers (not a
    // cross-origin page that merely opened the EventSource).
    if (!hasTerminal(slug) && isLoopbackOrigin(req.headers.origin) && (await detectTmux())) await reattachOrphans(root);

    if (!sub && method === 'POST') {
      if (!opts.writeEnabled) return denyReadOnly(res, origin);
      const body = await readJsonBody<{ agent?: string; model?: string; prompt?: string; cols?: number; rows?: number }>(req);
      if (!body) return send(res, 400, { error: 'invalid JSON body' }, origin);
      try {
        return send(res, 201, await createTerminal(slug, body, root), origin);
      } catch (e) {
        if (e instanceof TerminalUnavailableError) return send(res, 503, { error: e.message, hint: process.platform === 'darwin' ? 'brew install tmux' : 'apt install tmux' }, origin);
        if (e instanceof TerminalRunningError || e instanceof HeadlessConflictError) return send(res, 409, { error: e.message }, origin);
        return send(res, 400, { error: (e as Error).message }, origin);
      }
    }
    if (!sub && method === 'DELETE') {
      if (!opts.writeEnabled) return denyReadOnly(res, origin);
      return send(res, 200, { killed: await killTerminal(slug) }, origin);
    }
    if (sub === 'input' && method === 'POST') {
      if (!opts.writeEnabled) return denyReadOnly(res, origin);
      const body = await readJsonBody<{ data?: string }>(req);
      if (!body) return send(res, 400, { error: 'invalid JSON body' }, origin);
      if (typeof body.data !== 'string') return send(res, 400, { error: 'pass { data: base64 }' }, origin);
      const ok = writeInput(slug, Buffer.from(body.data, 'base64'));
      return ok
        ? send(res, 200, { written: true }, origin)
        : send(res, 404, { error: `no live terminal for '${slug}'` }, origin);
    }
    if (sub === 'resize' && method === 'POST') {
      if (!opts.writeEnabled) return denyReadOnly(res, origin);
      const body = await readJsonBody<{ cols?: number; rows?: number }>(req);
      if (!body) return send(res, 400, { error: 'invalid JSON body' }, origin);
      const ok = await resizeTerminal(slug, Number(body.cols), Number(body.rows));
      return send(res, ok ? 200 : 404, ok ? { resized: true } : { error: `no live terminal for '${slug}'` }, origin);
    }
    if (sub === 'stream' && method === 'GET') {
      return handleTerminalStream(req, res, slug, origin);
    }
  }

  // POST /api/tasks/:slug/agent/start|stop — headless agent control (write-gated)
  const am = path.match(/^\/api\/tasks\/([^/]+)\/agent\/(start|stop)$/);
  if (am && method === 'POST') {
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    const slug = decodeURIComponent(am[1]);
    if (am[2] === 'stop') {
      return send(res, 200, { stopped: stopAgent(slug) }, origin);
    }
    if (hasTerminal(slug)) {
      return send(res, 409, { error: `an interactive terminal is already open for '${slug}' — close it before starting a headless run` }, origin);
    }
    const body = await readJsonBody<{ agent?: string; model?: string; prompt?: string }>(req);
    if (!body) return send(res, 400, { error: 'invalid JSON body' }, origin);
    try {
      return send(res, 201, await startAgent(slug, body, root), origin);
    } catch (e) {
      if (e instanceof AgentRunningError || e instanceof TerminalConflictError) return send(res, 409, { error: e.message }, origin);
      return send(res, 400, { error: (e as Error).message }, origin);
    }
  }

  // POST /api/tasks/:slug/handoff — generate a HANDOFF.md brief (write-gated)
  // GET  /api/tasks/:slug/handoff — read the current brief
  const hm = path.match(/^\/api\/tasks\/([^/]+)\/handoff$/);
  if (hm && method === 'POST') {
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    const slug = decodeURIComponent(hm[1]);
    const body = await readJsonBody<{ toAgent?: string; model?: string; note?: string; commitPending?: boolean }>(req);
    if (!body) return send(res, 400, { error: 'invalid JSON body' }, origin);
    try {
      // toAgent absent or "auto" → routed by baton.config.json rules + severity
      const result = await passTask(slug, { to: body.toAgent, model: body.model, note: body.note, commitPending: body.commitPending }, root);
      if (!result) return send(res, 404, { error: `no task '${slug}'` }, origin);
      const { brief, routed, skipped } = result;
      return send(res, 201, {
        slug, toAgent: brief.meta.to, model: brief.meta.model ?? null,
        routed: routed !== null, matched: routed?.matched ?? [],
        severity: routed?.severity ?? null, tier: routed?.tier ?? null,
        signals: routed?.signals ?? [], confidence: routed?.confidence ?? null,
        skipped,
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
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    const slug = decodeURIComponent(mm[1]);
    const body = await readJsonBody<{ squash?: boolean; archive?: boolean }>(req);
    if (!body) return send(res, 400, { error: 'invalid JSON body' }, origin);
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
  // The Baton root owns `.baton/` — a single git repo OR a (non-git) multi-repo hub.
  const root = await resolveBatonRoot();
  poller = new StatusPoller(root);
  const watcher = new WorktreeWatcher(root);
  await watcher.start();
  new SignalTracker(root).start();
  // Conservative startup sweep: delete only provably-dead temp files + stale
  // uploads (never worktrees/branches/tmux). Best-effort, like the watcher below.
  void sweepTmpFiles(root).catch(() => undefined);
  // Apply any saved memory-retention policy once at startup (best-effort).
  void loadRetention(root)
    .then((p) => (retentionActive(p) ? pruneMemories(root, p) : []))
    .then((removed) => { if (removed.length) bus.publish({ type: 'memory.updated' }); })
    .catch(() => undefined);

  // Interactive terminals survive daemon restarts (tmux owns the PTY) — adopt
  // any that belong to this repo, and kill them when their task goes away.
  void detectTmux().then((ok) => (ok ? reattachOrphans(root) : undefined)).catch(() => undefined);
  bus.onType('task.removed', (e) => {
    if (e.event.type === 'task.removed') void killTerminal(e.event.slug);
  });
  // Memory facts are written by separate MCP processes (one per agent session);
  // watch the store so the dashboard updates live. Debounced — saves touch 2 paths.
  try {
    const memDirPath = memoryDir(await mainRepoRoot(root));
    await mkdir(memDirPath, { recursive: true });
    let memTimer: ReturnType<typeof setTimeout> | null = null;
    const memWatcher = watch(memDirPath, () => {
      if (memTimer) clearTimeout(memTimer);
      memTimer = setTimeout(() => bus.publish({ type: 'memory.updated' }), 300);
    });
    // FSWatcher emits 'error' asynchronously (dir removed/recreated, EMFILE); an
    // unhandled one crashes the daemon. Swallow it, matching watch.ts's idiom.
    memWatcher.on('error', () => undefined);
  } catch { /* memory watching is best-effort */ }
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
  console.log('  API: /api/status · /api/history · /api/meta · /api/tasks/:slug · /api/events (SSE) · /api/kb · /api/doctor   (Ctrl+C to stop)');
}
