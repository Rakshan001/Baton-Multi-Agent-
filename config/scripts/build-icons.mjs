#!/usr/bin/env node
/**
 * Build branding/icons/* from branding/icon-source.png.
 * Outputs are committed — this is an authoring step, not CI.
 *
 * iconutil is picky about PNG provenance; if it refuses the iconset we still
 * ship icon.png + icon.ico (electron-builder accepts PNG on mac as a fallback).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { icoFromPngs } from './ico-from-pngs.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const branding = join(root, 'branding');
const sourceIn = join(branding, 'icon-source.png');
const outDir = join(branding, 'icons');

if (!existsSync(sourceIn)) {
  console.error('branding/icon-source.png missing');
  process.exit(1);
}
if (process.platform !== 'darwin') {
  console.error('icon generation needs macOS (sips); outputs are committed');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'baton-icons-'));
const source = join(scratch, 'source.png');
execFileSync('sips', ['-s', 'format', 'png', sourceIn, '--out', source], { stdio: 'ignore' });

function resize(size, dest) {
  execFileSync('sips', ['-z', String(size), String(size), source, '--out', dest], { stdio: 'ignore' });
}

try {
  resize(1024, join(outDir, 'icon.png'));
  resize(32, join(outDir, 'tray.png'));
  for (const size of [16, 32, 64, 128, 256]) {
    resize(size, join(outDir, `${size}.png`));
  }

  const iconset = join(scratch, 'icon.iconset');
  mkdirSync(iconset);
  const slots = [
    ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
  ];
  for (const [name, size] of slots) resize(size, join(iconset, name));
  try {
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(outDir, 'icon.icns')], { stdio: 'pipe' });
  } catch (err) {
    console.warn('iconutil refused the iconset — shipping icon.png for mac (electron-builder accepts it)');
    console.warn(String(err.stderr ?? err.message ?? err));
  }

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = icoSizes.map((size) => {
    const p = join(scratch, `ico-${size}.png`);
    resize(size, p);
    return readFileSync(p);
  });
  writeFileSync(join(outDir, 'icon.ico'), icoFromPngs(pngs));
  console.log(`wrote icons under ${outDir}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
