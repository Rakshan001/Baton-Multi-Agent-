#!/usr/bin/env node
/**
 * Stage dist/ + web/dist/ + runtime dependency closure into
 * resources/<commandName>/package/ (nested under package/ so electron-builder
 * does not strip a root-level node_modules).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planDependencyClosure } from './dependency-closure.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const brand = JSON.parse(readFileSync(join(root, 'branding', 'brand.json'), 'utf8'));
const staging = join(root, 'resources', brand.commandName, 'package');

function die(msg) {
  console.error(`stage-payload: ${msg}`);
  process.exit(1);
}

if (!existsSync(join(root, 'dist', 'cli.js'))) die('dist/cli.js missing — run npm run build');
if (!existsSync(join(root, 'web', 'dist', 'index.html'))) die('web/dist missing — run npm run build --prefix web');

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

for (const rel of ['dist', 'web/dist', 'package.json', 'LICENSE', 'README.md']) {
  const from = join(root, rel);
  if (!existsSync(from)) {
    if (rel === 'README.md') continue;
    die(`missing ${rel}`);
  }
  cpSync(from, join(staging, rel), { recursive: true });
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const direct = Object.keys(pkg.dependencies ?? {});
const plan = planDependencyClosure({
  direct,
  readManifest: (dir) => {
    const p = join(root, dir, 'package.json');
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf8')); }
    catch { return null; }
  },
});
if (plan.action === 'refuse') die(plan.detail);

for (const { dir } of plan.packages) {
  const from = join(root, dir);
  const to = join(staging, dir);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, filter: (src) => !src.includes(`${join('node_modules', '.bin')}`) });
}

writeFileSync(join(staging, 'STAGED.json'), `${JSON.stringify({
  stagedAt: new Date().toISOString(),
  packages: plan.packages.length,
  commandName: brand.commandName,
}, null, 2)}\n`);

console.log(`staged ${plan.packages.length} packages → ${staging}`);
