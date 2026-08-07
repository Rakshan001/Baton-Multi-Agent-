/**
 * Local JSON API for the Baton web dashboard. Binds to 127.0.0.1 only and
 * allows CORS from localhost origins — it exposes your repo's task data, so it
 * must never be reachable off-machine.
 *
 * Endpoints:
 *   GET    /api/status       → live board rows (collectStatus)
 *   GET    /api/sessions     → connected agents with no task worktree (collectPresence)
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
import { collectStatus, collectPresence, rootAgentSummary } from './board.js';
import { collectDiff } from './diff.js';
import { currentBranch, headCommit, isGitRepo } from './git.js';
import { countByAxis, isReviewStale, listReviews, openFindings, resolveFinding, reviewHeads } from './reviews.js';
import { listHistory, ingestGitLog } from './history.js';
import { batonDir, loadTasks, mutateTasks, resolveBatonRoot, TaskNotFoundError } from './store.js';
import { cancelTasks, claim, releaseClaim } from './lifecycle.js';
import { agentsStopped, blastRadius, type CancelScope, type PipelineTask } from './pipeline.js';
import { pipelineView } from './pipeline-view.js';
import { describeScope as scopeLabel, resolveScope } from './commands/cancel.js';
import { PLANS_DIR } from './commands/plan.js';
import { decideOperator } from './operator.js';
import { resolveGate } from './gate.js';
import { createTask, EmptyTaskError, ProjectRequiredError, UnknownProjectError } from './commands/new.js';
import { mergeTaskBranch, MergeConflictError } from './commands/merge.js';
import { removeTaskWorktree, MainWorktreeError, DirtyWorktreeError } from './commands/rm.js';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { buildGraph, detectGraphify, mergeGraphs, update } from './kb/graphify.js';
import { ensureGraphifyIgnores } from './kb/graphifyignore.js';
import { buildQueue, graphPathFor, kbStatus, loadKb, saveKb } from './kb/state.js';
import { graphFreshness, renderGraphFreshnessNote, injectFreshnessNote } from './kb/freshness.js';
import { allSnippets } from './kb/mcp.js';
import { collectAgents } from './agents/roster.js';
import { connectAgentMcp, McpConfigParseError, McpUnsupportedError } from './agents/connect.js';
import { agentsFor, knownAgentIdsFor } from './agents/registry.js';
import {
  importSkill, installSkill, installSkillEverywhere, listSkillStatus, uninstallSkill,
  SKILL_AGENTS, SkillAgentUnsupportedError, SkillImportError, SkillNotFoundError,
} from './skills/install.js';
import { bus } from './events.js';
import { WorktreeWatcher } from './watch.js';
import { StatusPoller } from './poller.js';
import { checkFiles, getSignals, isWatcherActive, liveSessions, SIGNAL_WINDOW_MIN, SignalTracker } from './signals.js';
import { holderProjects } from './conflicts.js';
import { getReport, listReports } from './reports.js';
import { queryFile } from './history.js';
import { passTask } from './commands/pass.js';
import { readBrief } from './handoff/brief.js';
import { listBriefs } from './handoff/resume.js';
import { getTask, projectOf } from './store.js';
import { refreshCodebaseDocs, refreshDocsIfStale } from './kb/codebasemd.js';
import { loadRouting, suggestRoute } from './routing.js';
import { agentActiveLoads, pickHandoffTarget } from './handoff/workload.js';
import { buildContextPack, UnknownProjectError as UnknownKbProjectError } from './kb/contextpack.js';
import { detectTar, importKb, stageForExport } from './kb/transfer.js';
import { BATON_VERSION } from './version.js';
import { usageForRepo } from './usage.js';
import { AgentRunningError, runningHeadless, startAgent, stopAgent, stopAllAgents, TerminalConflictError } from './spawn.js';
import {
  captureScreen, createTerminal, detectTmux, getScrollback, hasTerminal, killTerminal, listTerminals,
  reattachOrphans, resizeTerminal, writeInput,
  HeadlessConflictError, TerminalRunningError, TerminalUnavailableError,
} from './terminals.js';
import {
  bulkRemoveMemory, gcMemories, listMemories, loadRetention, mainRepoRoot, memoryAreas,
  MemoryValidationError, pruneMemories, removeMemory, repairMemories, retentionActive, saveMemory, saveRetention,
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
import {
  hostnameOf, isAllowedHostHeader, isAllowedOrigin, isLoopbackAddr, isLoopbackHost, isLoopbackOrigin,
  isMutatingMethod,
} from './util/origin.js';
import {
  EMPTY_REGISTRY, MemberError, addMember, clearTeamAssignments, hasActiveMembers, loadMembers,
  markTokenUsed, memberId as slugMemberId, revokeMember, rotateMember, setMemberTeam,
} from './members.js';
import {
  TeamError, addTeam, findTeam, loadTeams, removeTeam, teamId as slugTeamId, updateTeam,
} from './teams.js';
import {
  type DaemonRecord, listDaemonRecords, listVerifiedDaemons, removeDaemonRecord,
  removeDaemonRecordSync, stopDaemon, sweepDeadDaemonRecords, verifyDaemon, writeDaemonRecord,
} from './daemons.js';
import { buildManifest } from './commands/workspace.js';
import { assessReachability } from './reachability.js';
import { canSeeWarnings, decideAccess, requiresOwner, type AccessDecision } from './access.js';
import { localClaims, PresenceStore, PRESENCE_TTL_MS, type HeartbeatInput } from './federation.js';
import { loadHostLink, sendHeartbeat, type HeartbeatPayload } from './host-link.js';
import { remoteClaims, remoteHoldersFor, remoteNote } from './remote-claims.js';

/**
 * The host's view of connected members. In-memory and never persisted: truth
 * lives in git, and a claim restored from disk could outlive the agent that made
 * it — a stale claim is worse than none because it is believed.
 */
const federation = new PresenceStore();

/**
 * This machine's active edit signals, shaped as claims for a host.
 *
 * Only ACTIVE holders are published: a `settled` signal means the file was
 * touched recently but is now committed or reverted, which is explicitly not a
 * reason for anyone to wait. Paths stay repo-relative — an absolute path is
 * valid here and meaningless on every other machine, so publishing one would
 * make the claim silently match nothing.
 */
async function localClaimsPayload(root: string, device?: string): Promise<HeartbeatPayload> {
  const [signals, tasks, kb] = await Promise.all([getSignals(root), loadTasks(root), loadKb(root).catch(() => null)]);
  // Only tasks carry projectId; `co-*` checkouts and `sess-*` root sessions hold
  // paths too, and holderProjects recovers the id for those. See localClaims for
  // what publishing null cost, and why one claim per path was one too few.
  const claims = localClaims(signals, tasks, holderProjects(tasks, kb?.projects ?? [], liveSessions(root)));
  return { ...(device ? { device } : {}), sessions: new Set(signals.flatMap((s) => s.holders.map((h) => h.slug))).size, claims };
}

/** Default life of an un-redeemed invite. Long enough to survive a weekend,
 *  short enough that a forgotten link in a chat log stops being a key. */
const INVITE_HOURS = 72;

/** Member ids whose first use has been recorded this process — see the call site. */
const redeemed = new Set<string>();

/**
 * The one-line command an invited member pastes, and whether we actually know
 * the URL in it is reachable from anywhere but here.
 *
 * The daemon genuinely does not know how it is reachable. Behind a tunnel, a
 * port-forward, or NAT, its bind address is not the address anyone else uses,
 * and an owner minting an invite from the dashboard on the host machine sends a
 * request whose Host header is `localhost` — a URL that is useless to precisely
 * the person who cannot debug it.
 *
 * So, in order of how much the answer can be trusted:
 *
 * 1. A non-loopback `Host` header — the operator reached us by that name and it
 *    survived the allow-list check above, so it demonstrably routes here.
 * 2. A declared `--allowed-host` — the operator said this is how the daemon is
 *    reached. Not proven, but asserted deliberately.
 * 3. Otherwise: a placeholder, flagged `guessed`, so the UI can tell the owner
 *    to substitute the real address instead of shipping a broken command.
 *
 * `--host` is NOT used as a source: it is a bind address, and its most common
 * useful value (`0.0.0.0`) is a wildcard that means "every interface", not an
 * address anything can dial.
 */
function joinTarget(req: IncomingMessage, opts: ServeOptions): { url: string; guessed: boolean } {
  const host = (req.headers.host ?? '').trim();
  if (host && !isLoopbackHost(host)) return { url: `http://${host}`, guessed: false };
  const declared = (opts.allowedHosts ?? []).find((h) => h && !isLoopbackHost(h));
  const port = opts.port ?? 7077;
  if (declared) {
    return { url: hostnameOf(declared) === declared ? `http://${declared}:${port}` : `http://${declared}`, guessed: false };
  }
  return { url: `http://THIS-MACHINE:${port}`, guessed: true };
}

/**
 * Who an owner action is attributed to. A loopback caller has no member record
 * (none is required locally) but still has a name worth recording, because the
 * audit trail's job is to answer "who did this" and "someone at the keyboard"
 * is a real answer.
 */
function actorLabel(access: AccessDecision): string {
  if (!access.allow) return 'unknown';
  return access.member?.name ?? 'this machine';
}

/**
 * The roster: every registered member, merged with whatever the live plane
 * knows about them.
 *
 * Deliberately NOT owner-only. Knowing who is on the hub and what they are
 * editing is the entire point of the collaboration plane; hiding it from
 * non-owners would leave every member's agent working blind. `tokenHash` is
 * the one field never shaped into the response — it is not a secret, but it is
 * also not something any client has a use for.
 */
