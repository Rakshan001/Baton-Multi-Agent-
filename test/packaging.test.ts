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
 */
import { describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const built = existsSync(new URL('../web/dist/index.html', import.meta.url));

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
