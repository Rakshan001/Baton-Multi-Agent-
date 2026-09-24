// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The daemon fleet — every `baton serve` on this machine, findable and
 * stoppable from any of them.
 *
 * People run Baton on several projects at once, and the failure mode is
 * mundane: a daemon started in the wrong repo, or on a port you forgot, and no
 * way to see it except `ps | grep`. Each daemon writes ONE record file to a
 * machine-level directory — one file per daemon, deliberately, so there is no
 * shared file for two daemons to race on (the members.json lesson, applied in
 * advance). The record is removed on clean shutdown; a crash leaves it behind.
 *
 * Because of that, a record is a CLAIM, not a fact. Nothing here shows a
 * record as live — and nothing ever sends a signal to its pid — until it has
 * been verified: the pid must be alive, the port must answer `/api/meta` with
 * the SAME repo root, and the answering process must BE that pid (meta carries
 * it). Pid reuse, port reuse, and a same-repo restart on the old port all fail
 * verification; an entry that fails is "stale" and may only be cleaned up,
 * never stopped.
 *
 * Stopping is graceful-first, signal-second: POST /api/shutdown, and only when
 * the target predates that endpoint (404) or cannot answer does a SIGTERM go
 * to the verified pid. SIGKILL is never automatic.
 */
import { readdir, readFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { listMemories, mainRepoRoot, supersedeMemory, type MemoryFact } from './memory.js';
import { consolidateFacts, type ReportOp } from './memory/consolidate.js';
import { tasksFile, type Task } from './store.js';
import { stateOf } from './pipeline.js';

export interface DaemonRecord {
  pid: number;
  port: number;
  /** Absolute Baton root this daemon serves — the verification anchor. */
  root: string;
  startedAt: string;
  version: string;
  writeEnabled: boolean;
  /** True when bound beyond loopback (`--host`). */
  host: boolean;
}

export type DaemonStatus = 'live' | 'stale';

export interface VerifiedDaemon extends DaemonRecord {
  status: DaemonStatus;
}

export function daemonsDir(): string {
  // The override exists for tests (a hermetic registry per test run) and for
  // the odd setup that wants the fleet somewhere else. Env is trusted input.
  return process.env.BATON_DAEMONS_DIR || join(homedir(), '.baton', 'daemons');
}

/** `<pid>-<port>.json` — both in the name so a reused pid on another port
 *  cannot collide with the file of the daemon it replaced. */
export function recordPath(pid: number, port: number, dir = daemonsDir()): string {
  return join(dir, `${pid}-${port}.json`);
}

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for tests)                                   */
/* ------------------------------------------------------------------ */

export function cleanDaemonRecord(raw: unknown): DaemonRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<DaemonRecord>;
  if (!Number.isInteger(r.pid) || (r.pid as number) <= 0) return null;
  if (!Number.isInteger(r.port) || (r.port as number) <= 0 || (r.port as number) > 65535) return null;
  if (typeof r.root !== 'string' || !r.root) return null;
  return {
    pid: r.pid as number,
    port: r.port as number,
    root: r.root,
    startedAt: typeof r.startedAt === 'string' ? r.startedAt : new Date(0).toISOString(),
    version: typeof r.version === 'string' ? r.version : 'unknown',
    writeEnabled: r.writeEnabled === true,
    host: r.host === true,
  };
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means "exists but not ours" — alive, just not killable. ESRCH is
    // the only "gone".
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export async function writeDaemonRecord(rec: DaemonRecord, dir = daemonsDir()): Promise<void> {
  await mkdir(dir, { recursive: true });
  const path = recordPath(rec.pid, rec.port, dir);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(rec, null, 2)}\n`);
  await rename(tmp, path);
}

export async function removeDaemonRecord(pid: number, port: number, dir = daemonsDir()): Promise<void> {
  try { await unlink(recordPath(pid, port, dir)); } catch { /* already gone */ }
}

/** Synchronous twin for shutdown paths, where the event loop is about to die. */
export function removeDaemonRecordSync(pid: number, port: number, dir = daemonsDir()): void {
  try { unlinkSync(recordPath(pid, port, dir)); } catch { /* already gone */ }
}

/**
 * Bury every record whose pid is provably gone. Deletion only, and decided on
 * pid-death alone — no port is probed, so a busy daemon missing one probe can
 * never get its record swept here. That strictness is what makes this safe to
 * run unattended (daemon startup, `baton daemon clean`, the dashboard's bulk
 * clean-up): a record kept may still be stale for other reasons, but a record
 * removed could not have named a living process.
 */
export async function sweepDeadDaemonRecords(dir = daemonsDir()): Promise<DaemonRecord[]> {
  const buried: DaemonRecord[] = [];
  // A crash between the claim and the delete below leaves a `.sweep-<pid>`
  // file. It is inert (no listing looks at it — they filter on `.json`), but
  // this IS the hygiene routine, so it does not get to litter: reclaim any
  // whose claimer is gone. A live claimer's file is mid-sweep, so leave it.
  await readdir(dir).then((names) => Promise.all(names.map(async (n) => {
    const m = /\.sweep-(\d+)$/.exec(n);
    if (m && !pidAlive(Number(m[1]))) await unlink(join(dir, n)).catch(() => undefined);
  }))).catch(() => undefined);
  for (const rec of await listDaemonRecords(dir)) {
    if (pidAlive(rec.pid)) continue;
    // CLAIM, then delete. Every caller REPORTS this list ("3 records
    // removed", one ✓ per row) and sweeps race routinely — every `baton
    // serve` startup runs one, alongside `baton daemon clean` and the
    // dashboard's Clean up all — across processes, so no in-process lock can
    // serialize them. `unlink` cannot decide the winner: two concurrent
    // unlinks of one path BOTH resolve successfully here, so counting on its
    // success reports the same corpse twice. Renaming to a pid-unique name
    // is the atomic claim POSIX does guarantee — exactly one rename can move
    // a given file, so exactly one sweep counts it.
    const claim = `${recordPath(rec.pid, rec.port, dir)}.sweep-${process.pid}`;
    try {
      await rename(recordPath(rec.pid, rec.port, dir), claim);
    } catch {
      continue; // another sweep got there first — theirs to report, not ours
    }
    await unlink(claim).catch(() => undefined);
    buried.push(rec);
  }
  return buried;
}

