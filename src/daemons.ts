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
 * been verified: the pid must be alive AND the port must answer `/api/meta`
 * with the SAME repo root. Pid reuse and port reuse both fail the root match;
 * an entry that fails is "stale" and may only be cleaned up, never stopped.
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
): Promise<{ repo: string; version?: string } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/meta`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { repo?: unknown; version?: unknown };
    if (typeof body.repo !== 'string') return null;
    return { repo: body.repo, ...(typeof body.version === 'string' ? { version: body.version } : {}) };
  } catch {
    return null;
  }
}

/**
 * live ⇔ the pid is alive AND the port answers with the same root. Everything
 * else — dead pid, silent port, or a DIFFERENT repo answering (pid or port
 * reuse) — is stale, and stale entries are never signalled.
 */
export async function verifyDaemon(rec: DaemonRecord, timeoutMs = 1500): Promise<DaemonStatus> {
  if (!pidAlive(rec.pid)) return 'stale';
  const meta = await probeMeta(rec.port, timeoutMs);
  if (!meta) return 'stale';
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
 */
export async function stopDaemon(rec: DaemonRecord, dir = daemonsDir()): Promise<StopOutcome> {
  if ((await verifyDaemon(rec)) !== 'live') return 'refused-stale';
  try {
    const res = await fetch(`http://127.0.0.1:${rec.port}/api/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      await waitForExit(rec.pid, 5000);
      await removeDaemonRecord(rec.pid, rec.port, dir);
      return 'graceful';
    }
  } catch { /* endpoint absent, daemon wedged — fall through to the signal */ }
  try {
    process.kill(rec.pid, 'SIGTERM');
  } catch {
    return 'failed';
  }
  await waitForExit(rec.pid, 5000);
  await removeDaemonRecord(rec.pid, rec.port, dir);
  return 'signal';
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
}
