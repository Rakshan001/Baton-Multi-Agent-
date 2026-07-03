# Shared Graphify Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-agent `uv → graphify.serve` stdio spawns (6 Python processes × every connected agent = ~720MB–1.8GB on a 5-project hub) with **one shared graphify HTTP server per project, owned by the Baton daemon, lazily started and idle-reaped**, so all agents connect over a single stable daemon route.

**Architecture:** The daemon exposes `POST /mcp/g/<token>/<projectId>` routes. On first request for a project it lazily spawns `graphify.serve --transport http --stateless --json-response` on a free loopback port, waits for readiness, then proxies the JSON-RPC body and pipes the JSON response back (verified: graphify 1.28.1 is fully stateless in this mode — a lone `tools/list` POST returns the tool set with no handshake). An idle reaper kills a backend after 15 min without traffic; all backends die on daemon shutdown. Agent MCP configs point at the daemon route instead of spawning Python.

**Tech Stack:** TypeScript (strict), `node:http` (proxy) + `node:net` (free port) + `node:child_process`/`execa` (spawn), `node:crypto` (token), vitest.

## Global Constraints

- Zero-dependency daemon: no new npm packages. `execa` + `node:*` only.
- Graph queries now REQUIRE `baton serve` running (approved trade). Coordination (`baton mcp`) stays stdio and standalone — unchanged.
- Backends bind `127.0.0.1` only; the daemon route is guarded by a persisted per-repo token (`.baton/mcp-token`) so a malicious local web page can't read the graph.
- Strict TS; `npm run build` + `npx vitest run` green after every task (255 baseline).
- **Git rules (user's):** every commit step requires the user's explicit approval first; author = Rakshan001; NO `Co-Authored-By` trailer; never push.
- Test style: `test/hub.test.ts` conventions (mkdtemp, real dirs, afterEach cleanup). Tests that spawn graphify must guard on `uv` being present and be skippable in CI.

---

### Task 1: `McpServerDef` becomes stdio | http; config writers handle both

**Files:**
- Modify: `src/kb/mcp.ts` (widen `McpServerDef`)
- Modify: `src/agents/connect.ts:151-170` (`mergeTomlConfig` emits `url` blocks)
- Test: `test/mcp-config.test.ts`

**Interfaces:**
- Produces: `export type McpServerDef = { command: string; args: string[] } | { type: 'http'; url: string }`
- Consumes (unchanged): `mergeJsonConfig`, `mergeTomlConfig` in connect.ts

- [ ] **Step 1: Write the failing test**

```ts
// test/mcp-config.test.ts
import { describe, it, expect } from 'vitest';
import { mergeJsonConfig, mergeTomlConfig } from '../src/agents/connect.js';

describe('mergeJsonConfig with an http server def', () => {
  it('writes a { type, url } entry verbatim', () => {
    const out = JSON.parse(mergeJsonConfig('{}', {
      'graphify-merged': { type: 'http', url: 'http://127.0.0.1:7077/mcp/g/abc/merged' },
    }));
    expect(out.mcpServers['graphify-merged']).toEqual({ type: 'http', url: 'http://127.0.0.1:7077/mcp/g/abc/merged' });
  });
  it('still writes a stdio { command, args } entry', () => {
    const out = JSON.parse(mergeJsonConfig('{}', { baton: { command: 'baton', args: ['mcp'] } }));
    expect(out.mcpServers.baton).toEqual({ command: 'baton', args: ['mcp'] });
  });
});

describe('mergeTomlConfig with an http server def', () => {
  it('emits url for http servers and command/args for stdio', () => {
    const toml = mergeTomlConfig('', {
      'graphify-merged': { type: 'http', url: 'http://127.0.0.1:7077/mcp/g/abc/merged' },
      baton: { command: 'baton', args: ['mcp'] },
    });
    expect(toml).toContain('url = "http://127.0.0.1:7077/mcp/g/abc/merged"');
    expect(toml).toContain('command = "baton"');
  });
});
```

- [ ] **Step 2: Run to verify FAIL** — `npx vitest run test/mcp-config.test.ts` → FAIL (http entries not handled)

- [ ] **Step 3: Implement**

In `src/kb/mcp.ts` replace the interface:
```ts
export type McpServerDef =
  | { command: string; args: string[] }
  | { type: 'http'; url: string };
```
(Leave `mcpServers()` as-is for now — Task 4 rewrites it. The JSON path in connect.ts already spreads defs verbatim, so `mergeJsonConfig` needs no change.)

In `src/agents/connect.ts` `mergeTomlConfig`, branch per def (current code assumes command/args):
```ts
    for (const [name, def] of Object.entries(servers)) {
      if (seen.has(name)) continue;
      const block = 'url' in def
        ? [`[mcp_servers.${tomlKey(name)}]`, `url = ${tomlStr(def.url)}`, '']
        : [`[mcp_servers.${tomlKey(name)}]`, `command = ${tomlStr(def.command)}`,
           `args = [${def.args.map(tomlStr).join(', ')}]`, ''];
      lines.push(...block);
    }
```
(Match the existing `tomlKey`/`tomlStr` helper names — read the file; if they differ, use the real ones. If Codex TOML doesn't support `url`, that's flagged in Task 4 docs — still emit it.)

- [ ] **Step 4: Run tests** — new test + `npm run build && npx vitest run` green

- [ ] **Step 5: Commit (ask the user first)**

```bash
git add src/kb/mcp.ts src/agents/connect.ts test/mcp-config.test.ts
git commit -m "refactor(mcp): McpServerDef supports http url defs alongside stdio"
```

---

### Task 2: Free-port helper + backend process manager

**Files:**
- Create: `src/kb/graphify-server.ts`
- Test: `test/graphify-server.test.ts`

**Interfaces:**
- Produces:
```ts
export interface Backend { projectId: string; port: number; lastAccess: number; }
export function freePort(): Promise<number>
export class GraphifyPool {
  constructor(graphFor: (id: string) => string | null, opts?: { idleMs?: number });
  ensure(projectId: string): Promise<number>;   // lazy spawn + wait ready → port
  note(projectId: string): void;                  // stamp lastAccess
  reapIdle(now?: number): Promise<string[]>;      // kill idle backends → ids reaped
  shutdown(): Promise<void>;                       // kill all
  ports(): Backend[];                              // introspection/tests
}
```
- Consumes: `execa`; `graphFor` maps a projectId → absolute graph.json path (Task 3 supplies it from KbState); `probeHttp(port)` readiness

- [ ] **Step 1: Write the failing test** (guarded on `uv`)

```ts
// test/graphify-server.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { freePort, GraphifyPool } from '../src/kb/graphify-server.js';
import { probeBinary } from '../src/util/exec.js';

const MERGED = '/Users/rakshanshetty/Desktop/Developer/work/FAT_FOX/.baton/kb/merged-graph.json';
const hasUv = await probeBinary('uv', ['--version']);
const canRun = hasUv && existsSync(MERGED);

let pool: GraphifyPool | null = null;
afterEach(async () => { await pool?.shutdown(); pool = null; });

describe('freePort', () => {
  it('returns a bindable loopback port', async () => {
    const p = await freePort();
    expect(p).toBeGreaterThan(1024); expect(p).toBeLessThan(65536);
  });
});

describe.runIf(canRun)('GraphifyPool', () => {
  it('lazily starts a backend and answers tools/list, then reaps on idle', async () => {
    pool = new GraphifyPool(() => MERGED, { idleMs: 50 });
    const port = await pool.ensure('merged');
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const body = await res.json() as { result?: { tools?: { name: string }[] } };
    expect(body.result?.tools?.map((t) => t.name)).toContain('query_graph');
    expect(pool.ports().length).toBe(1);
    // idle reap (idleMs=50): after a pause, lastAccess is old → reaped
    await new Promise((r) => setTimeout(r, 80));
    const reaped = await pool.reapIdle();
    expect(reaped).toContain('merged');
    expect(pool.ports().length).toBe(0);
  }, 30_000);

  it('ensure() on an already-running backend returns the same port (no respawn)', async () => {
    pool = new GraphifyPool(() => MERGED, { idleMs: 60_000 });
    const a = await pool.ensure('merged');
    const b = await pool.ensure('merged');
    expect(a).toBe(b);
    expect(pool.ports().length).toBe(1);
  }, 30_000);
});
```

- [ ] **Step 2: Run to verify FAIL** — module not found (uv-gated tests skip if no uv, but freePort test still fails → module missing)

- [ ] **Step 3: Implement**

```ts
// src/kb/graphify-server.ts
/**
 * Shared graphify backends: one HTTP graphify.serve process per project,
 * lazily started and idle-reaped, so N agents share 1 process instead of each
 * spawning their own 6 (the RAM explosion the perf audit measured). --stateless
 * --json-response makes each backend a plain request/response server the daemon
 * can proxy without session affinity or SSE.
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

interface Live extends Backend { proc: ResultPromise; }

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
    const proc = execa('uv', [
      'run', '--with', 'graphifyy', '--with', 'mcp', '-m', 'graphify.serve',
      '--transport', 'http', '--host', '127.0.0.1', '--port', String(port),
      '--stateless', '--json-response', graph,
    ], { stdout: 'ignore', stderr: 'ignore', env: { ...process.env } });
    proc.catch(() => undefined).finally(() => { this.live.delete(projectId); });
    try {
      await waitReady(port);
    } catch (e) {
      proc.kill('SIGTERM');
      throw e;
    }
    this.live.set(projectId, { projectId, port, lastAccess: Date.now(), proc });
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
        b.proc.kill('SIGTERM');
        this.live.delete(id);
        reaped.push(id);
      }
    }
    return reaped;
  }

  async shutdown(): Promise<void> {
    for (const b of this.live.values()) b.proc.kill('SIGTERM');
    this.live.clear();
  }

  ports(): Backend[] {
    return [...this.live.values()].map(({ projectId, port, lastAccess }) => ({ projectId, port, lastAccess }));
  }
}
```

- [ ] **Step 4: Run tests** — `npx vitest run test/graphify-server.test.ts` (uv-gated ones run locally). Full suite green.

- [ ] **Step 5: Commit (ask the user first)**

```bash
git add src/kb/graphify-server.ts test/graphify-server.test.ts
git commit -m "feat(kb): shared graphify backend pool (lazy start + idle reap)"
```

---

### Task 3: Daemon proxy route + token + lifecycle wiring

**Files:**
- Create: `src/kb/mcp-token.ts` (persisted per-repo token)
- Modify: `src/server.ts` (proxy route before the `/api/` guard; pool lifecycle in `serve()`; reaper interval; shutdown)
- Test: `test/mcp-token.test.ts` + a proxy integration test `test/graphify-proxy.test.ts` (uv-gated)

**Interfaces:**
- Consumes: `GraphifyPool` (Task 2), `loadKb`/`graphPathFor` (state.js), `resolveBatonRoot` (store.js)
- Produces: `getMcpToken(root: string): string` (creates `.baton/mcp-token` once, 16-byte hex) · daemon route `POST /mcp/g/<token>/<projectId>`

- [ ] **Step 1: Failing test — token**

```ts
// test/mcp-token.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getMcpToken } from '../src/kb/mcp-token.js';

let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

it('creates a stable 32-hex-char token once and reuses it', async () => {
  root = await mkdtemp(join(tmpdir(), 'baton-tok-'));
  await mkdir(join(root, '.baton'), { recursive: true });
  const a = getMcpToken(root);
  expect(a).toMatch(/^[0-9a-f]{32}$/);
  expect(getMcpToken(root)).toBe(a); // stable across calls (persisted)
  expect((await readFile(join(root, '.baton', 'mcp-token'), 'utf-8')).trim()).toBe(a);
});
```

- [ ] **Step 2: Verify FAIL** · **Step 3: Implement token**

```ts
// src/kb/mcp-token.ts
/** Per-repo secret embedded in the daemon's graphify proxy URL, so only clients
 *  holding Baton's written MCP config (not a random local web page) can query
 *  the graph. Persisted so it survives daemon restarts (configs stay valid). */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { batonDir } from '../store.js';

export function getMcpToken(root: string): string {
  const file = join(batonDir(root), 'mcp-token');
  try {
    const t = readFileSync(file, 'utf-8').trim();
    if (/^[0-9a-f]{32}$/.test(t)) return t;
  } catch { /* create below */ }
  const token = randomBytes(16).toString('hex');
  mkdirSync(batonDir(root), { recursive: true });
  writeFileSync(file, token + '\n', { mode: 0o600 });
  return token;
}
```

- [ ] **Step 4: Wire the proxy route in `src/server.ts`**

Near the top of `handle()`, BEFORE the `/api/` origin guard and BEFORE the `/api/` routing (the route is `/mcp/...`, deliberately outside `/api`):

```ts
  // Shared graphify proxy: POST /mcp/g/<token>/<projectId> → the lazily-started
  // backend for that project. Token-gated (a web page can't read .baton/), loopback
  // only, read-only graph queries. Method must be POST (MCP streamable-http).
  const gm = path.match(/^\/mcp\/g\/([0-9a-f]{32})\/([A-Za-z0-9._-]+)$/);
  if (gm) {
    if (method !== 'POST') return send(res, 405, { error: 'POST only' }, origin);
    if (gm[1] !== getMcpToken(root)) return send(res, 403, { error: 'bad token' }, origin);
    return proxyGraphify(req, res, gm[2]);
  }
```

Add the proxy helper (module scope in server.ts), using the module-level `pool` (declared next to `poller`):

```ts
let graphPool: GraphifyPool | null = null;

async function proxyGraphify(req: IncomingMessage, res: ServerResponse, projectId: string): Promise<void> {
  if (!graphPool) return res.writeHead(503).end('graph pool not started');
  let port: number;
  try { port = await graphPool.ensure(projectId); }
  catch (e) { return res.writeHead(502).end(String((e as Error).message)); }
  graphPool.note(projectId);
  const body = await readBody(req); // reuses the 1MB-capped reader
  try {
    const upstream = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: body || '{}',
      signal: AbortSignal.timeout(30_000),
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' });
    res.end(text);
  } catch (e) {
    res.writeHead(504).end(String((e as Error).message));
  }
}
```

In `serve()`, after `const root = await resolveBatonRoot();`:
```ts
  const kb0 = await loadKb(root);
  graphPool = new GraphifyPool((id) => {
    if (id === 'merged') return kb0?.mergedGraphPath ?? null;
    const p = kb0?.projects.find((x) => x.id === id);
    return p ? graphPathFor(p.path) : null;
  });
  const reaper = setInterval(() => { void graphPool?.reapIdle(); }, 60_000);
  reaper.unref?.();
```
(If the KB can change while the daemon runs, re-`loadKb` inside the `graphFor` closure instead of capturing `kb0` — prefer that for correctness: `const kb = loadKbSync?...`. Simplest correct version: make `graphFor` read a cached KbState refreshed on `kb.rebuilt` bus events. For v1, capture at startup and document that `baton kb init` adding a project needs a daemon restart.)

Add shutdown: find where the daemon handles termination (grep `process.on` — if none, add one):
```ts
  const stop = () => { clearInterval(reaper); void graphPool?.shutdown(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
```

- [ ] **Step 5: Proxy integration test** (`test/graphify-proxy.test.ts`, uv+merged gated): start `serve()` on an ephemeral port against FAT_FOX root (or a temp KB), POST `tools/list` to `/mcp/g/<token>/merged`, assert `query_graph` in the tool list; POST with a wrong token → 403. Reuse the pattern from the launcher end-to-end verification. Keep it `describe.runIf(canRun)`.

- [ ] **Step 6: Run tests + build** — all green

- [ ] **Step 7: Commit (ask the user first)**

```bash
git add src/kb/mcp-token.ts src/server.ts test/mcp-token.test.ts test/graphify-proxy.test.ts
git commit -m "feat(kb): daemon graphify proxy route (token-gated, lazy backends)"
```

---

### Task 4: Config generation points at the shared route

**Files:**
- Modify: `src/kb/mcp.ts` (`mcpServers` builds http URLs; needs root+token+daemon port)
- Modify: `src/agents/connect.ts` (`serversForState` passes the new inputs), `src/commands/kb.ts` (wherever snippets are generated — grep `snippetFor`/`allSnippets` callers)
- Test: `test/mcp-config.test.ts` (extend)

**Interfaces:**
- Produces: `mcpServers(state, opts: { baseUrl: string; token: string }): Record<string, McpServerDef>` where graphify entries become `{ type: 'http', url: \`${baseUrl}/mcp/g/${token}/${id}\` }` and `baton` stays stdio.

- [ ] **Step 1: Failing test**

```ts
// add to test/mcp-config.test.ts
import { mcpServers } from '../src/kb/mcp.js';
it('mcpServers emits http urls for graphify and stdio for baton', () => {
  const state = { root: '/r', projects: [{ id: 'api', name: 'api', path: '/r/api', graphPath: '/r/api/g.json' }], mergedGraphPath: '/r/.baton/kb/m.json', lastBuiltAt: null } as any;
  const servers = mcpServers(state, { baseUrl: 'http://127.0.0.1:7077', token: 'a'.repeat(32) });
  expect(servers['graphify-api']).toEqual({ type: 'http', url: `http://127.0.0.1:7077/mcp/g/${'a'.repeat(32)}/api` });
  expect(servers['graphify-merged']).toEqual({ type: 'http', url: `http://127.0.0.1:7077/mcp/g/${'a'.repeat(32)}/merged` });
  expect(servers.baton).toEqual({ command: 'baton', args: ['mcp'] });
});
```

- [ ] **Step 2: Verify FAIL** · **Step 3: Implement**

Rewrite `mcpServers` in `src/kb/mcp.ts`:
```ts
export function mcpServers(state: KbState, opts: { baseUrl: string; token: string }): Record<string, McpServerDef> {
  const servers: Record<string, McpServerDef> = {};
  const url = (id: string) => `${opts.baseUrl}/mcp/g/${opts.token}/${id}`;
  for (const p of state.projects) servers[`graphify-${p.id}`] = { type: 'http', url: url(p.id) };
  if (state.mergedGraphPath) servers['graphify-merged'] = { type: 'http', url: url('merged') };
  servers['baton'] = { command: 'baton', args: ['mcp'] };
  return servers;
}
```
Update all snippet fns (`jsonSnippet`/`codexSnippet`/`geminiSnippet`/`snippetFor`/`allSnippets`) to thread `opts`. Update callers: `serversForState(state, opts)` in connect.ts, and the kb-init snippet writer in `src/commands/kb.ts` — they must supply `baseUrl` (default `http://127.0.0.1:${port}`, port from the daemon default 7077 or the kb-init `--port`) and `token = getMcpToken(root)`. Where config is written OUTSIDE a running daemon (baton kb init), use the default port 7077 and note it.

