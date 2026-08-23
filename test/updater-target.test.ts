// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { loadBrand } from '../electron/brand.ts';

const require = createRequire(import.meta.url);

describe('updater publish target', () => {
  it('electron-builder publish block names this repository', () => {
    const brand = loadBrand();
    const cfg = require(join(process.cwd(), 'config/electron-builder.cjs')) as {
      publish?: { provider?: string; owner?: string; repo?: string };
    };
    expect(cfg.publish?.provider).toBe('github');
    const url = new URL(brand.repository);
    const [, owner, repo] = url.pathname.replace(/\/$/, '').split('/');
    expect(cfg.publish?.owner).toBe(owner);
    expect(cfg.publish?.repo).toBe(repo);
    // Guard against the orcabaton trap: never ship an updater aimed at another product.
    expect(`${cfg.publish?.owner}/${cfg.publish?.repo}`).not.toMatch(/orcabaton|stablyai\/orca/i);
  });
});
