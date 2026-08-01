/**
 * The daemon fleet registry (src/daemons.ts).
 *
 * The property everything else leans on: a record is a CLAIM. Nothing is shown
 * live — and nothing is ever signalled — until the pid is alive AND the port
 * answers /api/meta with the SAME root. These tests pin the verifier's
 * refusals (dead pid, silent port, wrong repo answering = pid/port reuse) as
 * hard as its acceptances, because the refusals are what make `stop` safe to
 * point at a pid at all.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DaemonRecord, cleanDaemonRecord, listDaemonRecords, listVerifiedDaemons, pidAlive,
  probeMeta, recordPath, removeDaemonRecord, stopDaemon, verifyDaemon, writeDaemonRecord,
} from '../src/daemons.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'baton-fleet-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const rec = (over: Partial<DaemonRecord> = {}): DaemonRecord => ({
  pid: process.pid, port: 7077, root: '/tmp/repo', startedAt: new Date().toISOString(),
  version: '0.0.1', writeEnabled: true, host: false, ...over,
});

/** A stand-in daemon: answers /api/meta with a chosen root on an OS-picked
 *  port. `pid` optional — a daemon that omits it predates the identity field. */
async function fakeDaemon(repo: string, pid?: number): Promise<{ port: number; close: () => Promise<void> }> {
  const srv: Server = createServer((req, res) => {
    if (req.url === '/api/meta') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ repo, version: 'test', ...(pid !== undefined ? { pid } : {}) }));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  return { port, close: () => new Promise((r) => srv.close(() => r())) };
}

describe('record lifecycle', () => {
  it('writes, lists and removes one file per daemon', async () => {
    await writeDaemonRecord(rec({ port: 7001 }), dir);
    await writeDaemonRecord(rec({ pid: process.pid + 1, port: 7002, root: '/tmp/other' }), dir);
    expect((await listDaemonRecords(dir)).map((r) => r.port).sort()).toEqual([7001, 7002]);
    await removeDaemonRecord(process.pid, 7001, dir);
    expect((await listDaemonRecords(dir)).map((r) => r.port)).toEqual([7002]);
  });

  it('one corrupt file must not hide the rest', async () => {
    await writeDaemonRecord(rec({ port: 7003 }), dir);
    await writeFile(join(dir, '999-7004.json'), '{ not json');
    await writeFile(join(dir, '999-7005.json'), JSON.stringify({ pid: 'NaN', port: 7005 }));
    const listed = await listDaemonRecords(dir);
    expect(listed.map((r) => r.port)).toEqual([7003]);
  });

  it('an absent registry dir means an empty fleet, not an error', async () => {
    expect(await listDaemonRecords(join(dir, 'never-made'))).toEqual([]);
  });

  it('rejects records that could not name a real daemon', () => {
    expect(cleanDaemonRecord(null)).toBeNull();
    expect(cleanDaemonRecord({ pid: 0, port: 7077, root: '/r' })).toBeNull();
    expect(cleanDaemonRecord({ pid: 12, port: 70777, root: '/r' })).toBeNull();
    expect(cleanDaemonRecord({ pid: 12, port: 7077, root: '' })).toBeNull();
    expect(cleanDaemonRecord(rec())).not.toBeNull();
  });

  it('names the file by pid AND port, so a reused pid cannot collide', () => {
    expect(recordPath(12, 7077, dir)).toBe(join(dir, '12-7077.json'));
  });
});

describe('verification — a record is a claim', () => {
  it('a live pid whose port answers with the same root is live', async () => {
    const d = await fakeDaemon('/tmp/repo');
    try {
      expect(await verifyDaemon(rec({ port: d.port }))).toBe('live');
    } finally { await d.close(); }
  });

  it('a dead pid is stale before the network is even asked', async () => {
    // Pid 2^22-ish beyond pid_max on macOS/Linux defaults; combined with a
    // port nothing listens on, either check alone would fail — the pid check
    // must fail FIRST (no probe timeout spent on a corpse).
    const t0 = Date.now();
    expect(await verifyDaemon(rec({ pid: 2 ** 24, port: 1 }))).toBe('stale');
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('a silent port is stale even though the pid lives', async () => {
    // Our own pid is alive; port 1 answers nothing.
    expect(await verifyDaemon(rec({ port: 1 }), 300)).toBe('stale');
  });

  it('a DIFFERENT repo answering is stale — the pid/port-reuse guard', async () => {
    const d = await fakeDaemon('/somewhere/else');
    try {
      expect(await verifyDaemon(rec({ port: d.port }))).toBe('stale');
    } finally { await d.close(); }
  });

  it('the SAME repo answering for a DIFFERENT pid is stale — the same-port-restart guard', async () => {
    // The hole root alone can't close: crash leaves a record, the same repo
    // restarts on the same port, the OS later recycles the dead pid to a
    // stranger. Root matches, the record's pid is alive — but the process
    // answering the port is not it, and signalling would hit that stranger.
    const d = await fakeDaemon('/tmp/repo', process.pid + 1);
    try {
      expect(await verifyDaemon(rec({ port: d.port }))).toBe('stale');
    } finally { await d.close(); }
  });

  it('a daemon that reports its own pid back is live — and one that predates the field still is', async () => {
    const withPid = await fakeDaemon('/tmp/repo', process.pid);
    const legacy = await fakeDaemon('/tmp/repo');
    try {
      expect(await verifyDaemon(rec({ port: withPid.port }))).toBe('live');
      expect(await verifyDaemon(rec({ port: legacy.port }))).toBe('live');
    } finally { await withPid.close(); await legacy.close(); }
  });

  it('pidAlive: own pid yes, absurd pid no', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 24)).toBe(false);
  });

  it('probeMeta returns null rather than throwing, whatever the port does', async () => {
    expect(await probeMeta(1, 300)).toBeNull();
  });

  it('listVerifiedDaemons carries a status per record', async () => {
    const d = await fakeDaemon('/tmp/repo');
    try {
      await writeDaemonRecord(rec({ port: d.port }), dir);
      await writeDaemonRecord(rec({ pid: 2 ** 24, port: 1 }), dir);
      const all = await listVerifiedDaemons(dir, 300);
      const byPort = new Map(all.map((v) => [v.port, v.status]));
      expect(byPort.get(d.port)).toBe('live');
      expect(byPort.get(1)).toBe('stale');
    } finally { await d.close(); }
  });
});

