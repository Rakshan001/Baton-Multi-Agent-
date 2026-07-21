import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanFinding, countByAxis, isReviewStale, listReviews, loadReview, openFindings,
  resolveFinding, ReviewValidationError, safeSlug, saveReview, type ReviewFinding,
} from '../src/reviews.js';

/**
 * The review store exists so findings outlive the session that produced them.
 * These tests pin the rules that make the record trustworthy: citations are
 * mandatory, "hard violation" can't be claimed off the Standards axis, axes are
 * never summed, and a review against an old sha announces itself as stale.
 */
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'baton-reviews-'));
  await mkdir(join(root, '.baton'), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const finding = (over: Partial<ReviewFinding> = {}): Partial<ReviewFinding> => ({
  axis: 'standards',
  title: 'Duplicated token parsing',
  source: 'baseline: Duplicated Code',
  ...over,
});

describe('cleanFinding — an uncited finding is an opinion', () => {
  it('drops findings with no axis, no title, or no source', () => {
    expect(cleanFinding({ title: 'x', source: 'y' })).toBeNull();               // no axis
    expect(cleanFinding({ axis: 'spec', source: 'y' })).toBeNull();             // no title
    expect(cleanFinding({ axis: 'spec', title: 'x' })).toBeNull();              // no source
    expect(cleanFinding({ axis: 'nope' as never, title: 'x', source: 'y' })).toBeNull();
  });

  it('only the Standards axis can produce a hard violation', () => {
    // a documented-standard breach is binding...
    expect(cleanFinding(finding({ hard: true }))!.hard).toBe(true);
    // ...but Spec and Security findings are always judgement calls, even if the
    // sub-agent claims otherwise. The skill's rule, enforced at the storage layer.
    expect(cleanFinding(finding({ axis: 'spec', hard: true }))!.hard).toBe(false);
    expect(cleanFinding(finding({ axis: 'security', hard: true }))!.hard).toBe(false);
  });

  it('refuses path escapes in the file anchor', () => {
    expect(cleanFinding(finding({ file: '../../etc/passwd' }))!.file).toBeUndefined();
    expect(cleanFinding(finding({ file: '/etc/passwd' }))!.file).toBeUndefined();
    expect(cleanFinding(finding({ file: 'src/auth.ts' }))!.file).toBe('src/auth.ts');
  });

  it('defaults status to open and ignores unknown statuses/routes', () => {
    expect(cleanFinding(finding())!.status).toBe('open');
    expect(cleanFinding(finding({ status: 'wat' as never }))!.status).toBe('open');
    expect(cleanFinding(finding({ route: 'launch-missiles' as never }))!.route).toBeUndefined();
    expect(cleanFinding(finding({ route: 'systematic-debugging' }))!.route).toBe('systematic-debugging');
  });
});

describe('saveReview / loadReview', () => {
  it('requires a fixed point and a head sha', async () => {
    await expect(saveReview(root, 'x', { fixedPoint: '', head: 'abc', findings: [] }))
      .rejects.toBeInstanceOf(ReviewValidationError);
    await expect(saveReview(root, 'x', { fixedPoint: 'main', head: '', findings: [] }))
      .rejects.toBeInstanceOf(ReviewValidationError);
  });

  it('round-trips a review and records only the axes that produced findings', async () => {
    await saveReview(root, 'my-task', {
      fixedPoint: 'main',
      head: 'deadbeef',
      findings: [finding(), finding({ axis: 'security', title: 'SSRF', source: 'baseline: SSRF' })],
      skipped: [{ axis: 'spec', why: 'no spec found' }],
    });
    const rec = (await loadReview(root, 'my-task'))!;
    expect(rec.findings).toHaveLength(2);
    expect(rec.axes.sort()).toEqual(['security', 'standards']);
    expect(rec.skipped).toEqual([{ axis: 'spec', why: 'no spec found' }]);
  });

  it('a re-review supersedes the old findings but keeps the first-reviewed time', async () => {
    const first = await saveReview(root, 't', { fixedPoint: 'main', head: 'aaa', findings: [finding()] });
    await new Promise((r) => setTimeout(r, 5));
    const second = await saveReview(root, 't', { fixedPoint: 'main', head: 'bbb', findings: [] });
    // stale findings against an older HEAD are worse than none
    expect(second.findings).toHaveLength(0);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).not.toBe(first.updatedAt);
  });

  it('returns null for an unknown slug rather than throwing', async () => {
    expect(await loadReview(root, 'never-reviewed')).toBeNull();
  });

  it('keeps a hostile slug inside .baton/reviews', () => {
    // traversal segments collapse to a separator, which is then stripped —
    // what matters is that no '/' or '..' survives into the filename
    expect(safeSlug('../../escape')).toBe('escape');
    expect(safeSlug('a/../../b')).not.toMatch(/[/.]/);
    expect(safeSlug('')).toBe('review');
  });
});

describe('counting and staleness', () => {
  it('counts per axis and never sums them', () => {
    const findings = [finding(), finding({ axis: 'spec' }), finding({ axis: 'spec' })]
      .map(cleanFinding) as ReviewFinding[];
    expect(countByAxis(findings)).toEqual({ standards: 1, spec: 2, security: 0 });
  });

  it('openFindings excludes resolved ones', async () => {
    await saveReview(root, 't', {
      fixedPoint: 'main', head: 'aaa',
      findings: [finding(), finding({ title: 'second' })],
    });
    const resolved = await resolveFinding(root, 't', 0, 'fixed');
    expect(resolved!.findings[0].status).toBe('fixed');
    expect(openFindings(resolved)).toHaveLength(1);
    expect(countByAxis(openFindings(resolved)).standards).toBe(1);
  });

  it('resolveFinding returns null for a bad slug or index', async () => {
    await saveReview(root, 't', { fixedPoint: 'main', head: 'aaa', findings: [finding()] });
    expect(await resolveFinding(root, 't', 9, 'fixed')).toBeNull();
    expect(await resolveFinding(root, 'nope', 0, 'fixed')).toBeNull();
  });

  it('flags a review whose head no longer matches — findings may already be fixed', async () => {
    const rec = await saveReview(root, 't', { fixedPoint: 'main', head: 'aaa', findings: [] });
    expect(isReviewStale(rec, 'aaa')).toBe(false);
    expect(isReviewStale(rec, 'bbb')).toBe(true);
    // unknown current head is not a staleness claim we can make
    expect(isReviewStale(rec, '')).toBe(false);
  });
});

describe('listReviews', () => {
  it('returns every review newest-first, and empty when none exist', async () => {
    expect(await listReviews(root)).toEqual([]);
    await saveReview(root, 'older', { fixedPoint: 'main', head: 'a', findings: [] });
    await new Promise((r) => setTimeout(r, 5));
    await saveReview(root, 'newer', { fixedPoint: 'main', head: 'b', findings: [] });
    expect((await listReviews(root)).map((r) => r.slug)).toEqual(['newer', 'older']);
  });
});
