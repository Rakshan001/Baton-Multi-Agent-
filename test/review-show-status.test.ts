// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `baton review show` renders the header from OPEN findings and the body from
 * ALL of them. When the two disagree — "open: Standards 7 · Spec 3" above a
 * list of thirteen entries — a reader believes the list, and reports work as
 * outstanding that someone already closed. That happened; these tests pin the
 * rule that prevents it: every finding in the body says what state it is in,
 * and the entries that read as outstanding are exactly the ones the header
 * counted.
 */
import { describe, expect, it } from 'vitest';
import { renderReview } from '../src/commands/review.js';
import { cleanFinding, countByAxis, openFindings, REVIEW_AXES, type ReviewFinding, type ReviewRecord } from '../src/reviews.js';

const f = (over: Partial<ReviewFinding>): ReviewFinding =>
  cleanFinding({ axis: 'standards', title: 'a finding', source: 'baseline: Duplicated Code', ...over })!;

const record = (findings: ReviewFinding[]): ReviewRecord => ({
  slug: 'mixed-statuses',
  fixedPoint: 'main',
  head: 'abc123def456',
  axes: [...new Set(findings.map((x) => x.axis))],
  skipped: [],
  findings,
  author: 'tester',
  createdAt: '2026-09-06T10:00:00.000Z',
  updatedAt: '2026-09-06T10:00:00.000Z',
});

/** The `[n] id  … title` lines — one per finding, the rows a reader counts. */
const findingRows = (lines: string[]): string[] => lines.filter((l) => /^ {2}\[\d+] [0-9a-f]{10} /.test(l));

/** A row a reader would take as still outstanding: nothing on it says otherwise. */
const readsAsOpen = (row: string): boolean => !/✓ fixed|✗ dismissed/.test(row);

const mixed = record([
  f({ title: 'open standards one', hard: true }),
  f({ title: 'open standards two' }),
  f({ title: 'already fixed standards', status: 'fixed' }),
  f({ axis: 'spec', title: 'open spec one' }),
  f({ axis: 'spec', title: 'dismissed spec one', status: 'dismissed' }),
]);

describe('review show — the body and the header agree about what is outstanding', () => {
  it('shows only the open findings in the header count', () => {
    const counts = countByAxis(openFindings(mixed));
    const header = renderReview(mixed, mixed.head)[1];
    expect(counts).toEqual({ standards: 2, spec: 1, security: 0 });
    expect(header).toContain('open: Standards 2 · Spec 1 · Security 0');
  });

  it('lists every finding, but only the open ones read as outstanding', () => {
    const rows = findingRows(renderReview(mixed, mixed.head));
    // Nothing is hidden: resolution state is part of the record, and a reader
    // asking "what did this review find" should still see the closed ones.
    expect(rows).toHaveLength(mixed.findings.length);
    // …but the rows that read as outstanding must be exactly the header's count.
    const outstanding = rows.filter(readsAsOpen);
    expect(outstanding).toHaveLength(openFindings(mixed).length);
    expect(outstanding.some((r) => r.includes('already fixed standards'))).toBe(false);
    expect(outstanding.some((r) => r.includes('dismissed spec one'))).toBe(false);
  });

  it('says what happened to a resolved finding, in words rather than a glyph', () => {
    // '●' vs '○' is the difference that failed: at a glance they are the same
    // mark, so a fixed finding read as an open one.
    const rows = findingRows(renderReview(mixed, mixed.head));
    expect(rows.find((r) => r.includes('already fixed standards'))).toMatch(/✓ fixed/);
    expect(rows.find((r) => r.includes('dismissed spec one'))).toMatch(/✗ dismissed/);
    // The finding's kind survives beside its state — a closed VIOLATION is
    // still a violation that was closed.
    expect(rows.find((r) => r.includes('open standards one'))).toMatch(/VIOLATION/);
  });

  it('states the open/resolved split up front, so the two numbers cannot be read apart', () => {
    const lines = renderReview(mixed, mixed.head);
    const summary = lines.find((l) => l.includes('resolved'));
    expect(summary).toBeDefined();
    expect(summary).toContain('5 findings');
    expect(summary).toContain('3 open');
    expect(summary).toContain('1 fixed');
    expect(summary).toContain('1 dismissed');
  });

  it('says nothing about resolution when every finding is still open', () => {
    const allOpen = record([f({ title: 'one' }), f({ axis: 'spec', title: 'two' })]);
    const lines = renderReview(allOpen, allOpen.head);
    expect(lines.some((l) => l.includes('resolved'))).toBe(false);
    expect(findingRows(lines).every(readsAsOpen)).toBe(true);
  });

  it('keeps the printed index pointing at the finding `review resolve` will act on', () => {
    // The index is a position in rec.findings, and people type it off this
    // list. Marking rows instead of dropping them keeps that mapping literal.
    const rows = findingRows(renderReview(mixed, mixed.head));
    for (const [i, finding] of mixed.findings.entries()) {
      expect(rows.find((r) => r.startsWith(`  [${i}] `))).toContain(finding.title);
    }
  });

  it('does not rank across axes — each axis keeps its own section', () => {
    const lines = renderReview(mixed, mixed.head);
    const headings = lines.filter((l) => l.startsWith('  ## '));
    expect(headings).toEqual(['  ## Standards', '  ## Spec']);
    expect(REVIEW_AXES).toContain('security');
  });
});