**Codex caveat:** if Codex's TOML MCP doesn't support `url` (verify against installed Codex or docs), keep Codex on stdio by special-casing it in `snippetFor('codex', …)` to still emit the `uv` spawn. Document in `docs/mcp-tools.md`. (Claude/Cursor/Gemini support http.)

- [ ] **Step 4: Run tests + build** — green

- [ ] **Step 5: Commit (ask the user first)**

```bash
git add src/kb/mcp.ts src/agents/connect.ts src/commands/kb.ts test/mcp-config.test.ts
git commit -m "feat(kb): agents connect to the shared graphify route over http"
```

---

### Task 5: Docs, STATUS, re-connect guidance

**Files:**
- Modify: `docs/mcp-tools.md`, `docs/knowledge-graph.md`, `docs/architecture.md` (the shared-server model + daemon dependency), `STATUS.md`
- Modify: `docs/troubleshooting.md` (graph tools need `baton serve`; how to re-run `connect` to migrate existing `.mcp.json` off stdio)

- [ ] **Step 1** Document: the daemon owns shared graphify HTTP servers; agents point at `/mcp/g/<token>/<id>`; graph queries require `baton serve`; existing setups must re-run `baton kb init` (or the Agents-screen Connect action) to rewrite `.mcp.json` from stdio to http; RAM before/after (cite the audit: ~720MB→~120MB). Add STATUS feature row + session entry.

