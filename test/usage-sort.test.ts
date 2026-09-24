// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Sessions sort newest first by instant, not by string: stamps carry offsets. */
import { describe, expect, it } from 'vitest';
import { newestFirst, type SessionUsage } from '../src/usage.js';

const at = (sessionId: string, lastAt: string | null) => ({ sessionId, lastAt }) as SessionUsage;
const order = (xs: SessionUsage[]) => [...xs].sort(newestFirst).map((s) => s.sessionId);

describe('newestFirst', () => {
  it('compares instants across timezone offsets', () => {
    // 2026-01-01T00:30+05:30 is 2025-12-31T19:00Z: older, though it sorts later as a string.
    expect(order([at('offset', '2026-01-01T00:30:00+05:30'), at('utc', '2025-12-31T20:00:00Z')])).toEqual(['utc', 'offset']);
  });

  it('puts missing and unparseable stamps last', () => {
    expect(order([at('none', null), at('bad', 'garbage'), at('real', '2026-01-01T00:00:00Z')])[0]).toBe('real');
  });

  it('keeps equal instants in their original order', () => {
    const t = '2026-01-01T00:00:00Z';
    expect(order([at('a', t), at('b', '2026-01-01T05:30:00+05:30'), at('c', t)])).toEqual(['a', 'b', 'c']);
    expect(order([at('x', null), at('y', 'garbage')])).toEqual(['x', 'y']);
  });
});
