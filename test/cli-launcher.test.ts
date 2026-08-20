// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `dist/cli.js` is a launcher: it checks the Node floor, then hands off to
 * dist/main.js. It is also, unavoidably, an ADDRESS — three code paths re-enter
 * Baton by spawning `process.argv[1]` (src/commands/guard.ts respawns it for
 * snapshots; src/commands/new.ts and claim.ts bake it into a git commit hook),
 * and ten E2E tests spawn it directly.
 *
 * So the launcher's contract is not "it runs" — it is that argv, stdout, and
 * the exit code survive the extra hop unchanged. Those are what these tests
 * pin down, because those are what a re-entry path notices when they break.
 *
 * Gated on dist/cli.js being built (run `npm run build` first).
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execa } from 'execa';

const DIST_CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const hasDist = existsSync(DIST_CLI);

const cli = (args: string[]) =>
  execa(process.execPath, [DIST_CLI, ...args], { reject: false, timeout: 30_000 });

describe.runIf(hasDist)('the baton launcher', () => {
  it('reports the version the package actually publishes', async () => {
    // The version was hardcoded in the CLI while package.json moved
    // independently — a published binary that misreports itself makes every
    // bug report ambiguous ("which build is that?").
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf-8'));
    const { stdout, exitCode } = await cli(['--version']);
    expect(stdout.trim()).toBe(pkg.version);
    expect(exitCode).toBe(0);
  });

  it('forwards arguments through the hop to the real program', async () => {
    const { stdout, exitCode } = await cli(['--help']);
    expect(exitCode).toBe(0);
    // A launcher that dropped argv would print the top-level help for no
    // command, or nothing at all.
    expect(stdout).toContain('baton');
    expect(stdout).toContain('setup');
  });

  it('forwards a non-zero exit code instead of swallowing it', async () => {
    // Scripts and git hooks branch on this. A launcher that awaited the import
    // and then fell off the end would exit 0 on every failure.
    const { exitCode } = await cli(['definitely-not-a-command']);
    expect(exitCode).not.toBe(0);
  });

  it('routes a real subcommand, so re-entry by path still works', async () => {
    // `guard.ts` respawns argv[1] with a subcommand; this is that shape.
    const { exitCode, stdout } = await cli(['path', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('worktree path');
  });

  it('keeps its shebang, since npm links it as an executable', async () => {
    const src = await readFile(DIST_CLI, 'utf-8');
    expect(src.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('defers the heavy module graph to the handoff', async () => {
    // The guarantee behind the launcher: on an unsupported runtime the message
    // must come from OUR check, which is only true while the launcher's own
    // graph stays small. If someone adds a static import of the command tree
    // here, that graph is parsed first and the guarantee is quietly gone.
    const src = await readFile(DIST_CLI, 'utf-8');
    const staticImports = [...src.matchAll(/^import\s.*?from\s+['"](.+?)['"]/gm)].map((m) => m[1]);
    expect(staticImports).toEqual(['./util/node-preflight.js']);
    expect(src).toContain("import('./main.js')");
  });
});
