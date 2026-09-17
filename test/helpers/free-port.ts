// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Ask the kernel for a port nobody else is using.
 *
 * Vitest runs test FILES in parallel forks. Every E2E suite here spawns a real
 * `node dist/cli.js serve`, so a hardcoded port number is not a detail — it is
 * a race with whatever other file happened to pick the same number, and two of
 * those races have already shown up as real, confusing failures. Random picks
 * inside a fixed band are no better: they collide more often, not less, and
 * they collide non-reproducibly.
 *
 * Binding `:0` makes the kernel hand out a free ephemeral port, which is the
 * only allocation that actually knows what is in use. We then close the socket
 * and hand the number to the daemon.
 *
 * `serve --port 0` is NOT an option: `src/commands/serve.ts` rejects `port < 1`,
 * and the daemon reports `opts.port` rather than the port it truly bound, so
 * there is nothing to read back.
 *
 * There is an unavoidable bind → release → rebind window, so call this as LATE
 * as possible — in the `beforeAll`/`it` immediately before the spawn, never at
 * module scope where it would be reserved for the whole file's lifetime.
 *
 * ```ts
 * const port = await freePort();
 * child = spawn('node', [DIST_CLI, 'serve', '-p', String(port)], { cwd });
 * ```
 */
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}
