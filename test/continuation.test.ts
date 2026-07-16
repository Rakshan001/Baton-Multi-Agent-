import { describe, it, expect } from 'vitest';
import { parseHandoffFacts, renderContinuationHead, renderCursorRule, CONTINUATION_MAX_CHARS } from '../src/handoff/continuation.js';

// A representative HANDOFF.md body as brief.ts renders it: dense, single-newline
// separated (blank spacer lines are filtered out before writing).
const BODY = [
  '# Handoff: wire the sales chart to hourly buckets',
  '## Objective',
  'wire the sales chart to hourly buckets',
  '> Note from the handing-off side: API already returns hourly data',
  '## Where to work',
  '```',
  'cd /repo/.baton/wt/sales-hourly',
  '```',
  'Branch `feat/sales-hourly` (based on `main`). Commit here; merge later with `baton merge`.',
  '## State of the work',
  '### Committed vs base',
  '## Plan',
  '- [x] parse the hourly API response',
  '- [ ] render the bucketed bars',
  '- [ ] add the hover tooltip',
  '## Before you finish',
  '- `baton done sales-hourly` (or update this file\'s status) when complete.',
  '## Do NOT',
  '- Touch files outside this worktree.',
].join('\n');

const META = { baton: 1, branch: 'feat/sales-hourly', status: 'ready' as const };

describe('parseHandoffFacts — pulls resume fields from a dense brief body', () => {
  it('extracts objective, first OPEN action, workdir, and slug', () => {
    const f = parseHandoffFacts(BODY);
    expect(f.objective).toBe('wire the sales chart to hourly buckets');
    expect(f.nextAction).toBe('render the bucketed bars'); // first [ ], NOT the completed [x]
    expect(f.workdir).toBe('/repo/.baton/wt/sales-hourly');
    expect(f.slug).toBe('sales-hourly');
  });

  it('skips a "> note" quote line when reading the objective', () => {
    const f = parseHandoffFacts(BODY);
    expect(f.objective).not.toContain('Note from');
  });

  it('leaves nextAction empty when every plan item is done', () => {
    const allDone = BODY.replace('- [ ] render the bucketed bars', '- [x] render the bucketed bars')
      .replace('- [ ] add the hover tooltip', '- [x] add the hover tooltip');
    expect(parseHandoffFacts(allDone).nextAction).toBe('');
  });

  it('returns empty fields for a body with no recognizable sections', () => {
    const f = parseHandoffFacts('just some prose, no headers');
    expect(f).toEqual({ objective: '', nextAction: '', workdir: '', slug: '' });
  });
});

describe('renderContinuationHead — tiny must-read resume block', () => {
  it('surfaces objective, next action, workdir, and a positive-phrased guardrail', () => {
    const head = renderContinuationHead(META, BODY);
    expect(head).toContain('Resume this task');
    expect(head).toContain('wire the sales chart to hourly buckets');
    expect(head).toContain('render the bucketed bars');
    expect(head).toContain('cd /repo/.baton/wt/sales-hourly');
    expect(head).toContain('feat/sales-hourly');
    expect(head).toContain('baton done sales-hourly');
    expect(head).toContain('HANDOFF.md'); // points to the full detail, JIT
  });

  it('phrases guardrails as requirements, not prohibitions (ISS-07)', () => {
    const head = renderContinuationHead(META, BODY);
    expect(head).toContain('Stay inside this worktree');
    expect(head).toContain('run the project tests');
    expect(head).not.toContain('Do NOT');
  });

  it('falls back to a generic next action when the plan is exhausted', () => {
    const allDone = BODY.replace('- [ ] render the bucketed bars', '- [x] render the bucketed bars')
      .replace('- [ ] add the hover tooltip', '- [x] add the hover tooltip');
    const head = renderContinuationHead(META, allDone);
    expect(head.toLowerCase()).toContain('continue the objective');
  });

  it('returns empty when there is no objective to resume', () => {
    expect(renderContinuationHead(META, 'no sections here')).toBe('');
  });

  it('never exceeds the char budget', () => {
    const fat = BODY.replace('wire the sales chart to hourly buckets', 'x'.repeat(2000));
    const head = renderContinuationHead(META, fat);
    expect(head.length).toBeLessThanOrEqual(CONTINUATION_MAX_CHARS);
  });

  it('omits the branch suffix and slug command gracefully when meta/body lack them', () => {
    const noSlugBody = BODY.replace("- `baton done sales-hourly` (or update this file's status) when complete.", '- mark it done when complete.');
    const head = renderContinuationHead({ baton: 1, status: 'ready' }, noSlugBody);
    expect(head).toContain('mark HANDOFF.md done');
    expect(head).not.toContain('(branch `');
  });
});

describe('renderCursorRule — wraps the head for Cursor auto-load (ISS-01, read side)', () => {
  it('emits an always-applied .mdc rule carrying the head', () => {
    const head = renderContinuationHead(META, BODY);
    const rule = renderCursorRule(head);
    expect(rule).toMatch(/^---\n/); // frontmatter
    expect(rule).toContain('alwaysApply: true');
    expect(rule).toContain('Resume this task');
    expect(rule).toContain('render the bucketed bars');
  });

  it('is empty when there is no head (nothing to inject)', () => {
    expect(renderCursorRule('')).toBe('');
  });
});
