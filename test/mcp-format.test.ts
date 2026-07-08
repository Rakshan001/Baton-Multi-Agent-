import { describe, it, expect } from 'vitest';
import { asText, capList } from '../src/mcp-format.js';
import { reportSummary, type CompletionReport } from '../src/reports.js';

describe('asText — compact MCP payloads (no pretty-print tax)', () => {
  it('serializes single-line JSON, not indented', () => {
    const out = asText({ a: 1, b: [2, 3] });
    const text = out.content[0].text;
    expect(text).toBe('{"a":1,"b":[2,3]}');
    expect(text).not.toContain('\n');
    expect(JSON.parse(text)).toEqual({ a: 1, b: [2, 3] }); // still valid JSON
  });
});

describe('capList — bound unbounded responses with an honest "N more"', () => {
  it('returns everything and more:0 when under the cap', () => {
    expect(capList([1, 2, 3], 5)).toEqual({ items: [1, 2, 3], more: 0 });
  });
  it('truncates and reports how many were dropped', () => {
    expect(capList([1, 2, 3, 4, 5], 2)).toEqual({ items: [1, 2], more: 3 });
  });
});

describe('reportSummary — compact row instead of a full report', () => {
  const full: CompletionReport = {
    slug: 'add-oauth', task: 'Add OAuth login', agent: 'claude',
    mergedAt: '2026-07-08T00:00:00.000Z', summary: 'Added OAuth\nwith Google',
    files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    commits: [{ sha: 'abc', message: 'wip', at: '2026-07-08T00:00:00.000Z' }],
    overlappedWith: ['fix-login'],
  };

  it('drops the heavy files[]/commits[] arrays, keeps a fileCount + first summary line', () => {
    const s = reportSummary(full);
    expect(s).toEqual({
      slug: 'add-oauth', task: 'Add OAuth login', agent: 'claude',
      mergedAt: '2026-07-08T00:00:00.000Z', summary: 'Added OAuth',
      fileCount: 3, overlappedWith: ['fix-login'],
    });
    expect(s).not.toHaveProperty('commits');
    expect(s).not.toHaveProperty('files');
  });
});
