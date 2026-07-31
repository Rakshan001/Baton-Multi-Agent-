/**
 * `baton serve [--port]` — start the local JSON API the web dashboard reads.
 *
 * `--host` is the one flag here with real blast radius: it takes a tool whose
 * entire access control was "the connection is local" and puts it on a network.
 * Validation is therefore strict and fails closed — `serve()` itself refuses to
 * bind a non-loopback address with no members registered.
 */
import { serve } from '../server.js';

export interface ServeCmdOpts {
  port?: string;
  write?: boolean;
  host?: string;
  allowedHost?: string[];
}

/** Reject anything that is not a bare hostname or IP literal before it reaches bind(). */
function validBindAddr(addr: string): boolean {
  return /^[A-Za-z0-9._:-]+$/.test(addr) && addr.length <= 255;
}

export async function serveCmd(opts: ServeCmdOpts = {}): Promise<void> {
  const port = opts.port ? parseInt(opts.port, 10) : 7077;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${opts.port}`);
    process.exitCode = 1;
    return;
  }

  if (opts.host !== undefined && !validBindAddr(opts.host)) {
    console.error(`Invalid --host: ${opts.host}`);
    process.exitCode = 1;
    return;
  }
  const allowedHosts = (opts.allowedHost ?? []).filter(Boolean);
  if (allowedHosts.some((h) => !validBindAddr(h))) {
    console.error('Invalid --allowed-host value.');
    process.exitCode = 1;
    return;
  }

  await serve({
    port,
    writeEnabled: !!opts.write,
    ...(opts.host ? { host: opts.host } : {}),
    ...(allowedHosts.length ? { allowedHosts } : {}),
  });
}
