// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Export a clean, redistributable copy of this repo into a downstream repo.
 *
 *   node scripts/release-export.mjs --target ../<downstream> [--ref HEAD] [--dry-run]
 *
 * This is deliberately brand-neutral. A downstream repo owns its own branding,
 * CI and README; everything else mirrors this repo at `--ref`. The export is a
 * plain file copy, not a git merge — the downstream repo shares no history with
 * this one, so nothing in EXCLUDE can be recovered from its git log.
 *
 * Two guards make the export safe to run unattended:
 *
 *   1. ATTRIBUTION — refuses to write if LICENSE, NOTICE or CITATION.cff would
 *      be missing. AGPL-3.0 §5(a) requires a modified version to carry prominent
 *      notices, and §7(b) permits requiring that author attribution survive.
 *      A downstream may add its branding; it may not drop the copyright.
 *
 *   2. LEAK — after staging, re-scans the tree and fails if any EXCLUDE path
 *      survived. An exclusion that silently stops matching is the failure mode
 *      worth catching, because nobody reads a diff of 600 files.
 *
 * It never commits and never pushes. It stages a working tree for review.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));

/**
 * Paths that never leave this repo. Directories end in `/`.
 * Every entry carries its reason — an unexplained exclusion gets deleted by
 * someone six months from now who cannot tell whether it still matters.
 */
const EXCLUDE = [
  ['docs/', 'documentation stays with the origin repo'],
  ['baton/plans/', 'instance data — each install writes its own plans'],
  ['report/', 'internal review verdicts'],
  ['STATUS.md', 'internal status tracking'],
  ['MVP.md', 'internal product scope'],
  ['BUILD.md', 'internal product vision'],
  ['CLAUDE.md', 'agent context for hacking on the origin repo'],
  ['AGENTS.md', 'agent context for hacking on the origin repo'],
  ['CODEBASE.md', 'generated index — downstream regenerates its own'],
  ['.claude/', 'agent tooling config'],
  ['.codex/', 'agent tooling config'],
  ['.refs/', 'reference source for learning — never ships'],
  ['.github/', 'personal funding + security-report routing; downstream owns its CI'],
  ['scripts/release-export.mjs', 'origin release tooling'],
];

/** Downstream owns these; the export must not clobber them. */
const PRESERVE_IN_TARGET = ['.git', 'branding', '.github', 'README.md'];

/** The export refuses to write without these. */
const REQUIRE = ['LICENSE', 'NOTICE', 'CITATION.cff', 'package.json'];

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes(name);

const targetArg = flag('--target');
const ref = flag('--ref', 'HEAD');
const dryRun = has('--dry-run');

if (!targetArg) {
  console.error('usage: node scripts/release-export.mjs --target <dir> [--ref HEAD] [--dry-run]');
  process.exit(2);
}

const target = resolve(targetArg);
if (target === root) {
  console.error(`refusing to export onto itself: ${target}`);
  process.exit(2);
}
if (!existsSync(join(target, '.git'))) {
  console.error(`not a git repo: ${target}`);
  process.exit(2);
}

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

const isExcluded = (rel) =>
  EXCLUDE.some(([p]) => (p.endsWith('/') ? rel === p.slice(0, -1) || rel.startsWith(p) : rel === p));

// ---- stage the export in a temp dir -----------------------------------------
const stage = mkdtempSync(join(tmpdir(), 'release-export-'));
try {
  const sha = git(root, 'rev-parse', '--short', ref);
  const tracked = git(root, 'ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean);
  const kept = tracked.filter((f) => !isExcluded(f));
  const dropped = tracked.length - kept.length;

  // `git archive` reads the ref, never the working tree, so an export cannot
  // pick up uncommitted edits. It is also the only copy path here that is
  // binary-safe — branding/icons/*.png would be corrupted by a text round-trip.
  const tar = join(stage, '.export.tar');
  execFileSync('git', ['-C', root, 'archive', '--format=tar', '-o', tar, ref]);
  execFileSync('tar', ['-xf', tar, '-C', stage]);
  rmSync(tar);

  for (const f of tracked) {
    if (isExcluded(f)) rmSync(join(stage, f), { force: true });
  }

  // Deleting every file under docs/ leaves docs/ behind as an empty shell.
  // Prune bottom-up so a directory emptied by its children is caught too.
  const pruneEmpty = (dir) => {
    for (const e of readdirSync(dir)) {
      const abs = join(dir, e);
      if (statSync(abs).isDirectory()) pruneEmpty(abs);
    }
    if (dir !== stage && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  };
  pruneEmpty(stage);

  // ---- guard 1: attribution --------------------------------------------------
  const missing = REQUIRE.filter((f) => !existsSync(join(stage, f)));
  if (missing.length) {
    console.error(`\nATTRIBUTION GUARD: refusing to export without ${missing.join(', ')}.`);
    console.error('AGPL-3.0 §5(a) requires a modified version to carry prominent notices.');
    process.exit(1);
  }

  // ---- guard 2: leak ---------------------------------------------------------
  const walk = (dir, acc = []) => {
    for (const e of readdirSync(dir)) {
      const abs = join(dir, e);
      if (statSync(abs).isDirectory()) walk(abs, acc);
      else acc.push(relative(stage, abs).split(sep).join('/'));
    }
    return acc;
  };
  const leaked = walk(stage).filter(isExcluded);
  if (leaked.length) {
    console.error(`\nLEAK GUARD: ${leaked.length} excluded path(s) survived:`);
    for (const f of leaked.slice(0, 20)) console.error(`  ${f}`);
    process.exit(1);
  }

  console.log(`\nexport ${sha} → ${target}`);
  console.log(`  ${kept.length} files, ${dropped} withheld\n`);
  console.log('withheld:');
  for (const [p, why] of EXCLUDE) {
    const n = tracked.filter((f) => (p.endsWith('/') ? f.startsWith(p) : f === p)).length;
    if (n) console.log(`  ${String(n).padStart(4)}  ${p.padEnd(16)} ${why}`);
  }
  console.log('\ndownstream keeps its own:');
  for (const p of PRESERVE_IN_TARGET) console.log(`        ${p}`);

  if (dryRun) {
    console.log('\n--dry-run: nothing written.');
    process.exit(0);
  }

  // ---- write into the target -------------------------------------------------
  for (const e of readdirSync(target)) {
    if (PRESERVE_IN_TARGET.includes(e)) continue;
    rmSync(join(target, e), { recursive: true, force: true });
  }
  for (const e of readdirSync(stage)) {
    if (PRESERVE_IN_TARGET.includes(e) && existsSync(join(target, e))) continue;
    cpSync(join(stage, e), join(target, e), { recursive: true });
  }

  console.log(`\nwritten. review with:  git -C ${targetArg} status`);
  console.log('nothing was committed or pushed.');
} finally {
  rmSync(stage, { recursive: true, force: true });
}
