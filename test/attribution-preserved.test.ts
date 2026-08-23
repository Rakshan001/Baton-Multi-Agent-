// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Attribution survives a rebrand.
 *
 * A downstream distribution is expected to change the product name, the icons,
 * the repository and the app id — `branding/brand.json` exists precisely so it
 * can. This suite draws the line at the other half: who wrote the software.
 *
 * Every assertion here is something AGPL-3.0 already requires (§5(a) prominent
 * notices, §6/§13 source offer) or that NOTICE requires under §7(b). A fork that
 * renames the product keeps this suite green. A fork that strips the credit
 * turns it red, which is the point — the removal has to be deliberate and
 * visible in a diff, not something that happens by accident during a rebrand.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATTRIBUTION, attributionLines } from '../electron/attribution.ts';

const root = process.cwd();
const AUTHOR = 'Rakshan Shetty';

describe('authorship attribution', () => {
  it('names the author, the licence, and where the source lives', () => {
    expect(ATTRIBUTION.copyright).toContain(AUTHOR);
    expect(ATTRIBUTION.license).toBe('AGPL-3.0-or-later');
    expect(ATTRIBUTION.upstreamName).toBe('Baton');
    expect(ATTRIBUTION.upstreamSource).toMatch(/^https:\/\/github\.com\/Rakshan001\//);
  });

  it('is frozen, so it cannot be rewritten at runtime instead of in source', () => {
    expect(Object.isFrozen(ATTRIBUTION)).toBe(true);
  });

  it('credits the author under a rebranded product name', () => {
    const lines = attributionLines('Foxwel OS').join('\n');
    expect(lines).toContain('built on Baton');
    expect(lines).toContain(AUTHOR);
    expect(lines).toContain('Affero');
    expect(lines).toContain(ATTRIBUTION.upstreamSource);
  });

  it('does not degrade when the product name is unchanged', () => {
    const lines = attributionLines('Baton').join('\n');
    expect(lines).toContain(AUTHOR);
    expect(lines).toContain(ATTRIBUTION.upstreamSource);
  });

  it('is not sourced from brand.json, so a rebrand cannot swap it out', () => {
    const brand = readFileSync(join(root, 'branding', 'brand.json'), 'utf8');
    expect(brand).not.toContain(AUTHOR);
    expect(brand).not.toContain('copyright');
    // If attribution ever moved into brand.json it would become swappable data,
    // which is exactly the failure this suite exists to prevent.
  });

  it('the app surfaces it — About panel wired to the attribution constant', () => {
    const main = readFileSync(join(root, 'electron', 'main.ts'), 'utf8');
    expect(main).toContain('setAboutPanelOptions');
    expect(main).toContain('attributionLines');
    expect(main).toMatch(/showAboutPanel/);
  });
});

describe('legal notices ship with the product', () => {
  for (const f of ['LICENSE', 'NOTICE', 'CITATION.cff']) {
    it(`${f} exists`, () => {
      expect(existsSync(join(root, f))).toBe(true);
    });
  }

  it('NOTICE names the copyright holder', () => {
    expect(readFileSync(join(root, 'NOTICE'), 'utf8')).toContain(`Copyright (C) 2026 ${AUTHOR}`);
  });

  it('NOTICE states the §7(b) attribution requirement', () => {
    const notice = readFileSync(join(root, 'NOTICE'), 'utf8');
    expect(notice).toMatch(/7\(b\)/);
  });

  it('LICENSE is the AGPL', () => {
    expect(readFileSync(join(root, 'LICENSE'), 'utf8')).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');
  });

  it('CITATION.cff records the author', () => {
    const cff = readFileSync(join(root, 'CITATION.cff'), 'utf8');
    expect(cff).toContain('Shetty');
    expect(cff).toContain('Rakshan');
  });
});

describe('per-file copyright headers', () => {
  function sources(dir: string, out: string[] = []): string[] {
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name === 'ui-dist') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) sources(p, out);
      else if (/\.ts$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
    }
    return out;
  }

  it('every src/ and electron/ TypeScript file carries the copyright header', () => {
    const missing = [...sources(join(root, 'src')), ...sources(join(root, 'electron'))]
      .filter((f) => !readFileSync(f, 'utf8').includes(`Copyright (C) 2026 ${AUTHOR}`))
      .map((f) => relative(root, f));
    expect(missing).toEqual([]);
  });
});
