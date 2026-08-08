// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The licence is a promise, and these tests are what keep it from drifting.
 *
 * Baton moved from MIT to AGPL-3.0-or-later on 2026-08-07. Two things can undo
 * that quietly: a regenerated package.json putting "MIT" back in a field nobody
 * reads, and the §13 source offer in the dashboard breaking into a link that
 * goes nowhere. Neither would fail any other test in this suite, and neither
 * would be noticed until someone was already relying on the wrong thing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { normalizeSourceUrl, SOURCE_URL, UPSTREAM_SOURCE } from '../src/version.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(root, f), 'utf-8');

const SOURCE_EXT = /\.(ts|tsx|mjs|css)$/;
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) sourceFiles(rel, out);
    else if (SOURCE_EXT.test(e.name)) out.push(rel);
  }
  return out;
}

describe('the project is AGPL-3.0, in every place that states a licence', () => {
  it('package.json declares the SPDX id', () => {
    const pkg = JSON.parse(read('package.json')) as { license?: string };
    expect(pkg.license).toBe('AGPL-3.0-or-later');
  });

  it('LICENSE is the Affero text, not the plain GPL', () => {
    const text = read('LICENSE');
    expect(text).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');
    expect(text).toContain('Version 3, 19 November 2007');
    // §13 is the whole reason for Affero over GPL: a daemon with a web
    // dashboard can be taken proprietary by hosting it and never shipping a
    // binary, and only this clause reaches that.
    expect(text).toContain('Remote Network Interaction');
  });

  it('NOTICE records the relicense instead of implying it was always AGPL', () => {
    // Anyone who took a copy before 2026-08-07 holds a permanent MIT grant.
    // Saying so is not a disclaimer, it is the accurate history — and someone
    // auditing a fork's provenance needs it.
    const notice = read('NOTICE');
    expect(notice).toMatch(/AGPL-3\.0-or-later/);
    expect(notice).toMatch(/MIT License from 2026-06-08/);
  });

  it('README and CONTRIBUTING no longer offer the project as MIT', () => {
    for (const f of ['README.md', 'CONTRIBUTING.md']) {
      expect(read(f), f).not.toMatch(/MIT ©|MIT License\]\(LICENSE\)|license-MIT/);
    }
  });
});

describe('every source file carries the copyright and SPDX tag', () => {
  /*
   * The header is what survives a copy. A file lifted into someone else's repo
   * arrives carrying an author and a licence, so removing it is a deliberate,
   * documentable act rather than something that can be waved away as an
   * oversight — and machine-readable (REUSE / SPDX), so licence scanners see it
   * without anyone reading a word.
   *
   * This test exists because the headers were added by a script in one pass,
   * and every file written after that pass would otherwise quietly land bare.
   */
  const files = ['src', 'web/src', 'test', 'scripts'].flatMap((d) => sourceFiles(d));

  it('finds the whole tree, so a passing run means something', () => {
    // Guards the guard: a walker that silently returned [] would make every
    // assertion below vacuous, which is the failure mode of exactly this shape
    // of test.
    expect(files.length).toBeGreaterThan(300);
  });

  it('has no bare file', () => {
    const bare = files.filter((f) => !read(f).includes('SPDX-License-Identifier: AGPL-3.0-or-later'));
    expect(bare, `missing the SPDX header:\n  ${bare.join('\n  ')}`).toEqual([]);
  });

  it('names the copyright holder alongside it', () => {
    const anon = files.filter((f) => !read(f).includes('Copyright (C) 2026 Rakshan Shetty'));
    expect(anon, `missing the copyright line:\n  ${anon.join('\n  ')}`).toEqual([]);
  });

  it('keeps the header within the first few lines, and never above a shebang', () => {
    // A header buried mid-file is not notice, and a header above `#!` silently
    // stops the CLI being executable — the one place ordering is load-bearing.
    for (const f of files) {
      const lines = read(f).split('\n');
      const at = lines.findIndex((l) => l.includes('SPDX-License-Identifier'));
      expect(at, `${relative('.', f)} header too far down`).toBeLessThan(4);
      if (lines[0].startsWith('#!')) expect(at, `${f} header above the shebang`).toBeGreaterThan(0);
    }
  });
});

describe('normalizeSourceUrl — the §13 offer has to be followable', () => {
  /*
   * AGPL §13 obliges the running program to offer its users the source. An
   * offer they cannot open is not an offer, and npm's `repository` field is
   * full of forms a browser cannot follow.
   */
  it('turns every npm repository shorthand into a clickable https URL', () => {
    const cases: [string, string][] = [
      ['git+https://github.com/o/r.git', 'https://github.com/o/r'],
      ['git+ssh://git@github.com/o/r.git', 'https://github.com/o/r'],
      ['git@github.com:o/r.git', 'https://github.com/o/r'],
      ['ssh://git@gitlab.com/o/r.git', 'https://gitlab.com/o/r'],
      ['https://github.com/o/r', 'https://github.com/o/r'],
      ['o/r', 'https://github.com/o/r'],
      ['github:o/r', 'https://github.com/o/r'],
      ['gitlab:o/r', 'https://gitlab.com/o/r'],
      ['bitbucket:o/r', 'https://bitbucket.org/o/r'],
    ];
    for (const [raw, want] of cases) expect(normalizeSourceUrl(raw), raw).toBe(want);
  });

  it('falls back to upstream rather than emitting something unopenable', () => {
    // A fork with a mangled repository field must still hand its users a real
    // link. Upstream is the wrong source for a modified build, but a dead link
    // is worse: one is incomplete, the other is no offer at all.
    for (const bad of [undefined, '', '   ', 'not a url', 'file:///etc/passwd']) {
      expect(normalizeSourceUrl(bad), String(bad)).toBe(UPSTREAM_SOURCE);
    }
  });

  it("this build's own source URL resolves from package.json", () => {
    // The point of reading package.json rather than hardcoding: a fork that
    // edits `repository` offers its own code, with no other change.
    expect(SOURCE_URL).toMatch(/^https:\/\//);
    const pkg = JSON.parse(read('package.json')) as { repository?: { url?: string } };
    expect(SOURCE_URL).toBe(normalizeSourceUrl(pkg.repository?.url));
  });
});
