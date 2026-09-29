// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source-level guards for the Electron shell (Team Sync §12.3, review S-H4).
// Runtime behaviour needs an Electron binary, so these pin the configuration.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const electronDir = join(import.meta.dirname, '..', 'electron');
const read = (rel: string) => readFileSync(join(electronDir, rel), 'utf8');

function cspDirectives(html: string): Map<string, string[]> {
  const m = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i.exec(html);
  if (!m) throw new Error('launcher index.html has no CSP meta tag');
  const out = new Map<string, string[]>();
  for (const part of m[1]!.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out.set(name, values);
  }
  return out;
}

describe('launcher CSP', () => {
  const csp = cspDirectives(read('ui/index.html'));

  it.each([
    ['default-src', ["'self'"]],
    ['script-src', ["'self'"]],
    ['style-src', ["'self'"]],
    ['object-src', ["'none'"]],
    ['frame-src', ["'none'"]],
    ['base-uri', ["'none'"]],
  ])('%s is %j', (name, values) => {
    expect(csp.get(name)).toEqual(values);
  });

  it('never allows inline or eval script', () => {
    for (const values of csp.values()) {
      expect(values).not.toContain("'unsafe-inline'");
      expect(values).not.toContain("'unsafe-eval'");
    }
  });
});

describe('main window', () => {
  const main = read('main.ts');

  it('runs every renderer sandboxed', () => {
    expect(main).not.toMatch(/sandbox:\s*false/);
    expect(main.match(/sandbox:\s*true/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('reaches shell.openExternal only through the allowlist helper', () => {
    expect(main.match(/shell\.openExternal\(/g)).toHaveLength(1);
    expect(main).toMatch(/openExternalSafe\(url, \(href\) => shell\.openExternal\(href\)\)/);
  });

  it('loads the CommonJS preload', () => {
    expect(main).toContain("preload: join(here, 'preload.cjs')");
  });
});

describe('sandboxed preload', () => {
  const preload = read('preload.cts');

  it('uses no ESM import statements', () => {
    expect(preload).not.toMatch(/^\s*import\s/m);
  });

  it("requires only 'electron'", () => {
    const mods = [...preload.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    expect(mods).toEqual(['electron']);
  });
});