async function buildRoster(root: string, access: AccessDecision, now: number) {
  const [reg, teams] = await Promise.all([loadMembers(root), loadTeams(root)]);
  const teamIds = new Set(teams.map((t) => t.id));
  const presence = new Map(federation.presence(now).map((p) => [p.memberId, p]));
  const claims = federation.claims(now);
  const claimCount = new Map<string, number>();
  for (const c of claims) claimCount.set(c.memberId, (claimCount.get(c.memberId) ?? 0) + 1);

  // Owner sees every warning; a member only their own — the rule lives in
  // access.ts (canSeeWarnings) with the rest of the authorization boundary.
  const visibleWarnings = (id: string) =>
    canSeeWarnings(access, id) ? federation.warningsFor(id) : [];

  const rows = reg.members.map((m) => {
    const live = presence.get(m.id);
    return {
      id: m.id,
      name: m.name,
      role: m.role,
      registered: true,
      // Resolved against the teams that actually exist. members.json and
      // teams.json are written separately on purpose (src/teams.ts header), so
      // a pointer at a deleted team is expected and reads as "no team" — never
      // as a group heading naming something that is gone.
      team: m.team && teamIds.has(m.team) ? m.team : null,
      createdAt: m.createdAt,
      ...(m.revokedAt ? { revokedAt: m.revokedAt } : {}),
      // Invite state. Without these the roster cannot distinguish "invited, has
      // never turned up" from "a member who happens to be offline right now" —
      // and only one of those is something the owner needs to chase.
      ...(m.expiresAt ? { expiresAt: m.expiresAt } : {}),
      ...(m.firstUsedAt ? { firstUsedAt: m.firstUsedAt } : {}),
      online: !!live,
      device: live?.device ?? null,
      sessions: live?.sessions ?? 0,
      since: live?.since ?? null,
      lastSeen: live?.lastSeen ?? null,
      claims: claimCount.get(m.id) ?? 0,
      warnings: visibleWarnings(m.id),
    };
  });

  // A heartbeat from loopback registers as `local`, which is not in the
  // registry. Showing it as an unregistered row is more honest than dropping
  // it: those claims are real and appear in the who's-editing view either way.
  for (const [id, live] of presence) {
    if (rows.some((r) => r.id === id)) continue;
    rows.push({
      id, name: live.memberName, role: 'member', registered: false, team: null,
      createdAt: live.since, online: true, device: live.device, sessions: live.sessions,
      since: live.since, lastSeen: live.lastSeen, claims: claimCount.get(id) ?? 0,
      warnings: visibleWarnings(id),
    });
  }

  return {
    members: rows,
    teams,
    claims,
    overlaps: federation.allOverlaps(now),
    ttlMs: PRESENCE_TTL_MS,
    // The dashboard renders controls from this; the SERVER enforces it
    // independently on every owner endpoint. A hidden button is not a control.
    viewer: {
      local: access.allow ? access.local : false,
      memberId: access.allow ? (access.member?.id ?? null) : null,
      isOwner: !requiresOwner(access),
    },
  };
}
import { GraphifyPool } from './kb/graphify-server.js';
import { getMcpToken } from './kb/mcp-token.js';
import { SseGate } from './util/sse-gate.js';

const require = createRequire(import.meta.url);
const VERSION = BATON_VERSION;

interface ServeOptions {
  port: number;
  /** When true, advertise write capability to the dashboard (merge/remove land in a later phase). */
  writeEnabled?: boolean;
  /**
   * Bind address. Absent = 127.0.0.1, the local-first default and the only mode
   * that needs no credentials. Setting this exposes the daemon to a network and
   * makes a member token mandatory for every non-loopback request; `serve()`
   * refuses to start if no member exists (see the fail-closed check there).
   */
  host?: string;
  /**
   * Host header values to accept besides loopback and the bind address. Required
   * when reaching the daemon by a DNS name (Tailscale MagicDNS, a tunnel
   * hostname), because the anti-rebinding check compares the dialled name.
   */
  allowedHosts?: string[];
  /**
   * A reverse proxy on THIS machine forwards traffic to this port.
   *
   * Set it and loopback stops implying owner: the proxy dials the daemon from
   * 127.0.0.1, so without this every request that walked in off the public
   * internet is indistinguishable from the operator at the keyboard — which is
   * the entire member boundary, bypassed. Costs the operator their own
   * credential-free access (they need a member token like everyone else),
   * because no daemon can tell its proxy apart from its owner over one socket.
   */
  behindProxy?: boolean;
}

/** Lazily-started per-daemon live infrastructure (one per `serve()`). */
let poller: StatusPoller | null = null;

/**
 * Board rows for HTTP reads: ride the poller's fresh snapshot when a dashboard
 * is connected (one shared git scan per tick instead of ~10 spawns per task per
 * request), fall back to a direct collection when the poller is idle or stale.
 */
async function statusRows(root: string) {
  return poller?.snapshot() ?? collectStatus(root);
}

/** Shared graphify backend pool — started in serve(), null until then. */
let graphPool: GraphifyPool | null = null;

// Cap concurrent SSE streams — a stuck or hostile client must not grow the
// bus fan-out unboundedly. 64 covers any realistic number of dashboard tabs.
const MAX_SSE_STREAMS = 64;
const eventsGate = new SseGate(MAX_SSE_STREAMS);
const terminalGate = new SseGate(MAX_SSE_STREAMS);

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
  const releaseSlot = eventsGate.tryAcquire();
  if (!releaseSlot) return send(res, 429, { error: 'too many event streams' }, origin);

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
    releaseSlot();
  });
}

/**
 * GET /api/tasks/:slug/terminal/stream — per-session SSE byte stream.
 * One snapshot frame (the scrollback ring) so late joiners see the current
 * screen, then live terminal.output frames. Readable on a read-only daemon.
 */
async function handleTerminalStream(req: IncomingMessage, res: ServerResponse, slug: string, origin: string): Promise<void> {
  const releaseSlot = terminalGate.tryAcquire();
  if (!releaseSlot) return send(res, 429, { error: 'too many event streams' }, origin);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  // Slow-consumer policy: raw terminal bytes flow at full agent-output rate,
  // and a stalled tab (backgrounded, frozen laptop lid) accumulates all of it
  // in this process's socket buffer. Past the cap, drop the connection — a
  // reconnect gets a fresh snapshot, which is cheaper than unbounded heap.
  //
  // The drop cannot announce itself to the client: at this point the socket
  // already holds the backlog, so a final "you were dropped" frame is either
  // discarded by res.destroy() or forces a flush of all 4 MB — which is the
  // cost we are refusing to pay. The client detects the gap instead (an
  // EventSource error followed by a fresh snapshot; see TerminalPanel). This
  // log is for whoever has to explain why a terminal blinked.
  const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
  const write = (type: string, data: unknown) => {
    if (res.writableLength > MAX_BUFFERED_BYTES) {
      console.warn(`baton serve: terminal stream for '${slug}' dropped — consumer too slow (>4MB buffered). The client will resync on reconnect.`);
      res.destroy(); // fires req 'close' → heartbeat/unsub/slot cleanup below
      return;
    }
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

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
    releaseSlot();
  });

  // A fresh capture beats the stored ring: it shows the current screen even when
  // the agent's first paint was missed by control mode (the blank-terminal bug).
  const snapshot = (await captureScreen(slug)) ?? getScrollback(slug);
  write('terminal.snapshot', { slug, data: (snapshot ?? Buffer.alloc(0)).toString('base64') });
  ready = true;
  for (const fn of queued.splice(0)) fn();
}

/**
 * Echo a loopback Origin so the Vite dev server (any localhost port) works, plus
 * any name the operator declared with `--allowed-host` — otherwise a dashboard
 * served over `--host` cannot READ a single response it receives, and the whole
 * screen sits empty behind a CORS error no user could diagnose.
 *
 * Anything else gets the dev-server origin, which is a deliberate non-match: the
 * browser then refuses to hand the body to the calling page.
 */
function corsOrigin(req: IncomingMessage, opts?: ServeOptions): string {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin, opts ? allowedNames(opts) : [])) return origin;
  return 'http://localhost:5173';
}

/** Names the operator declared as ways to reach this daemon. `--host` counts:
 *  it is how you dial a daemon bound to a specific address. */
function allowedNames(opts: ServeOptions): string[] {
  return [...(opts.allowedHosts ?? []), ...(opts.host ? [opts.host] : [])];
}

/**
 * CORS headers every response carries. `Authorization` must be listed or the
 * browser's preflight fails and a token-carrying dashboard never sends a single
 * request — the failure looks like the daemon is down.
 */
const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
} as const;

function send(res: ServerResponse, status: number, body: unknown, origin: string): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin,
    ...CORS_HEADERS,
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
  });
  res.end(json);
}

/** Single definition of the write-gate response — every mutating route uses it. */
/**
 * May this caller act as the machine's OPERATOR — see and stop daemons, shut
 * this one down?
 *
 * Loopback is the normal proof. Under `--behind-proxy` loopback proves nothing
 * (that is the entire point of the flag), so the owner token stands in for it:
 * without this, turning the flag on made graceful shutdown unreachable by
 * anyone at all, including the person at the keyboard.
 *
 * A `--host` member never qualifies, owner or not — that boundary is unchanged.
 */
function isOperator(access: AccessDecision, opts: ServeOptions): boolean {
  if (access.allow && access.local) return true;
  return !!opts.behindProxy && !requiresOwner(access);
}

function denyReadOnly(res: ServerResponse, origin: string): void {
  send(res, 403, { error: 'read-only', hint: 'start: baton serve --write' }, origin);
}

/**
 * A cancel scope from a JSON body, or the message saying why the body does not
 * describe one.
 *
 * Delegates to the CLI's `resolveScope` rather than re-reading the flags here.
 * "Exactly one scope, never a guess" is a rule about what a cancellation MEANS,
 * not about argv — and a browser that could send `{ slug, phase }` and have the
 * daemon quietly pick one would stop work nobody confirmed, on the surface
 * where the confirmation is the entire safety mechanism.
 */
function scopeFromBody(body: { slug?: unknown; phase?: unknown; plan?: unknown } | null): CancelScope | string {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  // Numbers arrive as numbers over JSON and as strings on argv; normalising
  // here keeps the shared rule the only thing that decides validity.
  const phase = body?.phase === undefined || body?.phase === null ? undefined : String(body.phase);
  return resolveScope(str(body?.slug), { phase, plan: str(body?.plan) });
}

/**
 * The owner gate for member management. Points at the CLI in the hint on
 * purpose: an owner locked out of the dashboard still has `baton member` on the
 * host, so a leaked token can always be revoked even if this daemon is
 * read-only or the browser cannot reach it.
 */
function denyNotOwner(res: ServerResponse, origin: string): void {
  send(res, 403, {
    error: 'owner only',
    hint: 'the hub owner can also run: baton member revoke <id>',
  }, origin);
}

/**
 * Registry cache. Auth runs on every remote request, so the file is re-read only
 * when its mtime moves — which still makes `baton member revoke` take effect on
 * the very next request, with no session anywhere to invalidate.
 */
let membersCache: { mtimeMs: number; ino: number; reg: Awaited<ReturnType<typeof loadMembers>> } | null = null;

async function currentMembers(root: string) {
  const path = join(batonDir(root), 'members.json');
  let mtimeMs = -1;
  let ino = -1;
  try {
    ({ mtimeMs, ino } = await stat(path));
  } catch {
    membersCache = null; // file absent → nobody is authorized
    return await loadMembers(root);
  }
  // Keyed on inode as well as mtime: every save is a fresh tmp file renamed
  // into place, so the inode moves even when two writes land in the same
  // millisecond — the case where mtime alone would keep serving the first
  // write, and the second write could be the revocation.
  if (membersCache && membersCache.mtimeMs === mtimeMs && membersCache.ino === ino) return membersCache.reg;
  const reg = await loadMembers(root);
  membersCache = { mtimeMs, ino, reg };
  return reg;
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

/**
 * Proxy a POST /mcp/g/<token>/<projectId> request to the lazily-started
 * graphify backend for that project. Body is forwarded verbatim; the upstream
 * response (JSON or SSE text) is streamed back. All await paths are caught so
 * a backend crash can't bring down the daemon.
 */
async function proxyGraphify(req: IncomingMessage, res: ServerResponse, root: string, projectId: string): Promise<void> {
  if (!graphPool) return void res.writeHead(503).end('graph pool not started');
  let port: number;
  try { port = await graphPool.ensure(projectId); }
  catch (e) { return void res.writeHead(502).end(String((e as Error).message)); }
  graphPool.note(projectId);
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    return void res.writeHead(413).end('payload too large');
  }
  try {
    const upstream = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: body || '{}',
      signal: AbortSignal.timeout(30_000),
    });
    let text = await upstream.text();
    if (upstream.ok) {
      // G1 golden rule: a graph answer carries its own staleness warning, so an
      // agent never trusts symbols for files with uncommitted edits. Advisory —
      // any failure here must never break the answer itself.
      try {
        const state = await loadKb(root);
        const target = projectId === 'merged'
          ? (state?.mergedGraphPath ? { path: root, graphPath: state.mergedGraphPath } : null)
          : state?.projects.find((p) => p.id === projectId) ?? null;
        if (target) {
          const note = renderGraphFreshnessNote(await graphFreshness(target.path, target.graphPath));
          text = injectFreshnessNote(text, upstream.headers.get('content-type'), note);
        }
      } catch { /* freshness is advisory */ }
    }
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' });
    res.end(text);
  } catch (e) {
    res.writeHead(504).end(String((e as Error).message));
  }
}

