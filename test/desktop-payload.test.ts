// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Where a packaged desktop build looks for the bundled CLI payload.
 *
 * The packaged app ships the CLI under
 * `<resources>/<commandName>/package/dist/` (config/scripts/stage-payload.mjs
 * plus `extraResources` in config/electron-builder.cjs). `spawn.ts` knew that;
 * `fleet.ts` did not, and searched only the two dev-tree layouts — so every
 * packaged build threw "dist/daemons.js not found — run npm run build" on the
 * first tray refresh and the Daemons card never listed anything.
 *
 * The candidate list is pure so the packaged layout can be asserted without
 * Electron, which is the only reason that bug was invisible to the suite.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { distCandidates, serveArgs } from '../electron/spawn.js';
import { pickBinDir } from '../electron/cli-install.js';

const here = '/Applications/Foxwel OS.app/Contents/Resources/app.asar/electron/dist';
const resources = '/Applications/Foxwel OS.app/Contents/Resources';

describe('distCandidates', () => {
  it('searches the packaged payload before any dev-tree layout', () => {
    const found = distCandidates('daemons.js', { here, resources, commandName: 'foxwel' });
    expect(found[0]).toBe(`${resources}/foxwel/package/dist/daemons.js`);
  });

  it('names the payload dir from the brand, so a rebrand still resolves', () => {
    const baton = distCandidates('cli.js', { here, resources, commandName: 'baton' });
    const foxwel = distCandidates('cli.js', { here, resources, commandName: 'foxwel' });
    expect(baton[0]).toContain('/baton/package/dist/cli.js');
    expect(foxwel[0]).toContain('/foxwel/package/dist/cli.js');
  });

  it('still offers both dev-tree layouts when not packaged', () => {
    const found = distCandidates('daemons.js', { here: '/repo/electron/dist', resources: null, commandName: 'baton' });
    expect(found).toEqual(['/repo/dist/daemons.js', '/repo/electron/dist/daemons.js']);
  });

  it('resolves daemons.js and cli.js from the same payload root', () => {
    const opts = { here, resources, commandName: 'foxwel' };
    expect(distCandidates('daemons.js', opts)[0].replace('daemons.js', 'cli.js'))
      .toBe(distCandidates('cli.js', opts)[0]);
  });
});

describe('serveArgs', () => {
  it('passes --port so a second project does not fight for 7077', () => {
    expect(serveArgs('/cli.js', { port: 7078 })).toEqual(['/cli.js', 'serve', '--port', '7078']);
  });

  it('keeps --write when both are set', () => {
    expect(serveArgs('/cli.js', { write: true, port: 7079 }))
      .toEqual(['/cli.js', 'serve', '--write', '--port', '7079']);
  });

  it('omits --port when none was chosen, so CLI auto-advance still applies', () => {
    expect(serveArgs('/cli.js', { write: true })).toEqual(['/cli.js', 'serve', '--write']);
  });

  it('refuses a non-port', () => {
    expect(() => serveArgs('/cli.js', { port: 0 })).toThrow(/invalid port/);
  });
});

/**
 * `app.getName()` reads the package.json inside the asar, and Electron derives
 * userData from it. electron-builder's top-level `productName` only reaches
 * Info.plist, so without it in `extraMetadata` every build — whatever its brand
 * — stored its data in `~/Library/Application Support/batonhq`: the company
 * build leaked the origin name, and the two apps shared one singleton lock, so
 * only one of them could run at a time.
 */
describe('packaged app identity', () => {
  const cfg = readFileSync(join(import.meta.dirname, '..', 'config', 'electron-builder.cjs'), 'utf8');

  it('writes productName into the packaged manifest, not just Info.plist', () => {
    const extra = cfg.match(/extraMetadata:\s*\{[^}]*\}/)?.[0] ?? '';
    expect(extra).toContain('main:');
    expect(extra).toContain('productName:');
  });

  it('takes that productName from brand.json rather than a literal', () => {
    const extra = cfg.match(/extraMetadata:\s*\{[^}]*\}/)?.[0] ?? '';
    expect(extra).toMatch(/productName:\s*brand\.productName/);
  });
});

/**
 * Picking the directory for the CLI symlink.
 *
 * The probe used to be `mkdirSync(d, { recursive: true })` — which SUCCEEDS on
 * a directory that already exists no matter who owns it. On macOS /usr/local/bin
 * exists and is root-owned, so the loop claimed it, broke out, and only then
 * failed on the write: "EACCES: permission denied, open
 * '/usr/local/bin/.baton-app-cli'". The writable fallback was never reached, so
 * "Install CLI" was dead on any Mac where that directory is not user-owned —
 * which is every Apple Silicon Mac, since Homebrew moved to /opt/homebrew.
 */
describe('pickBinDir', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'baton-bindir-'));
  const readonlyDir = join(tmp, 'readonly');
  const writableDir = join(tmp, 'writable');
  mkdirSync(readonlyDir, { recursive: true });
  chmodSync(readonlyDir, 0o555);

  afterAll(() => { chmodSync(readonlyDir, 0o755); rmSync(tmp, { recursive: true, force: true }); });

  it('skips a directory that exists but cannot be written to', () => {
    expect(pickBinDir([readonlyDir, writableDir])).toBe(writableDir);
  });

  it('takes the first candidate when it is genuinely writable', () => {
    expect(pickBinDir([writableDir, readonlyDir])).toBe(writableDir);
  });

  it('throws rather than returning a directory it cannot write', () => {
    expect(() => pickBinDir([readonlyDir])).toThrow(/writable/i);
  });
});

/**
 * The desktop app runs the CLI on ELECTRON's bundled Node, not the system's:
 * electron/spawn.ts spawns `process.execPath` with ELECTRON_RUN_AS_NODE=1. So
 * Electron's Node must clear the CLI's own floor (MIN_NODE_MAJOR, mirrored by
 * package.json `engines`).
 *
 * Electron 37 bundles Node 22, and the CLI requires 24 for node:sqlite's FTS5 —
 * so every packaged build died the moment you pressed Start, with the launcher's
 * own message: "Baton needs Node >= 24 — this is Node 22.17.1". The desktop app
 * could not run a daemon at all, on either brand.
 *
 * Electron 40 is the first release bundling Node 24 (40 → 24.15, 43 → 24.18).
 */
const ELECTRON_MIN_MAJOR = 40;

describe('bundled runtime satisfies the CLI floor', () => {
  const pkg = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
  ) as { engines: { node: string }; devDependencies: Record<string, string> };

  it('states a CLI floor at all — the guard is meaningless without one', () => {
    expect(pkg.engines.node).toMatch(/>=\s*\d+/);
  });

  it('pins an Electron new enough to carry that Node', () => {
    const major = Number(/(\d+)/.exec(pkg.devDependencies.electron)?.[1]);
    expect(major).toBeGreaterThanOrEqual(ELECTRON_MIN_MAJOR);
  });

  it('verifies the real binary at pack time, not just the version string', () => {
    const cfg = readFileSync(join(import.meta.dirname, '..', 'config', 'electron-builder.cjs'), 'utf8');
    expect(cfg).toMatch(/afterPack/);
    expect(cfg).toContain('ELECTRON_RUN_AS_NODE');
    expect(cfg).toContain('process.versions.node');
  });
});
