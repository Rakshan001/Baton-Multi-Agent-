/**
 * Post-build asset copy: tsc only emits .js, so non-code files that ship inside
 * dist/ must be copied here. Currently: the file-backed skill catalog
 * (src/skills/bundled → dist/skills/bundled), which the daemon reads at runtime
 * and which `package.json` "files" ships to npm via dist/.
 *
 * Zero-dependency (node:fs only), cross-platform (fs.cpSync).
 */
import { cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pairs = [
  [join(root, 'src/skills/bundled'), join(root, 'dist/skills/bundled')],
];

for (const [from, to] of pairs) {
  if (!existsSync(from)) continue;
  cpSync(from, to, { recursive: true });
  console.log(`copied ${from} → ${to}`);
}