/**
 * B2: ingest each kb project's real git history into a per-project bucket, so
 * commits made outside `baton merge` still appear in History/blame. Best-effort
 * — a project without git or an unreadable log just contributes nothing.
 */
async function ingestAllProjects(root: string): Promise<void> {
  try {
    const kb = await loadKb(root);
    if (!kb) return;
    for (const p of kb.projects) {
      await ingestGitLog(root, { slug: `git:${p.id}`, task: `${p.name} · direct commits`, cwd: p.path, projectId: p.id }).catch(() => 0);
    }
  } catch { /* ingestion is best-effort — never break the daemon */ }
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

/** Warn the operator once per rejected name — a silent 403 is undiagnosable. */
const hostWarned = new Set<string>();

function isAllowedHost(host: string | undefined | null, opts: ServeOptions): boolean {
  const allowed = [...(opts.allowedHosts ?? []), ...(opts.host ? [opts.host] : [])];
  if (isAllowedHostHeader(host, allowed)) return true;
  const name = host ? hostnameOf(host) : '(absent)';
  if (opts.host && !hostWarned.has(name)) {
    hostWarned.add(name);
    console.warn(
      `baton serve: refused a request for Host '${name}' — add it with --allowed-host ${name} if that is how you reach this daemon.`,
    );
  }
  return false;
}

async function handle(req: IncomingMessage, res: ServerResponse, root: string, opts: ServeOptions): Promise<void> {
  const origin = corsOrigin(req, opts);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // Anti-DNS-rebinding — FIRST, and on EVERY request including reads, because
  // this is the one attack the Origin guard below structurally cannot see. A page
  // on evil.com re-points its DNS at 127.0.0.1; the browser then treats us as
  // same-origin, sends no cross-origin Origin, and CORS never engages — so the
  // reads sailed through and handed over the repo's task list, branch names and
  // file paths. Origin can't help (absent Origin is legitimately allowed for curl
  // and same-origin), but Host can: the browser sets it to the name it dialled
  // and script cannot forge it. Reject before routing so no handler, static file
  // or SSE stream is reachable under a rebound name.
  //
  // When `--host` exposes the daemon deliberately, loopback is no longer the
  // only legitimate name — but the check cannot simply be dropped, or a rebound
  // page could reach a daemon on a LAN/tailnet address just as easily. So the
  // allowed set widens to exactly what the operator declared, and nothing else.
  if (!isAllowedHost(req.headers.host, opts)) {
    return send(res, 403, { error: 'forbidden' }, origin);
  }

  // CORS preflight — answered BEFORE the auth gate, and it has to be. A browser
  // never puts an Authorization header on a preflight, so gating OPTIONS would
  // 401 it and the real request would never be sent at all: a token-carrying
  // dashboard would look exactly like a daemon that is down. The reply discloses
  // nothing but this policy, and reaching here already required an allowed Host.
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      ...CORS_HEADERS,
      'Access-Control-Max-Age': '600',
      'Vary': 'Origin',
    });
    res.end();
    return;
  }

  // The authorization boundary — one pure decision, defined and tested in
  // src/access.ts. A loopback connection is unaffected (no credential); anything
  // over a network needs a member token and can never reach a terminal.
  //
  // Under --behind-proxy a loopback peer is NOT trusted, so it also needs the
  // real registry: handing decideAccess an empty one there would fail every
  // token and lock the daemon out of itself.
  const trustLoopback = !opts.behindProxy;
  const skipRegistry = trustLoopback && isLoopbackAddr(req.socket.remoteAddress);
  const access = decideAccess(
    { remoteAddr: req.socket.remoteAddress, path, authorization: req.headers.authorization, trustLoopback },
    skipRegistry ? EMPTY_REGISTRY() : await currentMembers(root),
  );
  if (!access.allow) {
    if (access.challenge) res.setHeader('WWW-Authenticate', 'Bearer realm="baton"');
    return send(res, access.status, { error: access.error, ...(access.hint ? { hint: access.hint } : {}) }, origin);
  }
  // Redeeming an invite retires its deadline (see members.ts). Written once,
  // ever, per member — the in-memory guard keeps a burst of concurrent requests
  // from racing to make the same write while the mtime cache is still warm.
  if (access.member && !access.member.firstUsedAt && !redeemed.has(access.member.id)) {
    redeemed.add(access.member.id);
    void markTokenUsed(root, access.member.id).catch(() => redeemed.delete(access.member!.id));
  }

  // Shared graphify proxy: POST /mcp/g/<token>/<projectId> → the lazily-started
  // backend for that project. Token-gated (a web page can't read .baton/), loopback
  // only, read-only graph queries. Method must be POST (MCP streamable-http).
  // Intentionally outside /api/ so the CSRF Origin guard below doesn't apply;
  // the 32-hex token is the auth gate instead.
  const gm = path.match(/^\/mcp\/g\/([0-9a-f]{32})\/([A-Za-z0-9._-]+)$/);
  if (gm) {
    if (method !== 'POST') return send(res, 405, { error: 'POST only' }, origin);
    if (gm[1] !== getMcpToken(root)) return send(res, 403, { error: 'bad token' }, origin);
    return proxyGraphify(req, res, root, gm[2]);
  }

  // Anti-CSRF (applies to EVERY state-changing /api request, not just one route).
  // The daemon is loopback-bound and its CORS policy never lets a third-party
  // site READ a response — but a browser still SENDS a cross-origin "simple"
  // POST (a text/plain body the JSON parser still accepts), and that side effect
  // would run before CORS blocks the unreadable reply. So a malicious page you
  // visit could fire e.g. POST /api/tasks/:slug/agent/start (launch an agent with
  // an attacker prompt) at localhost. Require a loopback Origin for all mutating
  // methods; the legit dashboard (same-origin or :5173) and curl (no Origin) pass.
  //
  // Under `--host` the legit dashboard's own Origin is a declared name rather
  // than loopback, so the allowed set widens to exactly those names — never a
  // wildcard. evil.com is still refused by name, and a remote request still needs
  // a member token, which no cross-site page can obtain: nothing here rides on
  // ambient credentials, so there is no cookie for a browser to attach for it.
  if (isMutatingMethod(method) && path.startsWith('/api/') && !isAllowedOrigin(req.headers.origin, allowedNames(opts))) {
    return send(res, 403, { error: 'cross-origin request refused' }, origin);
  }

  if (method === 'GET' && path === '/api/events') return handleEvents(req, res, origin);

  // GET /api/signals — live edit signals across all worktrees. The board is the
  // one consumer that wants recently-settled edits too ("X finished editing Y
  // 2m ago"); every coordination caller sticks to the active-only default.
  /*
   * POST /api/presence/heartbeat — a member daemon reporting in.
   *
   * The body is a FULL statement of what that member currently holds, so a file
   * they stopped editing disappears without needing a release message that could
   * be lost. Identity comes from the auth layer, never from the body: a member
   * cannot report presence as somebody else.
   */
  if (method === 'POST' && path === '/api/presence/heartbeat') {
    const body = await readJsonBody<HeartbeatInput>(req);
    if (!body) return send(res, 400, { error: 'invalid JSON body' }, origin);
    // A loopback caller has no member record (none is required locally); it
    // registers as `local`, which is mainly useful for testing and for a host
    // that wants to appear in its own roster.
    const actor = access.member
      ? { id: access.member.id, name: access.member.name }
      : { id: 'local', name: 'this machine' };

    const now = Date.now();
    const r = federation.heartbeat(actor, body, now);
    if (r.joined) bus.publish({ type: 'member.joined', memberId: actor.id, memberName: actor.name });
    for (const relPath of r.opened) {
      bus.publish({ type: 'claim.opened', memberId: actor.id, relPath, projectId: null });
    }
    for (const relPath of r.released) {
      bus.publish({ type: 'claim.released', memberId: actor.id, relPath, projectId: null });
    }
    for (const o of r.overlaps) {
      bus.publish({
        type: 'claim.conflict', relPath: o.relPath, projectId: o.projectId,
        sameBranch: o.sameBranch, memberIds: o.holders.map((h) => h.memberId),
      });
    }
    if (r.joined || r.opened.length || r.released.length) {
      bus.publish({ type: 'member.presence', online: federation.presence(now).length });
    }
    return send(res, 200, {
      ok: true,
      // Echoed back so a member sees the shared picture without a second call.
      members: federation.presence(now),
      claims: federation.claims(now),
      overlaps: r.overlaps,
      // Owner notices ride the response because it is the only channel that
      // reliably reaches a member's daemon — it is the one that opened it.
      warnings: r.warnings,
      ttlMs: PRESENCE_TTL_MS,
    }, origin);
  }

  // GET /api/presence — the roster + live claims, for the dashboard and for
  // `check_files` on a member that is online.
  if (method === 'GET' && path === '/api/presence') {
    const now = Date.now();
    return send(res, 200, {
      members: federation.presence(now),
      claims: federation.claims(now),
      overlaps: federation.allOverlaps(now),
      ttlMs: PRESENCE_TTL_MS,
      /*
       * Who is asking, as resolved from their token.
       *
       * Load-bearing for `check_files`: a member polling this endpoint gets
       * back the claims IT published moments earlier, and without knowing its
       * own id it would report its own edits as a teammate holding the file.
       * The host is the only party that can answer this, since identity comes
       * from the token and never from anything the caller says about itself.
       */
      you: { memberId: access.allow ? (access.member?.id ?? null) : null },
    }, origin);
  }

  // GET /api/members — the membership roster: who exists, who is online, what
  // they hold. Registry + live plane in one payload so the Team screen renders
  // from a single poll.
  if (method === 'GET' && path === '/api/members') {
    return send(res, 200, await buildRoster(root, access, Date.now()), origin);
  }

  /*
   * POST /api/members — mint an invite.
   *
   * The token is returned exactly once, here. Nothing stores it, so a closed tab
   * means rotating rather than looking it up — which is the property that makes
   * "shown once" true rather than decorative.
   */
  if (method === 'POST' && path === '/api/members') {
    if (requiresOwner(access)) return denyNotOwner(res, origin);
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    const body = await readJsonBody<{ name?: string; role?: string; expiresInHours?: number }>(req);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) return send(res, 400, { error: 'a name is required' }, origin);
    const hours = Number.isFinite(body?.expiresInHours)
      ? Math.max(1, Math.min(720, Math.floor(body!.expiresInHours as number)))
      : INVITE_HOURS;
    try {
      const { member, token } = await addMember(root, name, body?.role === 'owner' ? 'owner' : 'member', {
        expiresInMs: hours * 3600_000,
      });
      bus.publish({ type: 'member.joined', memberId: member.id, memberName: member.name });
      const target = joinTarget(req, opts);
      return send(res, 200, {
        member: { id: member.id, name: member.name, role: member.role, expiresAt: member.expiresAt },
        token,
        command: `npx baton join ${target.url} --token ${token}`,
        // Flagged rather than papered over: an invite naming an address the
        // invitee cannot reach fails on the one machine nobody here can debug.
        urlGuessed: target.guessed,
        expiresAt: member.expiresAt,
        note: target.guessed
          ? 'Replace THIS-MACHINE with the address teammates use to reach this host, then send it over a private channel — the token is shown only once.'
          : 'This command carries a live credential. Send it over a private channel, and it is shown only once.',
      }, origin);
    } catch (e) {
      if (e instanceof MemberError) return send(res, 409, { error: e.message }, origin);
      throw e;
    }
  }

  // POST /api/members/:id/rotate — reissue, invalidating the previous token.
  // A replace, never an addition: two live tokens for one identity would make
  // revoking the leaked one guesswork.
  const rotateM = path.match(/^\/api\/members\/([^/]+)\/rotate$/);
  if (rotateM && method === 'POST') {
    if (requiresOwner(access)) return denyNotOwner(res, origin);
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    try {
      const { member, token } = await rotateMember(root, decodeURIComponent(rotateM[1]), {
        expiresInMs: INVITE_HOURS * 3600_000,
      });
      const target = joinTarget(req, opts);
      return send(res, 200, {
        member: { id: member.id, name: member.name, role: member.role, expiresAt: member.expiresAt },
        token,
        command: `npx baton join ${target.url} --token ${token}`,
        urlGuessed: target.guessed,
        expiresAt: member.expiresAt,
        note: 'Their previous token stopped working the moment this one was created.',
      }, origin);
    } catch (e) {
      if (e instanceof MemberError) return send(res, 409, { error: e.message }, origin);
      throw e;
    }
  }

  /*
   * Teams (Phase 8, src/teams.ts).
   *
   * Owner-only and write-gated, like every other control that changes who is
   * where. There is no GET: the roster already carries `teams`, and a second
   * endpoint returning the same list is a second thing to keep in step.
   *
   * Worth stating once at the boundary, because this is where someone would
   * later be tempted: a team's project scope reaches NO authorization decision.
   * It is not consulted by `decideAccess`, it does not filter `/api/kb`,
   * `/api/presence` or `check_files`, and it never hides a claim conflict.
   */
  if (method === 'POST' && path === '/api/teams') {
    if (requiresOwner(access)) return denyNotOwner(res, origin);
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    const body = await readJsonBody<{ name?: string; projects?: unknown }>(req);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) return send(res, 400, { error: 'a team needs a name' }, origin);
    // Refused rather than coerced: cleanProjectIds turns any non-array into
    // [], and an empty scope means the WHOLE hub — a typo ("web,api" as one
    // string) must not silently widen what a team sees, with a 200 saying it
    // worked.
    if (body?.projects !== undefined && !Array.isArray(body.projects)) {
      return send(res, 400, { error: 'projects must be an array of project ids, e.g. ["api","web"]' }, origin);
    }
    try {
      const team = await addTeam(root, name, body?.projects ?? []);
      bus.publish({
        type: 'team.changed', action: 'created', teamId: team.id, teamName: team.name,
        by: actorLabel(access),
      });
      return send(res, 200, { team }, origin);
    } catch (e) {
      if (e instanceof TeamError) return send(res, 409, { error: e.message }, origin);
      throw e;
    }
  }

  const teamM = path.match(/^\/api\/teams\/([^/]+)$/);
  if (teamM && (method === 'POST' || method === 'DELETE')) {
    if (requiresOwner(access)) return denyNotOwner(res, origin);
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    const id = slugTeamId(decodeURIComponent(teamM[1]));
    if (!id) return send(res, 400, { error: 'no team id' }, origin);
    const by = actorLabel(access);
    try {
      if (method === 'DELETE') {
        const team = await removeTeam(root, id);
        // Second write, deliberately after the first: if this one fails the
        // members point at a team that no longer exists, which already reads as
        // "no team". The reverse order could leave a live team with nobody in
        // it and no error to explain why.
        const unassigned = await clearTeamAssignments(root, id);
        bus.publish({ type: 'team.changed', action: 'removed', teamId: team.id, teamName: team.name, by });
        return send(res, 200, {
          ok: true, team, unassigned,
          note: unassigned
            ? `${unassigned} member${unassigned === 1 ? '' : 's'} moved to no team. Nobody lost access — a team was only ever a grouping.`
            : 'Nobody was in it.',
        }, origin);
      }
      const body = await readJsonBody<{ name?: string; projects?: unknown }>(req);
      // Same refusal as create: a non-array would be coerced to [] = whole hub.
      if (body?.projects !== undefined && !Array.isArray(body.projects)) {
        return send(res, 400, { error: 'projects must be an array of project ids, e.g. ["api","web"]' }, origin);
      }
      const team = await updateTeam(root, id, {
        ...(typeof body?.name === 'string' ? { name: body.name } : {}),
        ...(body?.projects !== undefined ? { projects: body.projects } : {}),
      });
      bus.publish({ type: 'team.changed', action: 'updated', teamId: team.id, teamName: team.name, by });
      return send(res, 200, { team }, origin);
    } catch (e) {
      if (e instanceof TeamError) return send(res, 409, { error: e.message }, origin);
      throw e;
    }
  }

  /*
   * POST /api/members/:id/team — move one member. `{ team: null }` takes them
   * out of every team; a member is in at most one, so there is no "remove from"
   * variant to get wrong.
   */
  const memberTeamM = path.match(/^\/api\/members\/([^/]+)\/team$/);
  if (memberTeamM && method === 'POST') {
    if (requiresOwner(access)) return denyNotOwner(res, origin);
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    const targetId = slugMemberId(decodeURIComponent(memberTeamM[1]));
    if (!targetId) return send(res, 400, { error: 'no member id' }, origin);
    const body = await readJsonBody<{ team?: string | null }>(req);
    const wanted = typeof body?.team === 'string' ? slugTeamId(body.team) : '';
    const teams = await loadTeams(root);
    // Refused rather than stored: a member filed under a team that does not
    // exist would show up in no group and in no filter, which looks like the
    // assignment silently failed — because it did.
    if (wanted && !findTeam(teams, wanted)) {
      return send(res, 404, { error: `no team '${wanted}'`, hint: 'create it first, or send team: null' }, origin);
    }
    try {
      const member = await setMemberTeam(root, targetId, wanted || null);
      const team = findTeam(teams, wanted);
      bus.publish({
        type: 'team.changed', action: 'assigned',
        teamId: team?.id ?? '', teamName: team?.name ?? 'no team',
        memberId: member.id, by: actorLabel(access),
      });
      return send(res, 200, { ok: true, member: { id: member.id, name: member.name, team: member.team ?? null } }, origin);
    } catch (e) {
      if (e instanceof MemberError) return send(res, 409, { error: e.message }, origin);
      throw e;
    }
  }

  /*
   * The daemon fleet (src/daemons.ts) — every Baton on this machine.
   *
   * Operator-only, all three routes, and deliberately stricter than owner: a
   * `--host` member — even one you would call an owner — must not learn what
   * else runs on this machine, and must never be able to stop it. The global
   * anti-CSRF Origin gate above covers the POSTs.
   *
   * "Operator" is normally just loopback, where `decideAccess` already treats
   * the caller as owner. Under `--behind-proxy` there IS no loopback caller by
   * construction, so `access.local` alone locked the operator out of their own
   * daemon — shutdown became unreachable for everybody, and the Daemons card
   * 403'd — while the flag's whole premise is that the owner token is now the
   * only thing that can prove operator identity. See isOperator.
   */
  if (method === 'GET' && path === '/api/daemons') {
    if (!isOperator(access, opts)) return send(res, 403, { error: 'the daemon fleet is visible from this machine only' }, origin);
    // Both pid AND port: after pid reuse, a crash leftover can carry this
    // process's pid — matching pid alone would tag a corpse "this dashboard".
    const daemons = (await listVerifiedDaemons()).map((d) => ({ ...d, self: d.pid === process.pid && d.port === opts.port }));
    return send(res, 200, { daemons }, origin);
  }

  if (method === 'POST' && path === '/api/shutdown') {
    if (!isOperator(access, opts)) return send(res, 403, { error: 'shutdown is accepted from this machine only' }, origin);
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    // Answer FIRST, then die: exiting inside the handler would race the
    // response onto a socket the process no longer owns, and the caller —
    // whose next step is "did that work?" — would see a reset instead of a yes.
    send(res, 200, { ok: true, note: 'shutting down' }, origin);
    setTimeout(() => {
      removeDaemonRecordSync(process.pid, opts.port);
      process.exit(0);
    }, 150);
    return;
  }

  if (method === 'POST' && path === '/api/daemons/clean') {
    if (!isOperator(access, opts)) return send(res, 403, { error: 'the daemon fleet is controlled from this machine only' }, origin);
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    // Bulk clean-up: deletion only, and only of records whose pid is provably
    // dead — no probe is consulted, so a flap can never widen this into
    // touching the living. Stale-but-pid-alive records stay for the per-row
    // stop route, which re-verifies each one.
    const buried = await sweepDeadDaemonRecords();
    return send(res, 200, { ok: true, removed: buried.length }, origin);
  }

  const daemonStopM = path.match(/^\/api\/daemons\/(\d{1,5})\/stop$/);
  if (daemonStopM && method === 'POST') {
    if (!isOperator(access, opts)) return send(res, 403, { error: 'the daemon fleet is controlled from this machine only' }, origin);
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    const port = Number(daemonStopM[1]);
    // Optional `{ "pid": n }` body narrows to ONE record. A port is not a
    // daemon: a crash leftover and a live daemon can both claim it, and the
    // row the caller clicked is a (pid, port) pair — without the pid, cleaning
    // the corpse and stopping the living are the same request.
    let pidWanted: number | undefined;
    // Optional `{ "expect": "stale" }`: the caller's screen said "crash
    // leftover" and its confirm dialog promised a file deletion. Verification
    // is re-run here, and a record can flip live in between (or the earlier
    // probe merely timed out on a loaded box) — honoring the click anyway
    // would stop a healthy daemon behind a dialog that promised otherwise.
    let expectStale = false;
    const rawBody = await readBody(req);
    if (rawBody.trim()) {
      try {
        const parsed = JSON.parse(rawBody) as { pid?: unknown; expect?: unknown };
        if (parsed.pid !== undefined) {
          if (!Number.isInteger(parsed.pid) || (parsed.pid as number) <= 0) {
            return send(res, 400, { error: 'pid must be a positive integer' }, origin);
          }
          pidWanted = parsed.pid as number;
        }
        if (parsed.expect !== undefined) {
          if (parsed.expect !== 'stale' && parsed.expect !== 'live') {
            return send(res, 400, { error: `expect must be "stale" or "live"` }, origin);
          }
          expectStale = parsed.expect === 'stale';
        }
      } catch {
        return send(res, 400, { error: 'body must be JSON like { "pid": 12345 }, or empty' }, origin);
      }
    }
    if (port === opts.port && (pidWanted === undefined || pidWanted === process.pid)) {
      // Not a guess about intent — stopping *this* daemon has its own route
      // with its own, blunter confirmation in the UI. A pid-targeted request
      // for a DIFFERENT pid on our port is a crash leftover being cleaned,
      // and falls through to the stale path below.
      return send(res, 400, { error: 'that port is this daemon — POST /api/shutdown to stop the daemon you are talking to' }, origin);
    }
    const matches = (await listVerifiedDaemons())
      .filter((d) => d.port === port && (pidWanted === undefined || d.pid === pidWanted));
    if (!matches.length) {
      return send(res, 404, { error: `no daemon record for port ${port}${pidWanted !== undefined ? ` with pid ${pidWanted}` : ''}`, hint: 'baton ps lists what this machine knows about' }, origin);
    }
    // Never let a corpse shadow the living: when the port carries both a live
    // daemon and stale leftovers, an un-narrowed stop means the live one.
    const live = matches.find((d) => d.status === 'live' && d.pid !== process.pid);
    if (expectStale && live) {
      return send(res, 409, {
        error: `the record for port ${port} is not a leftover — pid ${live.pid} is alive and answering as ${live.root}`,
        hint: 'refresh the list; stopping a live daemon is a different action than cleaning a record',
      }, origin);
    }
    if (!live) {
      // Only corpses may be deleted. A record that verifies live but names
      // THIS pid (only a hand-forged file gets here — daemons write their own
      // pid) is neither stoppable nor deletable-as-stale; refuse it by name
      // rather than sweep a live record away in a loop labelled "cleanup".
      const corpses = matches.filter((d) => d.status === 'stale');
      if (!corpses.length) {
        return send(res, 409, { error: `the record for port ${port} names this very process (pid ${process.pid}) — nothing here can act on it` }, origin);
      }
      for (const m of corpses) await removeDaemonRecord(m.pid, m.port);
      return send(res, 200, { ok: true, outcome: 'cleaned', root: corpses[0]!.root }, origin);
    }
    const outcome = await stopDaemon(live);
    if (outcome === 'failed') return send(res, 500, { error: `could not stop pid ${live.pid} on port ${port} — it did not exit (or this process may not signal it); its record stays until it is truly gone` }, origin);
    return send(res, 200, { ok: true, outcome, root: live.root }, origin);
  }

  /*
   * GET /api/reachability — the Share panel.
   *
   * Owner-only: it enumerates this machine's LAN addresses and which exposure
   * tools are installed, which is reconnaissance rather than collaboration data.
   * A member has no use for it and an attacker with a stolen member token
   * should not get a free network map.
   */
  if (method === 'GET' && path === '/api/reachability') {
    if (requiresOwner(access)) return denyNotOwner(res, origin);
    return send(res, 200, await assessReachability({
      root,
      bind: opts.host ?? '127.0.0.1',
      port: opts.port ?? 7077,
      allowedHosts: opts.allowedHosts ?? [],
      writeEnabled: !!opts.writeEnabled,
    }), origin);
  }

  /*
   * GET /api/workspace — the hub's layout, for `baton join <url> --token`.
   *
   * This is the endpoint Phase 2 deliberately deferred: it drives `git clone` on
   * the joiner's machine, so it could not exist before there was authentication
   * to put in front of it. Built live from the filesystem on every request —
   * a stored copy would go stale the moment a repo was added.
   */
  if (method === 'GET' && path === '/api/workspace') {
    try {
      const built = await buildManifest(root);
      return send(res, 200, { manifest: built.manifest, skipped: built.skipped }, origin);
    } catch (e) {
      return send(res, 409, { error: (e as Error).message }, origin);
    }
  }

  /*
   * Owner controls. All four are (a) owner-only, checked HERE on the server,
   * and (b) audited by publishing an attributed event — an owner cannot act on
   * a member invisibly.
   *
   * All are write-gated too. That is a real limitation for `revoke`, which is a
   * security action one might want on a read-only daemon; the deliberate answer
   * is that revoking writes members.json, so a read-only daemon must not do it,
   * and `baton member revoke` on the host always works regardless.
   */
  const memberAction = path.match(/^\/api\/members\/([^/]+)\/(warn|disconnect|revoke)$/);
  if (memberAction && method === 'POST') {
    if (requiresOwner(access)) return denyNotOwner(res, origin);
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    const targetId = slugMemberId(decodeURIComponent(memberAction[1]));
    const action = memberAction[2];
    if (!targetId) return send(res, 400, { error: 'no member id' }, origin);
    const by = actorLabel(access);
    const now = Date.now();

    // Name resolution prefers the registry, because a member who is offline has
    // no presence entry but is still a person the audit line should name.
    const registered = (await loadMembers(root)).members.find((m) => m.id === targetId);
    const livePresence = federation.presence(now).find((p) => p.memberId === targetId);
    const targetName = registered?.name ?? livePresence?.memberName ?? targetId;

    if (action === 'warn') {
      const body = await readJsonBody<{ message?: string }>(req);
      const message = typeof body?.message === 'string' ? body.message.trim() : '';
      if (!message) return send(res, 400, { error: 'a warning needs a message' }, origin);
      const warning = federation.warn(targetId, message, by, now);
      if (!warning) {
        // Saying "sent" to an empty room would be the worst outcome here: the
        // owner would believe the person was told and move on.
        return send(res, 409, {
          error: `'${targetName}' is not connected — a warning has nowhere to be delivered`,
          hint: 'warn them when they reconnect, or revoke their token if it cannot wait',
        }, origin);
      }
      // No `message` on the bus: SSE fans out to every member (see events.ts).
      bus.publish({ type: 'member.warned', memberId: targetId, memberName: targetName, by });
      return send(res, 200, { ok: true, warning }, origin);
    }

    if (action === 'disconnect') {
      // Soft by design: it drops them from the live plane and nothing else.
      // Their token still works, so the next heartbeat brings them straight
      // back. That is what makes this the safe button to press first.
      const dropped = federation.remove(targetId);
      if (dropped) {
        bus.publish({ type: 'member.disconnected', memberId: targetId, memberName: targetName, by });
        bus.publish({ type: 'member.presence', online: federation.presence(now).length });
      }
      return send(res, 200, {
        ok: true, dropped,
        note: dropped
          ? 'Dropped from the live view. Their token still works — they reconnect on their next heartbeat.'
          : 'They were not connected.',
      }, origin);
    }

    // revoke — the hard one. Kills the token; the member registry keeps the
    // tombstone so the audit trail survives.
    try {
      const target = await revokeMember(root, targetId);
      federation.remove(targetId);
      bus.publish({ type: 'member.revoked', memberId: target.id, memberName: target.name, by });
      bus.publish({ type: 'member.presence', online: federation.presence(now).length });
      return send(res, 200, {
        ok: true,
        member: { id: target.id, name: target.name, role: target.role, revokedAt: target.revokedAt },
        // Stated in the response, not only in the dialog, so any client that
        // grew its own confirmation still has the honest sentence available.
        note: 'Their token no longer works. Anything they already cloned or synced stays on their machine.',
      }, origin);
    } catch (e) {
      // The only expected failure is the last-owner refusal (E17), which is a
      // 409 rather than a 500: the request was well-formed, the state says no.
      if (e instanceof MemberError) return send(res, 409, { error: e.message }, origin);
      throw e;
    }
  }

  /*
   * POST /api/claims/release — the owner clearing a stale claim (E1).
   *
   * This corrects the shared VIEW, not the member's disk. If their daemon is
   * genuinely still editing the file, its next heartbeat re-states the claim
   * and it returns — which is correct: a host that could permanently suppress a
   * true signal would be worse than one that occasionally shows a stale one.
   */
  if (method === 'POST' && path === '/api/claims/release') {
    if (requiresOwner(access)) return denyNotOwner(res, origin);
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    const body = await readJsonBody<{ memberId?: string; relPath?: string; projectId?: string | null }>(req);
    const targetId = slugMemberId(typeof body?.memberId === 'string' ? body.memberId : '');
    const relPath = typeof body?.relPath === 'string' ? body.relPath.trim() : '';
    if (!targetId || !relPath) return send(res, 400, { error: 'pass memberId and relPath' }, origin);
    const projectId = typeof body?.projectId === 'string' && body.projectId ? body.projectId : null;
    const cleared = federation.releaseClaim(targetId, projectId, relPath);
    if (!cleared) return send(res, 404, { error: `no claim on ${relPath} held by '${targetId}'` }, origin);
    const by = actorLabel(access);
    bus.publish({ type: 'claim.cleared', memberId: targetId, relPath: cleared.relPath, projectId, by });
    bus.publish({ type: 'claim.released', memberId: targetId, relPath: cleared.relPath, projectId });
    return send(res, 200, {
      ok: true, cleared,
      note: 'Cleared from the shared view. If their agent is still editing it, their next heartbeat re-states it.',
    }, origin);
  }

  /*
   * POST /api/pipeline/claim — the hub as the single writer of a task claim.
   *
   * §1.1 names one arbiter per mode: the tasks lock when solo, the hub when
   * team. This is the hub half. Two members each hold their own lock over their
   * own tasks.json, so a local compare-and-swap settles nothing between them —
   * only a single writer does, and this route is it.
   *
   * It runs the SAME pure `claim()` every local caller runs, against the hub's
   * own tasks under the hub's own lock. Not a second implementation of
   * eligibility: a divergent copy of the barrier would be worse than none,
   * because both sides would report success.
   *
   * Deliberately NOT owner-gated. §7.6 puts `take` under "any authenticated
   * member" — arbitrating a claim is the service the hub provides to members,
   * and gating it to the owner would leave team mode with nothing to take.
   *
   * The claim is written but NOT materialized here. The worktree belongs on the
   * member's disk, and the hub creating one would build the work in the wrong
   * place, on the wrong machine, for an agent that cannot reach it.
   */
  if (method === 'POST' && path === '/api/pipeline/claim') {
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    const body = await readJsonBody<{ slug?: string; agent?: string; sessionSlug?: string }>(req);
    const slug = typeof body?.slug === 'string' ? body.slug.trim() : '';
    const agent = typeof body?.agent === 'string' ? body.agent.trim() : '';
    const sessionSlug = typeof body?.sessionSlug === 'string' ? body.sessionSlug.trim() : '';
    if (!slug || !agent || !sessionSlug) {
      return send(res, 400, { error: 'pass slug, agent and sessionSlug' }, origin);
    }
    const who = { agent, sessionSlug };
    // Resolved before the lock, exactly as `claimTask` does it: the gate talks
    // to git, and nothing slow may run inside a mutation. Keyed by phase and
    // sha, so it stays true against the fresh read under the lock.
    const gate = await resolveGate(root, await loadTasks(root));
    const outcome = await mutateTasks(root, (tasks) => {
      /*
       * Already ours — grant it again rather than refusing.
       *
       * The hub writes the claim and never sees what follows: the member
       * activates, pauses and finishes on its own disk, so the hub's row stays
       * `claimed` for the life of the task. Without this branch a member
       * re-taking a task it paused an hour ago is refused by the record of its
       * own claim, and the only exit is the operator. Keyed on the session, so
       * it re-grants to the same holder and nobody else.
       */
      const held = tasks.find((t) => t.slug === slug);
      if (held?.claimedBy?.sessionSlug === sessionSlug) {
        return { tasks: null, result: { ok: true as const, tasks, task: held } };
      }
      const out = claim(tasks, slug, who, new Date().toISOString(), gate);
      return { tasks: out.ok ? out.tasks : null, result: out };
    });
    if (!outcome.ok) {
      // 409, not 400: the request was well-formed and the state said no. The
      // member passes this message through verbatim, so it is the pipeline's
      // own wording that reaches whoever typed the command.
      return send(res, 409, { ok: false, code: outcome.refusal.code, error: outcome.refusal.message }, origin);
    }
    bus.publish({ type: 'task.claimed', slug, agent, by: actorLabel(access) });
    return send(res, 200, { ok: true, task: outcome.task }, origin);
  }

  /*
   * POST /api/pipeline/release — hand a granted claim back.
   *
   * The member's rollback path: the hub granted a claim, the worktree then
   * failed to build, and a task left `claimed` with nothing running behind it is
   * out of circulation for the whole team. `releaseClaim` refuses unless the
   * caller's own session holds it, so this cannot be used to knock a teammate
   * off their task — that is cancellation, which is the operator's (§7.6) and
   * lives in phase 8.
   */
  if (method === 'POST' && path === '/api/pipeline/release') {
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    const body = await readJsonBody<{ slug?: string; sessionSlug?: string }>(req);
    const slug = typeof body?.slug === 'string' ? body.slug.trim() : '';
    const sessionSlug = typeof body?.sessionSlug === 'string' ? body.sessionSlug.trim() : '';
    if (!slug || !sessionSlug) return send(res, 400, { error: 'pass slug and sessionSlug' }, origin);
    const outcome = await mutateTasks(root, (tasks) => {
      const out = releaseClaim(tasks, slug, { agent: '', sessionSlug });
      return { tasks: out.ok ? out.tasks : null, result: out };
    });
    if (!outcome.ok) return send(res, 409, { ok: false, code: outcome.refusal.code, error: outcome.refusal.message }, origin);
    bus.publish({ type: 'task.unclaimed', slug, by: actorLabel(access) });
    return send(res, 200, { ok: true, task: outcome.task }, origin);
  }

  /*
   * GET /api/pipeline — the board as swimlanes (phase 7).
   *
   * The gate is resolved here, exactly as the CLI resolves it, so the dashboard
   * reports the same open phase agents are actually held at. Serving the view
   * without it would show phase 2 open while every `baton take` is refused
   * because phase 1 has not landed on the base — the dashboard contradicting
   * the tool, with the dashboard being the one that is wrong.
   */
  if (method === 'GET' && path === '/api/pipeline') {
    const tasks = await loadTasks(root);
    return send(res, 200, pipelineView(tasks, await resolveGate(root, tasks)), origin);
  }

  /*
   * GET /api/pipeline/plans/:id — the plan document, as markdown.
   *
   * Served as source text, never as HTML. The dashboard renders it, and a plan
   * is a file any contributor can put in the repo; turning it into markup on
   * the server would make "who may edit baton/plans" into "who may run script
   * in the operator's dashboard".
   */
  const planM = path.match(/^\/api\/pipeline\/plans\/([^/]+)$/);
  if (method === 'GET' && planM) {
    let id: string;
    try {
      id = decodeURIComponent(planM[1]);
    } catch {
      return send(res, 400, { error: 'bad plan id' }, origin);
    }
    /*
     * Two guards, and they stop different attacks — verified by deleting each
     * one and watching which test fails.
     *
     * The charset is the only thing that stops a dotfile INSIDE the directory:
     * `baton/plans/.env.md` never leaves `baton/plans`, so containment has
     * nothing to object to. Remove the charset and that case is wide open.
     *
     * Containment is the only thing that stops an ESCAPE if the pattern is ever
     * loosened to admit a character someone did not think through. Remove the
     * charset and it still catches `..%2f..%2f` — which is what it is for.
     *
     * Neither is redundant, and with both gone the traversal test leaks a
     * planted file. This endpoint reads bytes off the operator's disk and hands
     * them to a browser; an escape here is not a plan render, it is
     * `GET /api/pipeline/plans/..%2f..%2f.baton%2fhost` reading a live token.
     */
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) || id.includes('..')) {
      return send(res, 400, { error: 'bad plan id', hint: 'letters, digits, dot, dash and underscore only' }, origin);
    }
    const dir = join(root, PLANS_DIR);
    const file = normalize(join(dir, `${id}.md`));
    if (!file.startsWith(dir + sep)) return send(res, 403, { error: 'forbidden' }, origin);
    const markdown = await readFile(file, 'utf-8').catch(() => null);
    if (markdown === null) {
      return send(res, 404, { error: `no plan '${id}'`, hint: `plans live in ${PLANS_DIR}/` }, origin);
    }
    return send(res, 200, { id, markdown, path: `${PLANS_DIR}/${id}.md` }, origin);
  }

  /*
   * POST /api/pipeline/cancel — stop work from the dashboard (§8, phase 7).
   *
   * Three gates, and each closes a different door:
   *
   *   write   — a read-only daemon must not mutate, same as every other write.
   *   owner   — §7.6 makes cancellation the operator's. A member who could
   *             cancel could knock the whole team off its work from a browser
   *             tab, which is precisely what `release` was scoped away from.
   *   member  — and if THIS machine answers to a hub, its own dashboard must
   *             not cancel either. The refusal is not about who is asking; it
   *             is that the plan lives elsewhere, and cancelling here would
   *             fork it silently. Same rule `requireOperator` applies on the
   *             CLI, through the same pure `decideOperator`.
   *
   * `dryRun` returns the blast radius and writes nothing — and it is the SAME
   * code path, with the write suppressed, so the confirmation a person reads is
   * produced by the thing that would act on it.
   */
  if (method === 'POST' && path === '/api/pipeline/cancel') {
    if (requiresOwner(access)) return denyNotOwner(res, origin);
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    const asMember = decideOperator(await loadHostLink(root));
    if (!asMember.allowed) {
      return send(res, 403, {
        error: 'cancelling is the operator\'s — this machine is a member of ' + asMember.hostUrl,
        hint: 'Ask the operator to cancel there. To stop being a member: baton host clear',
        code: 'not-operator',
      }, origin);
    }
    const body = await readJsonBody<{ slug?: string; phase?: number; plan?: string; reason?: string; dryRun?: boolean }>(req);
    const scope = scopeFromBody(body);
    // 400, not a guess. `{ slug, phase }` could mean either, and picking one
    // stops work nobody asked to stop — the same refusal `resolveScope` makes
    // on the CLI, for the same reason.
    if (typeof scope === 'string') return send(res, 400, { error: scope }, origin);

    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 500) : undefined;
    const actor = actorLabel(access);
    const now = new Date().toISOString();
    const outcome = await mutateTasks(root, (tasks) => {
      // Inside the lock, against the list about to be written: a radius
      // measured against the board the browser last polled would stop work the
      // person confirming never saw.
      const radius = blastRadius(tasks as PipelineTask[], scope);
      if (body?.dryRun || !radius.stopping.length) return { tasks: null, result: { radius, cancelled: [] as string[] } };
      const r = cancelTasks(tasks, radius.stopping.map((s) => s.slug), actor, now, reason);
      return { tasks: r.tasks, result: { radius, cancelled: r.cancelled } };
    });

    if (outcome.cancelled.length) {
      bus.publish({
        type: 'task.cancelled',
        slugs: outcome.cancelled,
        stranded: outcome.radius.stranding.map((s) => s.slug),
        scope: scopeLabel(scope),
        by: actor,
        ...(reason ? { reason } : {}),
      });
    }
    return send(res, 200, {
      ok: true,
      dryRun: !!body?.dryRun,
      scope: scopeLabel(scope),
      radius: outcome.radius,
      agentsStopped: agentsStopped(outcome.radius),
      cancelled: outcome.cancelled,
    }, origin);
  }

  if (method === 'GET' && path === '/api/signals') {
    return send(res, 200, { signals: await getSignals(root, SIGNAL_WINDOW_MIN, { includeSettled: true }) }, origin);
  }
  // GET /api/signals/check?files=a,b,c[&exclude=slug] — "ask before editing" for
  // agents without MCP; exclude drops the caller's own task from the answer.
  if (method === 'GET' && path === '/api/signals/check') {
    const files = (url.searchParams.get('files') ?? '').split(',').map((f) => f.trim()).filter(Boolean);
    if (!files.length) return send(res, 400, { error: 'pass ?files=path1,path2' }, origin);
    const exclude = url.searchParams.get('exclude')?.trim() || undefined;
    // Same two-source answer as the MCP tool — an agent without MCP must not get
    // a blinder version of "is anyone on this file". Reachability is reported
    // separately so "could not ask" never reads as "nobody is there".
    const [checked, view, project] = await Promise.all([
      checkFiles(root, files, exclude), remoteClaims(root), projectOf(root, exclude),
    ]);
    for (const [p, holders] of Object.entries(remoteHoldersFor(view, files, undefined, project))) {
      if (checked[p]) checked[p] = { ...checked[p], busy: true, elsewhere: holders };
    }
    const note = remoteNote(view);
    return send(res, 200, {
      files: checked,
      watcherActive: isWatcherActive(root),
      ...(view.linked ? { remote: { reachable: view.reachable, ...(note ? { note } : {}) } } : {}),
    }, origin);
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

  // GET /api/kb/context?project=<id|all>&tokens=<n>&format=<md|json> —
  // the shareable markdown pack for external chatbots. Read-only; works
  // without an initialized KB (degrades to README + stack + tree).
  if (method === 'GET' && path === '/api/kb/context') {
    const state = await loadKb(root);
    const projectParam = url.searchParams.get('project');
    const project = projectParam && projectParam !== 'all' ? projectParam : undefined;
    const tokensRaw = Number(url.searchParams.get('tokens') ?? 8000);
    const maxTokens = Math.max(1000, Math.min(200_000, Number.isFinite(tokensRaw) ? tokensRaw : 8000));
    try {
      const pack = await buildContextPack(root, state, { project, maxTokens });
      if (url.searchParams.get('format') === 'json') return send(res, 200, pack, origin);
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Access-Control-Allow-Origin': origin,
        'Vary': 'Origin',
      });
      res.end(pack.markdown);
      return;
    } catch (e) {
      if (e instanceof UnknownKbProjectError) {
        return send(res, 404, { error: `no project '${project}'`, projects: e.projects }, origin);
      }
      throw e;
    }
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
    // The promise is never awaited, and child.kill() below guarantees it rejects
    // when the client cancels — an unhandled rejection without this catch.
    child.catch(() => undefined);
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
    const mcpOpts = { baseUrl: `http://127.0.0.1:${opts.port}`, token: getMcpToken(root) };
    return send(res, 200, { agents: allSnippets(state, mcpOpts) }, origin);
  }

  if (method === 'GET' && path === '/api/status') return send(res, 200, await statusRows(root), origin);
  // GET /api/sessions — connected agents with no task worktree (presence layer)
  if (method === 'GET' && path === '/api/sessions') return send(res, 200, await collectPresence(root), origin);
  if (method === 'GET' && path === '/api/agents/root') {
    const [tasks, kb] = await Promise.all([loadTasks(root), loadKb(root)]);
    const summary = await rootAgentSummary(
      root,
      (kb?.projects ?? []).map((p) => p.path),
      tasks.map((t) => t.worktreePath),
    );
    return send(res, 200, summary, origin);
  }
  if (method === 'GET' && path === '/api/history') return send(res, 200, listHistory(root), origin);
  if (method === 'GET' && path === '/api/meta') {
    const tmuxOk = await detectTmux();
    // A setup hub may be git-initialized for coordination metadata. Treat it as
    // a hub when the KB has multiple projects, not when the root lacks .git.
    const rootIsRepo = await isGitRepo(root);
    const kb = await loadKb(root);
    const hubProjects = (kb?.projects.length ?? 0) > 1
      ? kb!.projects.map((p) => ({ id: p.id, name: p.name }))
      : [];
    const known = agentsFor(root);
    return send(res, 200, {
      repo: root, branch: rootIsRepo ? await currentBranch(root) : null,
      writeEnabled: !!opts.writeEnabled, version: VERSION,
      // The fleet's identity check: a daemon record names a (pid, port) pair,
      // and root alone can't distinguish "that daemon" from "a new daemon in
      // the same repo on the same port" (verifyDaemon, src/daemons.ts).
      pid: process.pid,
      // In a hub, the dashboard must ask which project a new task targets.
      hub: hubProjects.length > 0, projects: hubProjects,
      // Per root, not the module-level lists: the project's own
      // `.baton/agents.json` must reach the dashboard's agent pickers.
      agents: {
        headless: Object.values(known).filter((a) => a.headless).map((a) => a.id),
        interactive: Object.values(known).filter((a) => a.interactive).map((a) => a.id),
        // Every id this root knows, launchable or not. A detection-only agent
        // (antigravity and openclaw today, or a custom entry that declares no
        // launcher) is still a valid HANDOFF target — a brief is a document
        // you leave for whoever picks the task up, not a process Baton
        // spawns. A picker built from the two launcher lists silently dropped
        // exactly those agents, while the built-in detection-only ones stayed
        // visible because the web registry hardcodes them.
        known: Object.keys(known),
        // Which of those the REPO defined rather than this machine's owner.
        // The Agents card already tags these, but the Launch dialog is the
        // surface that actually starts one, and it was offering repo-supplied
        // agents indistinguishable from built-ins. Provenance has to travel
        // with the list, or only one of the two surfaces can show it.
        fromProject: Object.values(known).filter((a) => a.fromProject).map((a) => a.id),
      },
      /*
       * Terminals are answered FOR THIS VIEWER, not for the machine. A remote
       * browser cannot reach one at any tmux version (access.ts rule 2), so
       * reporting the host's tmux to them would render a terminal button that
       * always 403s. Say why instead — the hint is the fix.
       */
      // `reason` rather than one merged sentence: the tmux hint is a COMMAND to
      // paste and the remote hint is prose, and rendering prose behind a `$`
      // prompt is the exact flaw the Share panel already had to fix once.
      terminals: !access.local
        ? { available: false, reason: 'remote' as const }
        : tmuxOk
          ? { available: true }
          : {
              available: false,
              reason: 'tmux' as const,
              hint: process.platform === 'darwin' ? 'brew install tmux' : 'apt install tmux',
            },
      /*
       * Who the daemon thinks you are. The dashboard needs this to name the
       * signed-in member, to stop offering owner controls it would only be 403'd
       * for, and to tell "signed in" apart from "local, no credential needed".
       */
      viewer: {
        local: access.local,
        memberId: access.member?.id ?? null,
        name: access.member?.name ?? null,
        role: access.member?.role ?? (access.local ? 'owner' : null),
      },
    }, origin);
  }

  if (method === 'POST' && path === '/api/tasks') {
    // Not a bookkeeping write: createTask makes a git branch and a worktree.
    // This was the one state-changing route missing the read-only gate.
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
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
      await statusRows(root),
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
    if (!knownAgentIdsFor(root).includes(agent)) return send(res, 404, { error: `unknown agent '${agent}'` }, origin);
    const body = (await readJsonBody<{ confirmGlobal?: boolean }>(req)) ?? {};
    try {
      const state = await loadKb(root);
      const mcpOpts = { baseUrl: `http://127.0.0.1:${opts.port}`, token: getMcpToken(root) };
      const result = await connectAgentMcp(agent, root, state, { confirmGlobal: body.confirmGlobal === true, mcpOpts });
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
    return send(res, 200, { skills: await listSkillStatus(root), agents: SKILL_AGENTS }, origin);
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
      if (agent === 'all') {
        const results = await installSkillEverywhere(root, id);
        for (const r of results) bus.publish({ type: 'skill.installed', skill: id, agent: r.agent });
        return send(res, 201, { results }, origin);
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

  // GET /api/reviews — recorded code-review findings, newest first. Per-axis
  // open counts only: the axes are separate by design, so no combined total.
  if (method === 'GET' && path === '/api/reviews') {
    const reviews = await listReviews(root);
    // Per review, not one sha for the lot: each was taken in its own task's
    // worktree, on its own branch (see reviewHeads).
    const heads = await reviewHeads(root, reviews.map((r) => r.slug));
    const head = (await headCommit(root).catch(() => null)) ?? '';
    return send(res, 200, {
      reviews: reviews.map((r) => ({
        ...r,
        open: countByAxis(openFindings(r)),
        stale: isReviewStale(r, heads.get(r.slug) ?? ''),
      })),
      head,
    }, origin);
  }
  // POST /api/reviews/:slug/resolve — mark a finding fixed/dismissed (write-gated)
  if (method === 'POST' && /^\/api\/reviews\/[^/]+\/resolve$/.test(path)) {
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    const slug = decodeURIComponent(path.split('/')[3]);
    const body = await readJsonBody<{ id?: string; index?: number; dismiss?: boolean }>(req);
    // Prefer the stable `id`. Findings carry one precisely so triage survives a
    // re-review, and a re-review reorders them — so the position that was right
    // when the dashboard rendered can address a DIFFERENT finding by the time
    // the click lands. `index` stays accepted for callers that only have one.
    //
    // Integer, not merely `number`: resolveFinding's bounds check passes 1.5 and
    // NaN (NaN compares false to everything), and the assignment then creates a
    // NAMED property on the array instead of hitting an element — the endpoint
    // answered 200 with the record unchanged and rewrote the file, so the caller
    // believed a finding was resolved when nothing was.
    const id = typeof body?.id === 'string' ? body.id.trim() : '';
    const index = body?.index;
    const ref: string | number | null = id
      ? id
      : (typeof index === 'number' && Number.isInteger(index) ? index : null);
    if (ref === null) return send(res, 400, { error: 'id (string) or index (integer) required' }, origin);
    const rec = await resolveFinding(root, slug, ref, body?.dismiss ? 'dismissed' : 'fixed');
    if (!rec) return send(res, 404, { error: `no finding ${typeof ref === 'string' ? `'${ref}'` : `[${ref}]`} in review '${slug}'` }, origin);
    return send(res, 200, { ...rec, open: countByAxis(openFindings(rec)) }, origin);
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
  // POST /api/memory/repair — mechanically re-anchor stale facts whose
  // verifiable terms survived; the rest stay queued for review (write-gated)
  if (method === 'POST' && path === '/api/memory/repair') {
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    const result = await repairMemories(root);
    if (result.reanchored.length) bus.publish({ type: 'memory.updated' });
    return send(res, 200, result, origin);
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
  // Quadruple-guarded: --write, OWNER, an allowed Origin (anti-CSRF, also enforced
  // globally above — kept here as explicit defense-in-depth), and a typed phrase.
  if (method === 'POST' && path === '/api/storage/purge') {
    if (!opts.writeEnabled) return denyReadOnly(res, origin);
    // This is the most destructive endpoint Baton has — it deletes memory,
    // history and reports outright and then reclaims the git objects — and it
    // was reachable by any member. The confirm phrase is an "are you sure",
    // not an authorization check, and GET /api/storage/purge hands the phrase
    // to whoever asks, so a member could read it back and echo it.
    if (requiresOwner(access)) return denyNotOwner(res, origin);
    // The shared gate, not a private loopback-only one: under
    // `--allowed-host hub.example.com` the operator's OWN dashboard sends that
    // name as its Origin, passes the global check at the top of handle(), then
    // used to fail this stricter copy — purge 403'd for the one person allowed
    // to run it. Defense in depth has to mean the same rule twice, not two.
    if (!isAllowedOrigin(req.headers.origin, allowedNames(opts))) {
      return send(res, 403, { error: 'cross-origin request refused' }, origin);
    }
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
    // Loopback-only, refused up in decideAccess (isHostProcessPath) — this
    // starts a process on the host, the capability rule 2 reserves.
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

  // GET /api/handoffs — every open handoff brief (task worktrees + session
  // briefs under .baton/handoffs). Powers the dashboard's copy-to-resume UX.
  if (path === '/api/handoffs' && method === 'GET') {
    const briefs = await listBriefs(root);
    return send(res, 200, { briefs: briefs.filter((b) => b.status !== 'done') }, origin);
  }

  // GET /api/tasks/:slug/suggest-handoff — load-aware target recommendation
  const shm = path.match(/^\/api\/tasks\/([^/]+)\/suggest-handoff$/);
  if (shm && method === 'GET') {
    const slug = decodeURIComponent(shm[1]);
    const rows = await statusRows(root);
    const row = rows.find((r) => r.slug === slug);
    if (!row) return send(res, 404, { error: `no task '${slug}'` }, origin);
    const loads = agentActiveLoads(rows);
    const { config } = await loadRouting(root);
    const routed = suggestRoute(row.task, config);
    const candidates = routed.chain.map((c) => c.agent);
    const pick = pickHandoffTarget({ candidates, loads, routingPick: candidates[0] ?? null, exclude: row.agent });
    return send(res, 200, { recommended: pick.agent, reason: pick.reason, loads }, origin);
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
  // Capture KB state at startup for the graphify pool's graph resolver.
  // Note: adding a new project via `baton kb init` after daemon start requires
  // a daemon restart for the pool to discover the new project's graph path.
  const kb0 = await loadKb(root);
  graphPool = new GraphifyPool((id) => {
    if (id === 'merged') return kb0?.mergedGraphPath ?? null;
    const p = kb0?.projects.find((x) => x.id === id);
    return p ? graphPathFor(p.path) : null;
  });
  const reaper = setInterval(() => { void graphPool?.reapIdle(); }, 60_000);
  reaper.unref?.();
  const stop = () => {
    clearInterval(reaper);
    void graphPool?.shutdown();
    // Headless agents run in their own process group now (spawn.ts), which
    // opted them out of execa's kill-on-parent-exit — so take them with us
    // explicitly or a daemon restart leaves them editing worktrees unwatched.
    stopAllAgents();
    // Sync, because the event loop is about to die with us. Best-effort: a
    // record left behind is exactly what verification exists to catch.
    removeDaemonRecordSync(process.pid, opts.port);
    process.exit(0);
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);

  poller = new StatusPoller(root);
  const watcher = new WorktreeWatcher(root);
  await watcher.start();
  new SignalTracker(root).start();
  // Conservative startup sweep: delete only provably-dead temp files + stale
  // uploads (never worktrees/branches/tmux). Best-effort, like the watcher below.
  void sweepTmpFiles(root).catch(() => undefined);
  // Fleet self-healing: bury records left machine-wide by crashed daemons, so
  // corpses do not pile up waiting for someone to run `baton daemon clean`.
  // pid-death only — no probes, nothing signalled — safe unattended.
  void sweepDeadDaemonRecords()
    .then((buried) => { if (buried.length) console.log(`baton serve: swept ${buried.length} fleet record${buried.length === 1 ? '' : 's'} left by crashed daemons`); })
    .catch(() => undefined);
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
    const mainRoot = await mainRepoRoot(root);
    let memTimer: ReturnType<typeof setTimeout> | null = null;
    // BOTH areas (§12). Watching only one would leave the dashboard stale for
    // every save on the other half — silently, and differently depending on how
    // far through the migration the repo happens to be.
    for (const { dir } of memoryAreas(mainRoot)) {
      await mkdir(dir, { recursive: true });
      const memWatcher = watch(dir, () => {
        if (memTimer) clearTimeout(memTimer);
        memTimer = setTimeout(() => bus.publish({ type: 'memory.updated' }), 300);
      });
      // FSWatcher emits 'error' asynchronously (dir removed/recreated, EMFILE); an
      // unhandled one crashes the daemon. Swallow it, matching watch.ts's idiom.
      memWatcher.on('error', () => undefined);
    }
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
  // graphify's own post-commit hook rebuilds graphs OUTSIDE the daemon (no
  // kb.rebuilt fires) — sweep so CODEBASE.md follows the graph within a minute.
  setInterval(() => { void refreshDocsIfStale(root).catch(() => undefined); }, 60_000).unref();
  // B2: agents merge via GitHub PRs on the sub-repos, outside `baton merge`, so
  // those commits never reached history.db. Ingest each project's real git log
  // into a per-project bucket at startup + on an interval, so History and
  // who_touched/blame cover every commit however it landed.
  void ingestAllProjects(root);
  setInterval(() => { void ingestAllProjects(root); }, 60_000).unref();
  // M7: background memory maintenance (the sleep-time pattern, mechanical
  // only — no LLM). Stale-but-still-true facts get re-anchored between
  // sessions instead of waiting for someone to run `baton memory repair`;
  // rewrites hit the memory watcher above, so the dashboard follows live.
  void repairMemories(root).catch(() => undefined);
  setInterval(() => { void repairMemories(root).catch(() => undefined); }, 600_000).unref();

  /*
   * Publish this machine's claims to a linked host, if one is configured.
   *
   * Entirely opt-in: with no `.baton/host.json` nothing here runs and no network
   * call is ever made. A failed heartbeat is logged once and retried — the host
   * being unreachable (laptop asleep, tunnel down) is routine, and it must
   * degrade to local-only rather than disturb anything running here.
   */
  let heartbeatWarned = false;
  // Notices already shown. The host re-sends them on every heartbeat (so a
  // crash between receive and print cannot swallow one), which makes de-duping
  // the reader's job.
  const shownWarnings = new Set<string>();
  setInterval(() => {
    void (async () => {
      const link = await loadHostLink(root);
      if (!link) return;
      const payload = await localClaimsPayload(root, link.device);
      const r = await sendHeartbeat(link, payload);
      for (const w of r.warnings ?? []) {
        if (shownWarnings.has(w.id)) continue;
        shownWarnings.add(w.id);
        console.warn(`\nbaton: notice from ${w.from} (hub owner) — ${w.message}\n`);
      }
      if (!r.ok && !heartbeatWarned) {
        heartbeatWarned = true;
        console.warn(`baton serve: host ${link.url} unreachable (${r.error}) — coordinating locally; will keep retrying.`);
      } else if (r.ok && heartbeatWarned) {
        heartbeatWarned = false;
        console.warn(`baton serve: host ${link.url} reachable again.`);
      }
    })().catch(() => undefined);
  }, 30_000).unref();

  /*
   * Sweep departed members. A member that crashes or loses its tunnel never
   * sends a goodbye, so absence is the only signal there is — `member.left` is
   * emitted by the host on TTL expiry, not by the member. Reads also apply the
   * TTL themselves, so a stopped timer can never make a gone member look present;
   * this exists so the EVENT fires (and the roster updates) without a reader.
   */
  setInterval(() => {
    for (const gone of federation.sweep(Date.now()).left) {
      bus.publish({ type: 'member.left', memberId: gone.memberId, memberName: gone.memberName });
      bus.publish({ type: 'member.presence', online: federation.presence(Date.now()).length });
    }
  }, 30_000).unref();
  /*
   * Fail closed. Binding a non-loopback address without a single member token
   * would publish the knowledge base, the task list and every mutating endpoint
   * to whoever can route to the port — so refuse to start rather than come up
   * wide open. This is the one check that must never become a warning.
   */
  const bindAddr = opts.host ?? '127.0.0.1';
  if (!isLoopbackAddr(bindAddr)) {
    if (!hasActiveMembers(await loadMembers(root))) {
      console.error(`baton serve: refusing to bind ${bindAddr} with no members — anyone who can reach the port would have full access.`);
      console.error('  Create one first:  baton member add "<your name>"');
      console.error('  (Or drop --host and reach the daemon over SSH port-forwarding, which needs no credentials.)');
      process.exit(1);
    }
    console.warn(`baton serve: bound ${bindAddr} — /api requires a member token; terminals stay loopback-only.`);
  }
  /*
   * --behind-proxy withdraws the loopback trust that every other mode rests on,
   * so with no member registered NOBODY can authenticate — including the owner.
   * Same fail-closed shape as --host, and for the same reason: a mode whose
   * whole point is "check tokens now" must not start with no tokens to check.
   */
  if (opts.behindProxy && !hasActiveMembers(await loadMembers(root))) {
    console.error('baton serve: --behind-proxy requires a member — it stops trusting loopback, so with no token nobody can get in at all.');
    console.error('  Create one first:  baton member add "<your name>"');
    process.exit(1);
  }
  /*
   * The shape this flag exists for, caught at the door.
   *
   * Declaring a public name while bound to loopback is how a tunnel is wired:
   * cloudflared/ngrok/nginx forward to 127.0.0.1, so every request off the
   * public internet arrives as loopback and reads as owner — no token, plus
   * terminals and agent launches, which are supposed to be unreachable
   * remotely. A warning rather than a refusal because the same shape is
   * legitimate when the name resolves to 127.0.0.1 (a local alias), which the
   * daemon cannot distinguish from a tunnel without resolving it.
   */
  if (!opts.behindProxy && isLoopbackAddr(bindAddr)) {
    const proxied = (opts.allowedHosts ?? []).filter((h) => !isLoopbackHost(h));
    if (proxied.length) {
      console.warn(`baton serve: '${proxied.join(', ')}' is declared reachable, but this daemon is bound to loopback only.`);
      console.warn('  If a tunnel or reverse proxy forwards to this port, every public request reads as LOCAL — no member token,');
      console.warn('  and terminals plus agent launches are reachable. Restart with --behind-proxy to check tokens on those requests.');
      console.warn('  (Ignore this if the name just resolves to 127.0.0.1 on this machine.)');
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res, root, opts).catch((e) =>
      send(res, 500, { error: (e as Error).message }, corsOrigin(req, opts)),
    );
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.port, bindAddr, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (e) {
    // Without this, a second daemon dies with an unhandled 'error' stack trace
    // (after already starting watchers and writing heartbeat rows). exit(1)
    // tears all of that down; the surviving daemon owns the registry rows.
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      // Name the holder when the fleet registry knows it — "which daemon is
      // that" is the whole question this error used to leave open. Verified
      // first: a stale record plus some OTHER app on the port would otherwise
      // produce a confident lie, and a `baton daemon stop` that frees nothing.
      // EVERY record on the port, not the first: a crash leftover and the
      // live daemon can both claim it, and the leftover often sorts first —
      // checking only that one would print "unknown holder" while the
      // registry knew exactly who to name.
      const claims = (await listDaemonRecords().catch(() => [])).filter((r) => r.port === opts.port);
      let holder: DaemonRecord | undefined;
      for (const c of claims) {
        if ((await verifyDaemon(c).catch(() => 'stale')) === 'live') { holder = c; break; }
      }
      console.error(holder
        ? `baton serve: port ${opts.port} is already serving ${holder.root} — stop it with: baton daemon stop ${opts.port} ${holder.pid}`
        : `baton serve: port ${opts.port} is already in use — is another daemon running? (try: baton serve --port <other>)`);
      process.exit(1);
    }
    throw e;
  }
  // Announce to the fleet — after listen succeeds, so a record always names a
  // port this pid actually holds. Best-effort: the fleet is a convenience,
  // never a precondition for serving.
  await writeDaemonRecord({
    pid: process.pid, port: opts.port, root,
    startedAt: new Date().toISOString(), version: VERSION,
    writeEnabled: !!opts.writeEnabled, host: bindAddr !== '127.0.0.1',
  }).catch((e) => console.error(`baton serve: fleet record not written (${(e as Error).message}) — \`baton ps\` will not see this daemon`));
  if (existsSync(WEB_DIST)) {
    console.log(`baton serve → dashboard http://localhost:${opts.port}`);
  } else {
    console.log(`baton serve → http://localhost:${opts.port}  (dashboard not built — run: npm run build --prefix web)`);
  }
  console.log('  API: /api/status · /api/history · /api/meta · /api/tasks/:slug · /api/events (SSE) · /api/kb · /api/doctor   (Ctrl+C to stop)');
}
