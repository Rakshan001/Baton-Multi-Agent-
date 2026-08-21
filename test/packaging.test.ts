// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What actually ends up in the published tarball.
 *
 * `baton serve` resolves the dashboard at `../web/dist` relative to its own
 * `dist/server.js`, so an installed package must carry `web/dist`. It did not:
 * `files` listed only `dist`, and even once `web/dist` was added npm kept
 * dropping it, because with no `.npmignore` in `web/` npm falls back to
 * `web/.gitignore` — which ignores `dist/`. The allowlist does not override a
 * nested ignore file.
 *
 * Nothing else catches this. The repo builds, every test passes, and the defect
 * only appears on someone else's machine after `npm i -g`, as Baton's own
 * "dashboard not built" message. So this asks npm directly rather than
 * asserting on the config that was already wrong once.
 *
 * The second half asserts on the manifest, which is a different question with a
 * different failure mode: those defects are not visible in a file listing at
 * all — a name npm will refuse, a version the binary misreports, a dependency
 * that resolves here and nowhere else.
 */
import { describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const built = existsSync(new URL('../web/dist/index.html', import.meta.url));
const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf-8'));

describe('the published package', () => {
  // Needs a real dashboard build to pack. Skipped rather than faked, so a
  // green run on a repo without `npm run build --prefix web` never reads as
  // proof that shipping works.
  it.skipIf(!built)('ships the dashboard baton serve looks for', async () => {
    const { stdout, stderr } = await execa('npm', ['pack', '--dry-run'], { cwd: repo, reject: false });
    const listing = `${stdout}\n${stderr}`;

    expect(listing).toContain('web/dist/index.html');
    // The entry point alone is not a dashboard — it loads its bundle by name.
    expect(listing).toMatch(/web\/dist\/assets\/.+\.js/);
    expect(listing).toMatch(/web\/dist\/assets\/.+\.css/);
  }, 120_000);
});

/** Bare specifier → the package that must be installed for it to resolve. */
function packageOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tsFiles(full)));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Every third-party package `src/` needs at RUNTIME (type-only imports erase). */
async function runtimeDependencies(): Promise<Set<string>> {
  const found = new Set<string>();
  for (const file of await tsFiles(join(repo, 'src'))) {
    const src = await readFile(file, 'utf-8');
    const specifiers = [
      ...[...src.matchAll(/(?:^|\n)\s*import\s+(type\s+)?[\s\S]*?from\s*['"]([^'"]+)['"]/g)]
        .filter((m) => !m[1])
        .map((m) => m[2]),
      ...[...src.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
      ...[...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
    ];
    for (const s of specifiers) {
      if (s.startsWith('.') || s.startsWith('node:')) continue;
      found.add(packageOf(s));
    }
  }
  return found;
}

describe('the package manifest', () => {
  it('claims a name that is actually free on npm', () => {
    // `baton-cli` is taken by an unrelated tool, as are `baton`, `create-baton`,
    // `baton-mcp`, `baton-dev` and `batonjs`. Publishing was never going to work
    // under the old name; this pins the one that does.
    expect(pkg.name).toBe('batonhq');
  });

  it('carries a semver version', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
  });

  it('exposes the binary people actually type', () => {
    // The npm id changed; the command did not. Nothing in the docs says
    // `batonhq new "…"`, and three re-entry paths spawn this exact path.
    expect(pkg.bin).toEqual({ baton: 'dist/cli.js' });
  });

  it('allowlists the readme and licence npm renders and AGPL requires', () => {
    expect(pkg.files).toContain('dist');
    expect(pkg.files).toContain('web/dist');
    expect(pkg.files).toContain('README.md');
    expect(pkg.files).toContain('LICENSE');
  });

  it('builds both workspaces before packing', () => {
    // prepack, not prepublishOnly: prepack also runs for `npm pack`, so the
    // rehearsal above exercises the same path as the real publish.
    expect(pkg.scripts.prepack).toBe('node scripts/prepack.mjs');
    expect(existsSync(join(repo, 'scripts/prepack.mjs'))).toBe(true);
  });

  it('runs no install scripts', () => {
    // Install scripts break `npm i --ignore-scripts`, which security-conscious
    // teams set globally — and they are a trust smell on a tool that already
    // asks to touch your git repos.
    expect(pkg.scripts.preinstall).toBeUndefined();
    expect(pkg.scripts.install).toBeUndefined();
    expect(pkg.scripts.postinstall).toBeUndefined();
  });

  it('states the Node floor it enforces at runtime', () => {
    expect(pkg.engines.node).toBe('>=24');
  });

  it('points at a homepage and an issue tracker', () => {
    // npm renders both on the package page; without them the only route to
    // support is guessing.
    expect(pkg.homepage).toMatch(/^https:\/\//);
    expect(pkg.bugs.url).toMatch(/^https:\/\//);
  });

  it('keeps the AGPL declaration npm shows on the package page', () => {
    expect(pkg.license).toBe('AGPL-3.0-or-later');
  });

  it('declares every third-party package src/ imports at runtime', async () => {
    // The phantom-dependency trap: `zod` resolved for a year purely because
    // @modelcontextprotocol/sdk depends on it and npm hoists it to the top of
    // node_modules. Under pnpm or Yarn PnP — or the day the SDK changes its
    // zod range — `baton mcp` dies on an import the package never declared.
    const declared = new Set(Object.keys(pkg.dependencies ?? {}));
    const undeclared = [...(await runtimeDependencies())].filter((d) => !declared.has(d));
    expect(undeclared).toEqual([]);
  });
});
