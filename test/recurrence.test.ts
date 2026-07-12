import { describe, it, expect } from 'vitest';
import { recurrenceSuspects, substantiveTerms } from '../src/recurrence.js';
import type { FileHit } from '../src/history.js';

/**
 * S6 — bug recurrence. Given a past fix (when + which files), the suspects for a
 * reappearance are the commits that touched those same files AFTER the fix —
 * excluding the fix's own work. Pure + unit-tested; the CLI feeds it real history.
 */
const hit = (over: Partial<FileHit>): FileHit => ({
  path: 'src/auth.ts', slug: 'x', task: 'x', agent: null, sha: 's', message: 'm',
  at: '2026-06-01T00:00:00Z', ...over,
});

describe('recurrenceSuspects', () => {
  const fixAt = '2026-06-10T00:00:00Z';
  const fixFiles = ['src/auth.ts', 'src/mw.ts'];

  it('flags later commits touching the fixed files, newest first', () => {
    const hits: FileHit[] = [
      hit({ sha: 'later2', path: 'src/auth.ts', at: '2026-06-20T00:00:00Z', slug: 'feat-b' }),
      hit({ sha: 'later1', path: 'src/mw.ts', at: '2026-06-15T00:00:00Z', slug: 'feat-a' }),
    ];
    const out = recurrenceSuspects(fixAt, fixFiles, hits);
    expect(out.map((s) => s.sha)).toEqual(['later2', 'later1']);
  });

  it('ignores commits at or before the fix, and files outside the fix set', () => {
    const hits: FileHit[] = [
      hit({ sha: 'before', at: '2026-06-05T00:00:00Z' }),           // before the fix
      hit({ sha: 'atfix', at: fixAt }),                              // exactly the fix time
      hit({ sha: 'other', path: 'src/other.ts', at: '2026-07-01T00:00:00Z' }), // unrelated file
    ];
    expect(recurrenceSuspects(fixAt, fixFiles, hits)).toEqual([]);
  });

  it('dedupes a commit that touched several fixed files, listing them together', () => {
    const hits: FileHit[] = [
      hit({ sha: 'multi', path: 'src/auth.ts', at: '2026-06-18T00:00:00Z', slug: 'feat-c' }),
      hit({ sha: 'multi', path: 'src/mw.ts', at: '2026-06-18T00:00:00Z', slug: 'feat-c' }),
    ];
    const out = recurrenceSuspects(fixAt, fixFiles, hits);
    expect(out).toHaveLength(1);
    expect(out[0].files.sort()).toEqual(['src/auth.ts', 'src/mw.ts']);
  });

  it('excludes the fixing task\'s own later commits', () => {
    const hits: FileHit[] = [
      hit({ sha: 'ownfollowup', at: '2026-06-12T00:00:00Z', slug: 'the-fix' }),
      hit({ sha: 'elsewhere', at: '2026-06-14T00:00:00Z', slug: 'feat-a' }),
    ];
    const out = recurrenceSuspects(fixAt, fixFiles, hits, { excludeSlug: 'the-fix' });
    expect(out.map((s) => s.sha)).toEqual(['elsewhere']);
  });
});

describe('substantiveTerms — strip generic bug vocabulary so unrelated symptoms do not match', () => {
  it('keeps meaningful symptom words', () => {
    expect(substantiveTerms('checkout redirect loop').sort()).toEqual(['checkout', 'loop', 'redirect']);
  });
  it('drops bug/fix stopwords and short words', () => {
    expect(substantiveTerms('some symptom never fixed')).toEqual([]);
    expect(substantiveTerms('the bug is back again')).toEqual(['back']);
  });
});
