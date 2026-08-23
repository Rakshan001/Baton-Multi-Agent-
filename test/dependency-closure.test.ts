// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { planDependencyClosure } from '../config/scripts/dependency-closure.mjs';

describe('dependency closure', () => {
  it('walks nested node_modules the way Node resolves them', () => {
    const manifests = new Map([
      ['', { name: 'batonhq', dependencies: { commander: '1.0.0', execa: '1.0.0' } }],
      ['node_modules/commander', { name: 'commander', version: '1.0.0', dependencies: {} }],
      ['node_modules/execa', { name: 'execa', version: '1.0.0', dependencies: { 'human-signals': '1.0.0' } }],
      ['node_modules/execa/node_modules/human-signals', { name: 'human-signals', version: '1.0.0', dependencies: {} }],
    ]);
    const plan = planDependencyClosure({
      direct: ['commander', 'execa'],
      readManifest: (dir) => manifests.get(dir) ?? null,
    });
    expect(plan.action).toBe('copy');
    expect(plan.packages.map((p) => p.dir).sort()).toEqual([
      'node_modules/commander',
      'node_modules/execa',
      'node_modules/execa/node_modules/human-signals',
    ].sort());
  });

  it('refuses when a required dependency is missing', () => {
    const plan = planDependencyClosure({
      direct: ['missing-pkg'],
      readManifest: () => null,
    });
    expect(plan.action).toBe('refuse');
  });
});
