// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Post-build asset copy: tsc only emits .js, so non-code files that ship inside
 * dist/ must be copied here. Currently: the file-backed skill catalog
 * (src/skills/bundled → dist/skills/bundled), which the daemon reads at runtime
 * and which `package.json` "files" ships to npm via dist/.
 *
 * It also writes that catalog's digest manifest (bundled/digests.json) first,
 * so the copy carries it. Reference-file content is fixed when the package is
 * built, so its size and sha256 can be too — and a skill LISTING then reports
 * `byteSize`/`contentSha256` without opening 23 files and reading 125,870
 * bytes it throws away. See src/skills/digests.ts for how it is consumed and
 * what invalidates it.
 *
 * The manifest is written into src/ (not only dist/) because that directory is
 * the catalog in a dev checkout: `BUNDLED_DIR` resolves to src/skills/bundled
 * when running from source, so a manifest that existed only in dist/ would
 * leave the source tree — and the test suite — paying the full read.
 *
 * Zero-dependency (node:fs only), cross-platform (fs.cpSync).
 */
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// BATON_ASSET_ROOT lets a test point the real script at a sandbox. Without it
// the only way to test this is to run it against the developer's own tree.
const root = process.env.BATON_ASSET_ROOT
  ? process.env.BATON_ASSET_ROOT
  : join(dirname(fileURLToPath(import.meta.url)), '..');
const bundled = join(root, 'src/skills/bundled');
const pairs = [
  [bundled, join(root, 'dist/skills/bundled')],
];

/**
 * Digest every <skill>/references/<file> — the only files a listing must weigh
 * without reading. Depth-1, exactly like the catalog loader: a reference is a
 * file directly under references/, and a nested directory is not one.
 */
function writeDigestManifest(dir) {
  const files = {};
  for (const skill of readdirSync(dir, { withFileTypes: true })) {
    if (!skill.isDirectory()) continue;
    const refDir = join(dir, skill.name, 'references');
    if (!existsSync(refDir)) continue;
    for (const e of readdirSync(refDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isFile()) continue;
      const buf = readFileSync(join(refDir, e.name));
      // `size` validates the row against the file; bytes/sha256 describe the
      // DECODED text, which is what the reference's `content` hands out.
      const text = buf.toString('utf-8');
      files[`${skill.name}/references/${e.name}`] = {
        size: buf.length,
        bytes: Buffer.byteLength(text, 'utf8'),
        sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      };
    }
  }
  // Sorted keys + trailing newline: a rebuild that changed nothing must produce
  // no diff, or the file becomes noise in every review.
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  const out = join(dir, 'digests.json');
  writeFileSync(out, JSON.stringify({ version: 1, files: sorted }, null, 2) + '\n');
  console.log(`digested ${Object.keys(sorted).length} reference files → ${out}`);
}

if (existsSync(bundled)) writeDigestManifest(bundled);

/**
 * Copy, then remove what the source no longer has.
 *
 * `cpSync` overwrites but never deletes, so without this a skill directory
 * deleted from `src/` stayed in `dist/` forever — and `package.json`'s `files`
 * ships `dist/`. Measured on this repo before the prune: 12 skill directories
 * in source, 31 in dist.
 *
 * That matters because deleting a skill is how you RETRACT one, which is the
 * answer to having shipped a playbook that turns out to be wrong or hostile. A
 * retraction that does not take effect is the failure worth guarding. The stale
 * copies were invisible to `digests.json` too, since that is generated from
 * source — so nothing else would have caught them.
 *
 * Only top-level entries are pruned, and only when the source directory exists:
 * a missing source is a misconfigured checkout, and emptying a built artifact
 * over it would be worse than leaving it alone.
 */
function pruneRemoved(from, to) {
  if (!existsSync(to)) return;
  const keep = new Set(readdirSync(from));
  for (const name of readdirSync(to)) {
    if (keep.has(name)) continue;
    rmSync(join(to, name), { recursive: true, force: true });
    console.log(`pruned ${join(to, name)} (no longer in source)`);
  }
}

for (const [from, to] of pairs) {
  if (!existsSync(from)) continue;
  cpSync(from, to, { recursive: true });
  pruneRemoved(from, to);
  console.log(`copied ${from} → ${to}`);
}
