// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Everything that must be true before a tarball leaves this machine.
 *
 * The failure this exists to prevent: `npm run build` compiles the CLI only.
 * The dashboard is a SEPARATE workspace (web/), built by a separate command,
 * and `package.json` "files" ships `web/dist` whether or not it was ever
 * built. Publish without it and the daemon starts perfectly, answers the API,
 * and serves a 404 where the dashboard should be — a bug with no symptom
 * until a stranger opens localhost:7077.
 *
 * Wired as `prepack` rather than `prepublishOnly` so that `npm pack` runs it
 * too: the rehearsal then exercises the same path as the real publish, instead
 * of the one place we never test being the one place that ships.
 *
 * Zero-dependency (node: builtins only), to match scripts/copy-assets.mjs.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// npm is a shell script everywhere except Windows, where it is npm.cmd and
// spawnSync cannot execute it without the extension.
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** Run a command from the package root, inheriting stdio; abort on failure. */
function run(label, args) {
  console.log(`\n▸ ${label}`);
  const res = spawnSync(NPM, args, { cwd: root, stdio: 'inherit', shell: false });
  if (res.error) fail(`${label} could not start: ${res.error.message}`);
  if (res.status !== 0) fail(`${label} failed (exit ${res.status}).`);
}

function fail(message) {
  console.error(`\n✗ prepack: ${message}`);
  console.error('  Nothing was packed. Fix the above and re-run.\n');
  process.exit(1);
}

// --- Build ---------------------------------------------------------------

run('build CLI (tsc + assets)', ['run', 'build']);

// A publish usually happens on a fresh clone or a CI runner where the web
// workspace has never been installed. Installing here keeps the maintainer
// from having to remember a second, invisible setup step.
if (!existsSync(join(root, 'web/node_modules'))) {
  run('install dashboard deps (web/)', ['ci', '--prefix', 'web']);
}
run('build dashboard (vite)', ['run', 'build:web']);

// --- Verify --------------------------------------------------------------

/**
 * Each entry is something `files` promises to ship. A build that "succeeded"
 * while producing none of these is exactly the silent failure above, so the
 * check is on the artifacts, not on the exit codes we already saw.
 */
const required = [
  ['dist/cli.js', 'the bin entry — npm links this as `baton`'],
  ['dist/main.js', 'the command tree the launcher hands off to'],
  ['dist/skills/bundled', 'the file-backed skill catalog read at runtime'],
  ['web/dist/index.html', 'the dashboard shell served by `baton serve`'],
  ['web/dist/assets', 'the dashboard JS/CSS bundles'],
];

const missing = required.filter(([rel]) => !existsSync(join(root, rel)));
if (missing.length) {
  console.error('\n✗ prepack: the build finished but these artifacts are absent:\n');
  for (const [rel, why] of missing) console.error(`    ${rel}\n      ${why}`);
  fail(`${missing.length} required artifact(s) missing.`);
}

// An empty directory passes existsSync and ships as nothing at all.
for (const rel of ['dist/skills/bundled', 'web/dist/assets']) {
  if (readdirSync(join(root, rel)).length === 0) fail(`${rel} exists but is empty.`);
}

console.log('\n✓ prepack: CLI + dashboard built, all shipped artifacts present.\n');