/** Every record on this machine. One corrupt file must not hide the rest, so
 *  parse failures are skipped per-file, never thrown. */
export async function listDaemonRecords(dir = daemonsDir()): Promise<DaemonRecord[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return []; // no dir → no daemons ever started; exactly how a machine begins
  }
  const out: DaemonRecord[] = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    try {
      const rec = cleanDaemonRecord(JSON.parse(await readFile(join(dir, name), 'utf-8')));
      if (rec) out.push(rec);
    } catch { /* skip this file, keep the rest */ }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Verification                                                        */
/* ------------------------------------------------------------------ */

/** What `/api/meta` on a claimed port actually says, or null. Loopback only —
 *  the fleet never probes anything it could not also have started. */
export async function probeMeta(
  port: number,
  timeoutMs = 1500,
): Promise<{ repo: string; version?: string; pid?: number } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/meta`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { repo?: unknown; version?: unknown; pid?: unknown };
    if (typeof body.repo !== 'string') return null;
    return {
      repo: body.repo,
      ...(typeof body.version === 'string' ? { version: body.version } : {}),
      ...(typeof body.pid === 'number' ? { pid: body.pid } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * live ⇔ the pid is alive AND the port answers with the same root AND — when
 * the daemon is new enough to say — the answering process IS the record's pid.
 * Everything else — dead pid, silent port, a DIFFERENT repo answering, or a
 * same-repo daemon that merely inherited the port — is stale, and stale
 * entries are never signalled.
 *
 * The pid comparison closes the one hole root can't: crash leaves a record,
 * the same repo restarts on the same port, and the OS later recycles the dead
 * pid to a stranger. Root matches, pid is alive — but it is not THIS daemon,
 * and signalling it would hit an unrelated process. A daemon that predates the
 * `pid` field in /api/meta is verified the old way (root only).
 */
export async function verifyDaemon(rec: DaemonRecord, timeoutMs = 1500): Promise<DaemonStatus> {
  if (!pidAlive(rec.pid)) return 'stale';
  const meta = await probeMeta(rec.port, timeoutMs);
  if (!meta) return 'stale';
  if (meta.pid !== undefined && meta.pid !== rec.pid) return 'stale';
  return resolve(meta.repo) === resolve(rec.root) ? 'live' : 'stale';
}

/** All records, each carrying its verified status, probed concurrently. */
export async function listVerifiedDaemons(dir = daemonsDir(), timeoutMs = 1500): Promise<VerifiedDaemon[]> {
  const recs = await listDaemonRecords(dir);
  return Promise.all(recs.map(async (r) => ({ ...r, status: await verifyDaemon(r, timeoutMs) })));
}

/* ------------------------------------------------------------------ */
/* Stopping                                                            */
/* ------------------------------------------------------------------ */

export type StopOutcome = 'graceful' | 'signal' | 'refused-stale' | 'failed';

/**
 * Stop a verified daemon. Graceful first; SIGTERM only as the fallback, and
 * only because verification just vouched for the pid. Returns which path ran,
 * so callers can say so instead of pretending there is one kind of stop.
 *
 * Success is EARNED, not assumed: the record is removed and 'graceful'/'signal'
 * returned only after the pid is confirmed gone. A daemon that outlives the
 * wait keeps its record — the registry must never forget a daemon that still
 * exists, or `baton ps` goes blind to the very process holding the port.
 */
export async function stopDaemon(rec: DaemonRecord, dir = daemonsDir(), waitMs = 5000): Promise<StopOutcome> {
  if ((await verifyDaemon(rec)) !== 'live') {
    // Symmetric with the mid-flight re-check below: a record whose pid is
    // provably gone is a corpse and leaves with us. A record that failed
    // verification with its pid still alive (silent port, root mismatch — or
    // just a probe timeout on a loaded box) is kept: deleting it on a flap
    // would blind `baton ps` to a process that may well still hold the port.
    if (!pidAlive(rec.pid)) await removeDaemonRecord(rec.pid, rec.port, dir);
    return 'refused-stale';
  }
  let path: Exclude<StopOutcome, 'refused-stale' | 'failed'> = 'signal';
  try {
    const res = await fetch(`http://127.0.0.1:${rec.port}/api/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) path = 'graceful';
  } catch { /* endpoint absent, daemon wedged — fall through to the signal */ }
  if (path === 'signal') {
    // The graceful attempt above can take seconds (its fetch timeout is 3s) —
    // long enough for the daemon to exit on its own and, in principle, for
    // the OS to hand its pid to something else. Re-check at the last instant:
    // a pid that died during the attempt is never signalled. (A wedged daemon
    // — pid alive, port silent — still gets the SIGTERM; that fallback is the
    // whole reason this branch exists, so only the pid is re-checked, never
    // the port.)
    if (!pidAlive(rec.pid)) {
      await removeDaemonRecord(rec.pid, rec.port, dir);
      return 'refused-stale';
    }
    try {
      process.kill(rec.pid, 'SIGTERM');
    } catch {
      return 'failed';
    }
  }
  await waitForExit(rec.pid, waitMs);
  if (pidAlive(rec.pid)) return 'failed';
  await removeDaemonRecord(rec.pid, rec.port, dir);
  return path;
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

