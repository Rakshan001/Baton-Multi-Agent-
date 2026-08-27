// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Post-build asset copy: tsc only emits .js, so non-code files that ship inside
 * dist/ must be copied here. Currently: the file-backed skill catalog
 * (src/skills/bundled → dist/skills/bundled), which the daemon reads at runtime
 * and which `package.json` "files" ships to npm via dist/.
 *
 * The destination is wiped first. cpSync overlays rather than mirrors, so a skill
 * renamed or deleted in src/ would otherwise linger in dist/ forever — and since
 * package.json ships dist/, that ghost reaches npm as a second, stale copy of a
 * skill under its old id. Each destination here is generated wholly from its
 * source, so removing it before the copy is safe.
 *
 * Zero-dependency (node:fs only), cross-platform (fs.cpSync).
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pairs = [
  [join(root, 'src/skills/bundled'), join(root, 'dist/skills/bundled')],
];

for (const [from, to] of pairs) {
  if (!existsSync(from)) continue;
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  console.log(`copied ${from} → ${to}`);
}
