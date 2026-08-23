// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadBrand } from '../electron/brand.ts';

/** Walk source files under electron/ and config/ — product strings must come from brand.json. */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'ui-dist' || name === 'dist' || name === 'ui') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|cjs|json)$/.test(name) && !name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('branding is data, not code', () => {
  const brand = loadBrand();
  const roots = [join(process.cwd(), 'electron'), join(process.cwd(), 'config')];

  it('brand.json has the required fields', () => {
    expect(brand.productName).toBeTruthy();
    expect(brand.commandName).toBeTruthy();
    expect(brand.appId).toBeTruthy();
  });

  it('no electron/config source hardcodes the product name, command, or app id', () => {
    const forbidden = [brand.productName, brand.commandName, brand.appId];
    const hits: string[] = [];
    for (const root of roots) {
      let files: string[] = [];
      try { files = walk(root); } catch { continue; }
      for (const file of files) {
        // brand.ts and electron-builder read brand.json — they may mention field names, not values.
        if (file.endsWith(`${join('electron', 'brand.ts')}`)) continue;
        if (file.includes(`${join('config', 'electron-builder')}`)) continue;
        // attribution.ts is the deliberate exception: it names the UPSTREAM work,
        // which must survive a rebrand and therefore cannot come from brand.json.
        // In this repo productName happens to equal upstreamName, so it collides
        // here and only here. See test/attribution-preserved.test.ts.
        if (file.endsWith(`${join('electron', 'attribution.ts')}`)) continue;
        const text = readFileSync(file, 'utf8');
        for (const needle of forbidden) {
          if (text.includes(JSON.stringify(needle)) || new RegExp(`['"\`]${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(text)) {
            // Allow brand.json path references and comments about "product name" generically.
            if (text.includes('brand.json') && !text.includes(needle)) continue;
            hits.push(`${relative(process.cwd(), file)} contains ${JSON.stringify(needle)}`);
          }
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
