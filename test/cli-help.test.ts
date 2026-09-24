// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `baton --help` lists ~50 commands. Flat and alphabet-free, it was a wall;
 * grouped by what you are trying to do, it is a menu. These tests hold the
 * grouping in place. Gated on dist/cli.js (run `npm run build` first).
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execa } from 'execa';

const DIST_CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const MAIN_SRC = new URL('../src/main.ts', import.meta.url);

const cli = (args: string[]) =>
  execa(process.execPath, [DIST_CLI, ...args], { reject: false, timeout: 30_000 });

const HEADINGS = ['Start work:', 'Coordinate:', 'Hand off:', 'Knowledge & memory:', 'Repair:', 'Daemon & dashboard:', 'Internal:'];

describe.runIf(existsSync(DIST_CLI))('baton --help', { timeout: 30_000 }, () => {
  // This test FAILS ON PURPOSE when someone adds a top-level command without
  // giving it a group: add the new command's name to GROUP in src/main.ts.
  // An ungrouped command silently lands under a stray "Commands:" heading.
  it('puts every top-level command in a group', async () => {
    const src = await readFile(MAIN_SRC, 'utf-8');
    const names = [...src.matchAll(/(?:^program|= program)\s*\.command\('([\w-]+)'/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(40);
    const group = src.slice(src.indexOf('const GROUP'), src.indexOf('};', src.indexOf('const GROUP')));
    const missing = names.filter((n) => !new RegExp(`['\\s]${n}'?:`).test(group));
    expect(missing).toEqual([]);

    const { stdout, exitCode } = await cli(['--help']);
    expect(exitCode).toBe(0);
    expect(stdout).not.toMatch(/^Commands:/m);
    // Every heading, in this order — not the order commands happen to be defined.
    const printed = [...stdout.matchAll(/^(\S[^\n]*:)$/gm)].map((m) => m[1]).filter((h) => HEADINGS.includes(h));
    expect(printed).toEqual(HEADINGS);
    expect(stdout).toMatch(/^Internal:\n  mcp /m); // mcp stays visible
    expect(stdout).toMatch(/^Examples:/m);
  });

  it('hides the internal plumbing but still runs it', async () => {
    const { stdout } = await cli(['--help']);
    for (const name of ['stamp-commit', 'mcp-bridge', 'guard', 'snapshot']) {
      expect(stdout).not.toMatch(new RegExp(`^  ${name}\\b`, 'm'));
      const r = await cli([name, '--help']);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(`Usage: baton ${name}`);
    }
  });
});