- [ ] **Step 2: Manual verification** — the real proof:

```bash
npm run build && npx vitest run                    # all green
# live: point the daemon at FAT_FOX, connect claude, confirm ONE process set
( cd ~/Desktop/Developer/work/FAT_FOX && node ~/Desktop/Developer/playground/baton/dist/cli.js serve --write --port 7079 ) &
sleep 3
# simulate two agents hitting two projects; then count graphify processes
TOKEN=$(cat ~/Desktop/Developer/work/FAT_FOX/.baton/mcp-token)
for id in merged fatfox-api-server; do
  curl -s -X POST http://127.0.0.1:7079/mcp/g/$TOKEN/$id \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' >/dev/null; done
echo "graphify processes now: $(pgrep -f graphify.serve | wc -l)  (expect 2, shared — NOT 6×agents)"
pkill -f 'cli.js serve --write --port 7079'
```
Expected: 2 processes for 2 touched projects, shared regardless of agent count; idle ones reaped after 15 min.

- [ ] **Step 3: Commit (ask the user first)**

```bash
git add docs/ STATUS.md
git commit -m "docs(kb): document the shared graphify server + daemon dependency"
```

---

## Self-review notes (done at plan time)

- **Spec/decision coverage:** shared server ✅ (T2/T3) · lazy start ✅ (GraphifyPool.ensure) · idle reap ✅ (reapIdle + 60s interval) · daemon dependency accepted ✅ (documented T5) · token security ✅ (T3) · http config for agents ✅ (T4) · shutdown cleanup ✅ (T3). Merged-only option NOT taken (user chose lazy per-project).
- **Type consistency:** `McpServerDef` union defined T1, consumed by connect.ts (T1) and mcpServers (T4); `GraphifyPool` API defined T2, consumed by server.ts (T3); `getMcpToken` T3 consumed by server.ts route + mcpServers callers (T4).
- **Verified-not-assumed:** graphify `--transport http` boots + MCP `initialize` OK; `--stateless --json-response` → lone `tools/list` returns tools (no handshake) → trivial proxy; free-port pattern reused from setup.ts:101; graphify version 1.28.1.
- **Open judgment calls for the implementer (flagged inline):** exact `tomlKey`/`tomlStr` helper names in connect.ts; whether Codex TOML supports `url` (special-case to stdio if not); KB-changes-while-running (v1 captures KbState at startup — document restart-after-new-project); where the daemon's existing shutdown handler lives (add SIGINT/SIGTERM if absent).
- **Not in scope (future):** moving `baton mcp` coordination server to shared http (it's lightweight Node, one per agent — the Python explosion is the target); auto-migrating already-written `.mcp.json` files (T5 documents re-running connect).
