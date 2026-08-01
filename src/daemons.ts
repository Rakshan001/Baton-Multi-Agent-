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
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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