/* ------------------------------------------------------------------ */
/* Idle memory consolidation                                           */
/* ------------------------------------------------------------------ */

/**
 * Somewhere for the mechanical consolidation pass to run without anyone
 * asking for it.
 *
 * `consolidateFacts` is pure — facts in, operations out, no clock and no I/O —
 * and nothing below re-decides anything it decides. This is the runner, and it
 * owns exactly three judgements the pure pass cannot make:
 *
 *   1. **Idle means idle.** The pass never starts while a task is active, and
 *      work starting mid-pass CANCELS it rather than queueing behind it. A
 *      background sweep that competes with an agent for CPU makes Baton slower
 *      at the exact moment it is being used, and an agent that has to wait for
 *      housekeeping learns to distrust the tool.
 *   2. **Unchanged store, no pass.** The plan is a pure function of the facts,
 *      so re-running it over a store nothing has touched can only produce the
 *      operations already applied. Skipping is not an optimisation, it is the
 *      difference between a daemon that idles and one that grinds.
 *   3. **A failure is a log line.** This runs unattended next to the dashboard
 *      and the SSE bus; it may never throw into that event loop.
 *
 * Cancelled and busy passes are deliberately NOT recorded as passes, so the
 * work they skipped is picked up the next time the machine is quiet.
 */
export type ConsolidationStatus = 'ran' | 'unchanged' | 'busy' | 'cancelled' | 'failed';

export interface ConsolidationPassResult {
  status: ConsolidationStatus;
  /** Ids actually retired, in the order they were retired. */
  superseded: string[];
  /** Disagreements for a person. Never resolved here — see consolidate.ts. */
  contradictions: ReportOp[];
  error?: string;
}

export interface ConsolidationOptions {
  /** "Is the machine busy?" Defaults to: any task claimed or active. */
  isBusy?: () => boolean | Promise<boolean>;
  log?: (msg: string) => void;
}

/** Where the last completed pass is recorded — gitignored, per-machine. */
function consolidateStampFile(mainRoot: string): string {
  return join(mainRoot, '.baton', 'memory', 'consolidate.json');
}

/**
 * What the plan depends on, and nothing else. Re-anchoring rewrites fact files
 * without changing any of this, so a repair pass does not make consolidation
 * think there is work to do.
 */
