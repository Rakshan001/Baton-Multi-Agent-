// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { isAllowedDashboardUrl } from '../electron/nav-guard.ts';

describe('nav-guard', () => {
  const ports = new Set([7077, 7080]);

  it('allows loopback on a known fleet port', () => {
    expect(isAllowedDashboardUrl('http://127.0.0.1:7077/', ports)).toBe(true);
    expect(isAllowedDashboardUrl('http://localhost:7080/tasks', ports)).toBe(true);
  });

  it('refuses off-host URLs', () => {
    expect(isAllowedDashboardUrl('https://evil.example/phish', ports)).toBe(false);
    expect(isAllowedDashboardUrl('http://192.168.1.10:7077/', ports)).toBe(false);
  });

  it('refuses unknown ports even on loopback', () => {
    expect(isAllowedDashboardUrl('http://127.0.0.1:9999/', ports)).toBe(false);
  });
});
