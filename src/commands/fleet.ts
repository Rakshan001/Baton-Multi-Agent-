/**
 * `baton ps` / `baton stop` — the fleet from the terminal.
 *
 * The CLI half of src/daemons.ts, and the escape hatch when no dashboard is
 * up: both work with every daemon stopped, because the registry is files.
 * `ps` never lies about freshness — every row is verified (pid alive AND the
 * port answers with the same root) before it is printed as live.
 */
import { resolve } from 'node:path';
import {
  type VerifiedDaemon, listVerifiedDaemons, removeDaemonRecord, stopDaemon,
} from '../daemons.js';

function uptime(startedAt: string): string {
  const t = Date.parse(startedAt);
  // t <= 0 is the epoch sentinel a record missing startedAt falls back to —
  // "20661d" would be a confident lie about a file we know nothing about.
  if (!Number.isFinite(t) || t <= 0) return '?';
  const ms = Date.now() - t;
  if (ms < 0) return '?';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d`;
}

export async function psCmd(): Promise<void> {
  const daemons = await listVerifiedDaemons();
  if (!daemons.length) {
    console.log('No Baton daemons on this machine. Start one:  baton serve --write');
    return;
  }
  console.log('PORT   PID     UPTIME   STATUS  PATH');
  for (const d of daemons) {
    console.log(`${String(d.port).padEnd(6)} ${String(d.pid).padEnd(7)} ${uptime(d.startedAt).padEnd(8)} ${d.status.padEnd(7)} ${d.root}`);
  }
  const stale = daemons.filter((d) => d.status === 'stale');
  if (stale.length) {
    console.log(`\n  ${stale.length} stale record${stale.length === 1 ? '' : 's'} (daemon gone, file left by a crash).`);
    console.log('  Clean up:  baton daemon stop <port>   — a stale record is only ever deleted, never signalled.');
  }
}

/** Match `<port>` or a path (relative or absolute) against verified records. */
function match(daemons: VerifiedDaemon[], target: string): VerifiedDaemon[] {
  if (/^\d+$/.test(target)) return daemons.filter((d) => d.port === Number(target));
  const want = resolve(target);
  return daemons.filter((d) => resolve(d.root) === want);
}

export async function stopCmd(target: string): Promise<void> {
  const daemons = await listVerifiedDaemons();
  const hits = match(daemons, target);
  if (!hits.length) {
    const known = daemons.map((d) => `${d.port} (${d.root})`).join(', ') || '(none)';
    throw new Error(`no daemon matches '${target}' — running: ${known}`);
  }
  // A path can legitimately match twice (D4: two daemons, one repo — the exact
  // mistake this command exists for), so act on every hit and say so per row.
  for (const d of hits) {
    if (d.status === 'stale') {
      await removeDaemonRecord(d.pid, d.port);
      console.log(`✓ cleaned up stale record for port ${d.port} (${d.root}) — the daemon was already gone`);
      continue;
    }
    const outcome = await stopDaemon(d);
    if (outcome === 'graceful') console.log(`✓ stopped daemon on port ${d.port} (${d.root})`);
    else if (outcome === 'signal') console.log(`✓ stopped daemon on port ${d.port} (${d.root}) by SIGTERM — it predates /api/shutdown or was not answering`);
    else if (outcome === 'refused-stale') console.log(`· port ${d.port} went away on its own before we acted`);
    else throw new Error(`could not stop pid ${d.pid} on port ${d.port} — it did not exit (or this process may not signal it); its record stays until it is truly gone`);
  }
}