function storeSignature(facts: MemoryFact[]): string {
  const h = createHash('sha1');
  for (const f of [...facts].sort((a, b) => a.id.localeCompare(b.id))) {
    h.update(`${f.id}\u0000${f.fingerprint}\u0000${f.createdAt}\u0000${f.supersedes ?? ''}\n`);
  }
  return h.digest('hex');
}

async function lastSignature(mainRoot: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(consolidateStampFile(mainRoot), 'utf-8')) as { signature?: unknown };
    return typeof raw.signature === 'string' ? raw.signature : null;
  } catch {
    return null; // never run here, or the stamp was lost — do the pass
  }
}

async function stampPass(
  mainRoot: string,
  signature: string,
  result?: Pick<ConsolidationPassResult, 'status' | 'superseded' | 'contradictions'>,
): Promise<void> {
  const file = consolidateStampFile(mainRoot);
  await mkdir(dirname(file), { recursive: true });
  // The OUTCOME is recorded beside the signature, not just the fact that a pass
  // happened. Without it "what did the last pass change?" is unanswerable the
  // moment the call returns, and the dashboard can only say a pass ran.
  const body = `${JSON.stringify({
    at: new Date().toISOString(),
    signature,
    ...(result ? {
      status: result.status,
      superseded: result.superseded,
      contradictions: result.contradictions,
    } : {}),
  }, null, 2)}\n`;
  // tmp + rename, like saveTasks / setBriefStatusAt / releaseSkill. Writing at
  // the destination opens it with O_TRUNC, so for the width of that call the
  // stamp on disk is a zero-byte file — and this file has more than one writer:
  // two daemons on one repo, or an idle tick racing `baton memory consolidate`,
  // which passes `isBusy: () => false` and so waits for nobody. A reader in that
  // window gets a parse error, which `lastConsolidationPass` reports as "no pass
  // has ever run here" and `lastSignature` reads as "do the pass again". The
  // pid keeps two DAEMONS' staging files apart; nothing here needs a lock,
  // because a pass stamps once and `startIdleConsolidation` will not overlap
  // itself.
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, body, 'utf-8');
  await rename(tmp, file);
}

/**
 * The last recorded pass, for a reader that wants the outcome rather than the
 * signature — `GET /api/memory/consolidation`.
 *
 * Returns null when no pass has run here. A stamp written before outcomes were
 * recorded still parses: its status reads as 'unchanged' with nothing retired,
 * which is the honest reading of "a pass happened and we did not keep what it
 * did" — better than inventing a status it never reported.
 */
export async function lastConsolidationPass(root: string): Promise<{
  status: ConsolidationStatus; at: number | null;
  superseded: string[]; contradictions: ReportOp[];
} | null> {
  const mainRoot = await mainRepoRoot(root);
  try {
    const raw = JSON.parse(await readFile(consolidateStampFile(mainRoot), 'utf-8')) as Record<string, unknown>;
    const at = typeof raw.at === 'string' ? Date.parse(raw.at) : NaN;
    return {
      status: (typeof raw.status === 'string' ? raw.status : 'unchanged') as ConsolidationStatus,
      at: Number.isFinite(at) ? at : null,
      superseded: Array.isArray(raw.superseded) ? raw.superseded.filter((x): x is string => typeof x === 'string') : [],
      contradictions: Array.isArray(raw.contradictions) ? raw.contradictions as ReportOp[] : [],
    };
  } catch {
    return null;
  }
}

/** The default sense of "someone is working": a task claimed or in flight. */
async function tasksInFlight(root: string): Promise<boolean> {
  // `tasksFile` for the path — never a hand-built one. The two agreed, which is
  // exactly why the drift would be silent: if the store moves its file, a
  // duplicated path reads somewhere nothing writes, gets ENOENT, and calls that
  // "no tasks", re-opening this gate with nothing failing to say so.
  //
  // Read the store HERE rather than through `loadTasks`, which catches its own
  // errors and returns [] for a missing, empty OR CORRUPT file. Routed through
  // it, "unreadable" arrived as "no tasks", which reads as "nobody is working"
  // — so a truncated tasks.json opened the gate and the pass rewrote memory
  // underneath a live agent. The comment below claimed the opposite for as long
  // as the catch was unreachable.
  //
  // Absent is knowable and means no tasks. Only UNREADABLE is unknown, and
  // unknown is treated as BUSY: skipping a pass costs nothing, running one over
  // a repo whose state we cannot see is the risk this gate exists to avoid.
  const mainRoot = await mainRepoRoot(root);
  let raw: string;
  try {
    raw = await readFile(tasksFile(mainRoot), 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return true;
  }
  // An EMPTY file is not the absent case. `saveTasks` writes tmp-then-rename,
  // so no reader ever observes a half-written store: a zero-byte or
  // whitespace-only tasks.json means something else truncated it, and that is a
  // state we cannot see rather than a store with no tasks in it. It falls to
  // the same rule as unparseable content one line down — `JSON.parse('')`
  // throws — and this short-circuit used to exempt it.
  if (!raw.trim()) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return true;
  }
  if (!Array.isArray(parsed)) return true;
  return (parsed as Task[]).some((t) => stateOf(t) === 'claimed' || stateOf(t) === 'active');
}

