// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The list setup prints before asking "hub, or individually?".
 *
 * It used to print `basename(path)`, which is not unique. A real Flutter
 * project scanned as:
 *
 *     found 5 separate git repos under Billing App:
 *       • billing_app
 *       • billing_backend
 *       • billing_app
 *       • billing_backend
 *       • billing_frontend
 *
 * Two of those pairs are different repositories at different depths. Nothing on
 * screen said so, and this is the exact list someone reads to decide whether to
 * merge them all into one hub. A listing you cannot act on is worse than a
 * longer one.
 */
import { describe, it, expect } from 'vitest';
import { describeRepos } from '../src/commands/setup.js';

const ROOT = '/w/Billing App';
const repo = (path: string, name: string) => ({ id: name, name, path });

describe('describeRepos', () => {
  it('stays short when the basenames already tell them apart', () => {
    expect(describeRepos(ROOT, [
      repo(`${ROOT}/api`, 'api'),
      repo(`${ROOT}/web`, 'web'),
    ])).toEqual(['api', 'web']);
  });

  // The bug: same basename, different repositories.
  it('shows the path when two repos share a basename', () => {
    const lines = describeRepos(ROOT, [
      repo(`${ROOT}/billing_app`, 'billing_app'),
      repo(`${ROOT}/apps/billing_app`, 'billing_app'),
    ]);
    expect(lines).toEqual(['billing_app', 'apps/billing_app']);
    expect(new Set(lines).size).toBe(2);
  });

  it('disambiguates only the colliding names, leaving the rest alone', () => {
    expect(describeRepos(ROOT, [
      repo(`${ROOT}/billing_app`, 'billing_app'),
      repo(`${ROOT}/apps/billing_app`, 'billing_app'),
      repo(`${ROOT}/billing_frontend`, 'billing_frontend'),
    ])).toEqual(['billing_app', 'apps/billing_app', 'billing_frontend']);
  });

  it('never returns two identical lines, whatever it is given', () => {
    const lines = describeRepos(ROOT, [
      repo(`${ROOT}/a/x`, 'x'),
      repo(`${ROOT}/b/x`, 'x'),
      repo(`${ROOT}/c/x`, 'x'),
    ]);
    expect(new Set(lines).size).toBe(3);
  });

  it('handles a repo at the root itself', () => {
    expect(describeRepos(ROOT, [repo(ROOT, 'Billing App')])).toEqual(['Billing App']);
  });
});
