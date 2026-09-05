// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { summarize, summaryEtag, type SkillSummary } from '../src/skills/summary.js';
import type { SkillDef } from '../src/skills/catalog.js';

/** A SkillDef with a real body and two reference files. */
function def(over: Partial<SkillDef> = {}): SkillDef {
  return {
    id: 'bug-fix',
    name: 'Bug fix',
    description: 'Systematically fix bugs without introducing regressions.',
    tags: ['bug', 'debug'],
    produces: ['root-cause analysis'],
    body: '# Bug fix\n\nReproduce first.\n',
    references: [
      { rel: 'references/checklist.md', content: '# Checklist\n' },
      { rel: 'references/patterns.md', content: '# Patterns\n' },
    ],
    source: 'bundled',
    ...over,
  };
}

describe('summarize', () => {
  it('carries what you need to choose a skill', () => {
    const s = summarize(def());
    expect(s.id).toBe('bug-fix');
    expect(s.name).toBe('Bug fix');
    expect(s.description).toContain('Systematically fix bugs');
    expect(s.source).toBe('bundled');
    expect(s.tags).toEqual(['bug', 'debug']);
    expect(s.produces).toEqual(['root-cause analysis']);
  });

  it('never carries a body — that is the whole point', () => {
    const s = summarize(def()) as SkillSummary & { body?: unknown };
    expect(s.body).toBeUndefined();
    expect(Object.keys(s)).not.toContain('body');
    expect(JSON.stringify(s)).not.toContain('Reproduce first');
  });

  it('lists reference paths but never their contents', () => {
    const s = summarize(def());
    expect(s.references).toEqual(['references/checklist.md', 'references/patterns.md']);
    expect(JSON.stringify(s)).not.toContain('# Checklist');
  });

  it('reports the byte size of the whole skill, not the character count', () => {
    const s = summarize(def({ body: 'héllo', references: [] }));
    // 'héllo' is 5 characters but 6 bytes in UTF-8.
    expect(s.byteSize).toBe(Buffer.byteLength('héllo', 'utf8'));
  });

  it('counts reference bytes towards the size', () => {
    const withRefs = summarize(def());
    const withoutRefs = summarize(def({ references: [] }));
    expect(withRefs.byteSize).toBeGreaterThan(withoutRefs.byteSize);
  });
});

describe('contentSha256', () => {
  it('is a 64-character hex digest', () => {
    expect(summarize(def()).contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across calls', () => {
    expect(summarize(def()).contentSha256).toBe(summarize(def()).contentSha256);
  });

  it('changes when the body changes', () => {
    const a = summarize(def()).contentSha256;
    const b = summarize(def({ body: '# Bug fix\n\nReproduce twice.\n' })).contentSha256;
    expect(a).not.toBe(b);
  });

  it('changes when a reference file changes', () => {
    const a = summarize(def()).contentSha256;
    const b = summarize(
      def({
        references: [
          { rel: 'references/checklist.md', content: '# Checklist v2\n' },
          { rel: 'references/patterns.md', content: '# Patterns\n' },
        ],
      }),
    ).contentSha256;
    expect(a).not.toBe(b);
  });

  it('changes when a reference is renamed but its content is not', () => {
    const a = summarize(def()).contentSha256;
    const b = summarize(
      def({
        references: [
          { rel: 'references/renamed.md', content: '# Checklist\n' },
          { rel: 'references/patterns.md', content: '# Patterns\n' },
        ],
      }),
    ).contentSha256;
    expect(a).not.toBe(b);
  });

  it('ignores the order references arrive in', () => {
    const a = summarize(def()).contentSha256;
    const b = summarize(
      def({
        references: [
          { rel: 'references/patterns.md', content: '# Patterns\n' },
          { rel: 'references/checklist.md', content: '# Checklist\n' },
        ],
      }),
    ).contentSha256;
    expect(a).toBe(b);
  });

  it('does not change when only the display name changes', () => {
    // The hash covers installed CONTENT. A renamed card is still the same
    // bytes on disk, so a cached copy stays valid.
    const a = summarize(def()).contentSha256;
    const b = summarize(def({ name: 'Bug fixing' })).contentSha256;
    expect(a).toBe(b);
  });
});

describe('summaryEtag', () => {
  it('is stable for the same catalogue', () => {
    expect(summaryEtag([summarize(def())])).toBe(summaryEtag([summarize(def())]));
  });

  it('changes when any skill in the catalogue changes', () => {
    const before = summaryEtag([summarize(def())]);
    const after = summaryEtag([summarize(def({ body: 'different\n' }))]);
    expect(before).not.toBe(after);
  });

  it('changes when a skill is added', () => {
    const one = summaryEtag([summarize(def())]);
    const two = summaryEtag([summarize(def()), summarize(def({ id: 'handoff' }))]);
    expect(one).not.toBe(two);
  });

  it('ignores catalogue ordering, so a reshuffle is not a cache miss', () => {
    const a = summarize(def());
    const b = summarize(def({ id: 'handoff' }));
    expect(summaryEtag([a, b])).toBe(summaryEtag([b, a]));
  });

  it('is quoted, as an HTTP entity-tag must be', () => {
    expect(summaryEtag([summarize(def())])).toMatch(/^"[0-9a-f]{64}"$/);
  });
});