describe('stopDaemon', () => {
  it('refuses a stale record outright — no signal is ever sent on a claim', async () => {
    expect(await stopDaemon(rec({ pid: 2 ** 24, port: 1 }), dir)).toBe('refused-stale');
  });

  it('refusing a record whose pid is provably GONE also buries it', async () => {
    // Symmetric with the mid-flight re-check: a corpse found at the door
    // leaves with us, so the next poll doesn't re-render the row we just
    // told the user was already gone.
    const r = rec({ pid: 2 ** 24, port: 1 });
    await writeDaemonRecord(r, dir);
    expect(await stopDaemon(r, dir)).toBe('refused-stale');
    expect((await listDaemonRecords(dir)).length).toBe(0);
  });

  it('refusing a record whose pid still LIVES keeps it — a probe flap must not eat a real daemon\'s record', async () => {
    const r = rec({ port: 1 }); // our own pid, silent port: fails verification, pid alive
    await writeDaemonRecord(r, dir);
    expect(await stopDaemon(r, dir)).toBe('refused-stale');
    expect((await listDaemonRecords(dir)).length).toBe(1);
  });

  it('a daemon that outlives the wait is FAILED, and keeps its record', async () => {
    // A wedged daemon: verification passes (it answers /api/meta), it has no
    // /api/shutdown, and it ignores SIGTERM. Reporting 'signal' here would be
    // a lie twice over — and deleting the record would blind `baton ps` to
    // the very process still holding the port.
    const { execa } = await import('execa');
    const child = execa('node', ['-e', `
      process.on('SIGTERM', () => {}); // wedged on purpose
      const http = require('node:http');
      const srv = http.createServer((req, res) => {
        if (req.url === '/api/meta') { res.writeHead(200); res.end(JSON.stringify({ repo: '/tmp/repo' })); }
        else { res.writeHead(404); res.end(); }
      });
      srv.listen(0, '127.0.0.1', () => console.log((srv.address()).port));
    `], { reject: false });
    try {
      const port = await new Promise<number>((resolvePort, rejectPort) => {
        const t = setTimeout(() => rejectPort(new Error('child never listened')), 5000);
        child.stdout?.once('data', (b) => { clearTimeout(t); resolvePort(Number(String(b).trim())); });
      });
      const r = rec({ pid: child.pid!, port });
      await writeDaemonRecord(r, dir);
      expect(await stopDaemon(r, dir, 400)).toBe('failed');
      expect(pidAlive(child.pid!)).toBe(true);
      // The record survives: the registry never forgets a daemon that exists.
      expect((await listDaemonRecords(dir)).length).toBe(1);
    } finally {
      child.kill('SIGKILL');
      await child;
    }
  }, 15_000);

  it('falls back to SIGTERM when the daemon has no /api/shutdown', async () => {
    // A child that serves /api/meta (so verification passes) but 404s the
    // shutdown endpoint — exactly an older daemon. It must die by signal.
    const { execa } = await import('execa');
    const child = execa('node', ['-e', `
      const http = require('node:http');
      const srv = http.createServer((req, res) => {
        if (req.url === '/api/meta') { res.writeHead(200); res.end(JSON.stringify({ repo: '/tmp/repo' })); }
        else { res.writeHead(404); res.end(); }
      });
      srv.listen(0, '127.0.0.1', () => console.log((srv.address()).port));
    `], { reject: false });
    const port = await new Promise<number>((resolvePort, rejectPort) => {
      const t = setTimeout(() => rejectPort(new Error('child never listened')), 5000);
      child.stdout?.once('data', (b) => { clearTimeout(t); resolvePort(Number(String(b).trim())); });
    });
    const r = rec({ pid: child.pid!, port });
    await writeDaemonRecord(r, dir);
    expect(await stopDaemon(r, dir)).toBe('signal');
    await child; // reaped
    expect(pidAlive(child.pid!)).toBe(false);
    // And the record is gone with it.
    expect((await listDaemonRecords(dir)).length).toBe(0);
  }, 15_000);
});
