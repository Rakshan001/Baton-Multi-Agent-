// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The three questions `select.ts` asks before choosing the Orca backend.
 *
 * Separate from `orca.ts` because these run on the *decision* path — before any
 * executor exists — and because `resolveBin` is a PATH lookup rather than a CLI
 * call. Every one of them answers `null`/`false` rather than throwing: this is
 * reached from dispatch, and a probe that rejects stops dispatch entirely.
 */
import { execa } from 'execa';
import { orcaBinary, orcaEnv, parseOrcaEnvelope, repoListArgs, statusArgs } from './orca-cli.js';
import type { OrcaProbe } from './select.js';

const PROBE_TIMEOUT_MS = 5_000;

async function call(bin: string, args: string[]): Promise<ReturnType<typeof parseOrcaEnvelope>> {
  try {
    const { stdout } = await execa(bin, args, {
      env: orcaEnv(),
      extendEnv: false,
      timeout: PROBE_TIMEOUT_MS,
      reject: false,
    });
    return parseOrcaEnvelope(stdout);
  } catch (e) {
    return { ok: false, code: 'orca_unreachable', message: (e as Error).message };
  }
}

export function createOrcaProbe(): OrcaProbe {
  return {
    /**
     * `command -v` on posix, `where` on win32 — the same shape the graphify
     * probe uses. The configured name is honoured, but an empty one falls back
     * to the platform default, because on Linux the wrong default starts the
     * GNOME screen reader.
     */
    async resolveBin(bin: string): Promise<string | null> {
      const name = bin.trim() || orcaBinary();
      const [cmd, args] = process.platform === 'win32'
        ? ['where', [name]]
        : ['command', ['-v', name]];
      try {
        const { stdout, exitCode } = await execa(cmd, args, {
          timeout: PROBE_TIMEOUT_MS,
          reject: false,
          shell: process.platform !== 'win32',
        });
        const first = stdout.split('\n')[0]?.trim();
        return exitCode === 0 && first ? first : null;
      } catch {
        return null;
      }
    },

    /** Installed is not running. This is the question P2-E2 exists for. */
    async status(bin: string): Promise<{ ok: boolean; reason?: string }> {
      const out = await call(bin, statusArgs());
      return out.ok ? { ok: true } : { ok: false, reason: out.message };
    },

    /**
     * `null` is "could not ask", and `select.ts` treats it as such — an empty
     * array would be a claim that Orca serves nothing, which a failed call
     * cannot support.
     */
    async repos(bin: string): Promise<string[] | null> {
      const out = await call(bin, repoListArgs());
      if (!out.ok || !Array.isArray(out.result)) return null;
      return out.result
        .map((repo) => (repo as { path?: unknown } | null)?.path)
        .filter((path): path is string => typeof path === 'string' && path.length > 0);
    },
  };
}