/**
 * Run the pass once, here, now. Shared by the daemon's idle timer and by
 * `baton memory consolidate` — one code path, so the manual command cannot
 * drift into being a different (or lesser) feature than the background one.
 */
export async function consolidateOnce(
  root: string,
  opts: ConsolidationOptions = {},
): Promise<ConsolidationPassResult> {
  const log = opts.log ?? ((m: string) => console.warn(m));
  const isBusy = opts.isBusy ?? (() => tasksInFlight(root));
  const superseded: string[] = [];
  let contradictions: ReportOp[] = [];
  try {
    if (await isBusy()) return { status: 'busy', superseded, contradictions };
    const mainRoot = await mainRepoRoot(root);
    const facts = await listMemories(root);
    const signature = storeSignature(facts);
    if (signature === (await lastSignature(mainRoot))) {
      return { status: 'unchanged', superseded, contradictions };
    }
    const ops = consolidateFacts(facts, { startedAt: Date.now() });
    contradictions = ops.filter((o): o is ReportOp => o.op === 'report');
    for (const op of ops) {
      if (op.op !== 'supersede') continue;
      // Checked before EVERY write, not once at the top: the pass is a series
      // of small writes precisely so it can stop between them.
      if (await isBusy()) return { status: 'cancelled', superseded, contradictions };
      // A refusal is REPORTED, not swallowed. `supersedeMemory` returns false
      // when the fact is already gone, or when the file's frontmatter names a
      // different fact than its name does — and the stamp below records the
      // post-pass signature either way, so the next tick reads `unchanged` and
      // this op is never retried. Silence would make a fact that cannot be
      // retired look exactly like one that was.
      if (await supersedeMemory(root, op.id, op.supersededBy, op.reason)) superseded.push(op.id);
      else log(`baton: consolidation could not retire '${op.id}' — it will not be retried until the store changes`);
    }
    // Stamp what the store looks like NOW — the pass just changed it, and the
    // pre-pass signature would make the next run redo a settled store.
    await stampPass(mainRoot, storeSignature(await listMemories(root)), {
      status: 'ran', superseded, contradictions,
    });
    return { status: 'ran', superseded, contradictions };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log(`baton: memory consolidation failed — ${error}`);
    return { status: 'failed', superseded, contradictions, error };
  }
}

/** Half an hour. Long enough that the pass is invisible, short enough that a
 *  store which just went quiet is tidy before anyone looks at it. */
export const CONSOLIDATE_INTERVAL_MS = 1_800_000;

export interface IdleConsolidation {
  /** One attempt. Exposed so the behaviour is testable without a clock. */
  tick(): Promise<ConsolidationPassResult>;
  stop(): void;
}

/**
 * Wire the pass to an idle timer. Never overlaps itself, never throws, and the
 * timer is unref'd so it cannot hold the process open on its own.
 */
export function startIdleConsolidation(
  opts: ConsolidationOptions & {
    root: string;
    intervalMs?: number;
    /** Injectable for tests; the daemon always gets `consolidateOnce`. */
    run?: (root: string, o: ConsolidationOptions) => Promise<ConsolidationPassResult>;
  },
): IdleConsolidation {
  const log = opts.log ?? ((m: string) => console.warn(m));
  const run = opts.run ?? consolidateOnce;
  let inFlight = false;
  const tick = async (): Promise<ConsolidationPassResult> => {
    if (inFlight) return { status: 'busy', superseded: [], contradictions: [] };
    inFlight = true;
    try {
      return await run(opts.root, { ...(opts.isBusy ? { isBusy: opts.isBusy } : {}), log });
    } catch (e) {
      // `consolidateOnce` handles its own failures; this catches the ones it
      // cannot — an injected runner, or a bug in the runner itself. Either way
      // the daemon keeps its timer and its other duties.
      const error = e instanceof Error ? e.message : String(e);
      log(`baton: memory consolidation failed — ${error}`);
      return { status: 'failed', superseded: [], contradictions: [], error };
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, opts.intervalMs ?? CONSOLIDATE_INTERVAL_MS);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}
