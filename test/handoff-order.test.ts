// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { orderBriefs, type OrderedBrief } from '../src/handoff/order.js';
import type { BriefEntry } from '../src/handoff/resume.js';

function brief(over: Partial<BriefEntry> = {}): BriefEntry {
  return {
    slug: 'a',
    kind: 'session',
    title: 'A task',
    status: 'ready',
    from: 'claude',
    to: 'any',
    created: '2026-09-05T10:00:00Z',
    path: '/repo/.baton/handoffs/a.md',
    cwd: '/repo',
    markdown: '',
    body: 'Do the thing.',
    ...over,
  };
}

const slugs = (bs: OrderedBrief[]) => bs.map((b) => b.slug);

describe('orderBriefs', () => {
  it('numbers a single brief as step 1 and marks it ready', () => {
    const [only] = orderBriefs([brief()]);
    expect(only.step).toBe(1);
    expect(only.ready).toBe(true);
    expect(only.blockedBy).toEqual([]);
  });

  it('puts a dependency before the brief that needs it', () => {
    const out = orderBriefs([
      brief({ slug: 'ui', dependsOn: ['api'] }),
      brief({ slug: 'api' }),
    ]);
    expect(slugs(out)).toEqual(['api', 'ui']);
    expect(out[0].step).toBe(1);
    expect(out[1].step).toBe(2);
  });

  it('marks a brief blocked while its dependency is still open', () => {
    const out = orderBriefs([
      brief({ slug: 'ui', dependsOn: ['api'] }),
      brief({ slug: 'api' }),
    ]);
    const ui = out.find((b) => b.slug === 'ui')!;
    expect(ui.ready).toBe(false);
    expect(ui.blockedBy).toEqual(['api']);
  });

  it('treats a dependency that is not open as already satisfied', () => {
    // The brief is gone because the work was finished — that unblocks, not blocks.
    const [only] = orderBriefs([brief({ slug: 'ui', dependsOn: ['long-done'] })]);
    expect(only.ready).toBe(true);
    expect(only.blockedBy).toEqual([]);
  });

  it('groups briefs with no dependencies between them into one parallel step', () => {
    const out = orderBriefs([
      brief({ slug: 'api' }),
      brief({ slug: 'docs' }),
      brief({ slug: 'ui', dependsOn: ['api'] }),
    ]);
    expect(out.find((b) => b.slug === 'api')!.step).toBe(1);
    expect(out.find((b) => b.slug === 'docs')!.step).toBe(1);
    expect(out.find((b) => b.slug === 'ui')!.step).toBe(2);
  });

  it('flags a step as parallel only when more than one brief shares it', () => {
    const out = orderBriefs([brief({ slug: 'api' }), brief({ slug: 'docs' })]);
    expect(out.every((b) => b.parallel)).toBe(true);

    const solo = orderBriefs([brief({ slug: 'api' })]);
    expect(solo[0].parallel).toBe(false);
  });

  it('honours an explicit phase over inferred dependency order', () => {
    const out = orderBriefs([
      brief({ slug: 'late', phase: 'Phase 2' }),
      brief({ slug: 'early', phase: 'Phase 1' }),
    ]);
    expect(slugs(out)).toEqual(['early', 'late']);
  });

  it('does not hang on a dependency cycle', () => {
    const out = orderBriefs([
      brief({ slug: 'a', dependsOn: ['b'] }),
      brief({ slug: 'b', dependsOn: ['a'] }),
    ]);
    expect(out).toHaveLength(2);
    // Neither can be first, so neither is claimed to be ready.
    expect(out.every((b) => b.ready === false)).toBe(true);
    expect(out.every((b) => b.cyclic)).toBe(true);
  });

  it('breaks ties by creation time so the order is stable, not arbitrary', () => {
    const out = orderBriefs([
      brief({ slug: 'newer', created: '2026-09-05T12:00:00Z' }),
      brief({ slug: 'older', created: '2026-09-05T09:00:00Z' }),
    ]);
    expect(slugs(out)).toEqual(['older', 'newer']);
  });

  it('returns an empty array for no briefs', () => {
    expect(orderBriefs([])).toEqual([]);
  });

  it('keeps the target agent, so the UI can say where to paste it', () => {
    const [only] = orderBriefs([brief({ to: 'antigravity' })]);
    expect(only.to).toBe('antigravity');
  });

  it('scales to ten briefs without dropping any', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      brief({ slug: `t${i}`, dependsOn: i === 0 ? [] : [`t${i - 1}`] }),
    );
    const out = orderBriefs(many);
    expect(out).toHaveLength(10);
    expect(out[0].step).toBe(1);
    expect(out[9].step).toBe(10);
    expect(out.filter((b) => b.ready)).toHaveLength(1);
  });
});
