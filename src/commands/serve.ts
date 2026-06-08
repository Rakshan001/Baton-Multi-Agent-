/**
 * `baton serve [--port]` — start the local JSON API the web dashboard reads.
 */
import { serve } from '../server.js';

export async function serveCmd(opts: { port?: string } = {}): Promise<void> {
  const port = opts.port ? parseInt(opts.port, 10) : 7077;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${opts.port}`);
    process.exitCode = 1;
    return;
  }
  await serve(port);
}
