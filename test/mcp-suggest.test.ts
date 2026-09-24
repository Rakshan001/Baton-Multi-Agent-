// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `suggest_skills` — the ranking behind "which of these thirty-odd skills does
 * this task need?".
 *
 * The whole point of the skill-fetch plan is that an agent receives five
 * one-line descriptions instead of twelve full playbooks, so two properties are
 * load-bearing and are asserted here rather than assumed: the answer never
 * carries a body, and it stays inside ~1k tokens no matter how verbose the
 * catalogue is.
 *
 * The order is structural — attached to this project, then a `requires` that is
 * provably missing, then text, then `works-with`, with anything already
 * installed demoted to the end. No model, no embedding: every tier below is a
 * join over data Baton already holds.
 */
import { describe, expect, it } from 'vitest';
import { rankSkillSuggestions, SUGGEST_CAP, type SuggestCandidate } from '../src/mcp-suggest.js';

function candidate(id: string, over: Partial<SuggestCandidate> = {}): SuggestCandidate {
  return {
    id,
    name: id,
    description: `The ${id} skill.`,
    tags: [],
    source: 'bundled',
    installed: false,
    requires: [],
    worksWith: [],
    ...over,
  };
}

const ids = (out: { id: string }[]): string[] => out.map((s) => s.id);

describe('rankSkillSuggestions', () => {
  it('orders the four signals: attached, missing requires, text match, works-with', () => {
    const all = [
      candidate('works', { worksWith: [] }),
      candidate('text-match', { description: 'Handles a flaky webhook test.' }),
      candidate('missing-req'),
      candidate('attached', { source: 'imported' }),
      candidate('installed-one', {
        installed: true, requires: ['missing-req'], worksWith: ['works'],
      }),
    ];
    expect(ids(rankSkillSuggestions('flaky webhook test', all)))
      .toEqual(['attached', 'missing-req', 'text-match', 'works']);
  });

  it('demotes an already-installed skill to last, however well it matches', () => {
    const all = [
      candidate('installed-match', { installed: true, description: 'All about flaky webhook tests.' }),
      candidate('works', { description: 'Unrelated.' }),
      candidate('installed-two', { installed: true, worksWith: ['works'] }),
    ];
    const out = ids(rankSkillSuggestions('flaky webhook', all));
    expect(out[0]).toBe('works');
    expect(out).toContain('installed-match');
    expect(out.indexOf('installed-match')).toBeGreaterThan(out.indexOf('works'));
  });

  it('suggests nothing for a skill with no signal at all — no filler', () => {
    const all = [candidate('unrelated', { description: 'Something else entirely.' })];
    expect(rankSkillSuggestions('flaky webhook test', all)).toEqual([]);
  });

  it('still answers a task string it cannot match, from structure alone', () => {
    const all = [
      candidate('attached', { source: 'imported' }),
      candidate('needed'),
      candidate('holder', { installed: true, requires: ['needed'] }),
      candidate('noise', { description: 'Nothing to do with anything.' }),
    ];
    expect(ids(rankSkillSuggestions('', all))).toEqual(['attached', 'needed']);
  });

  it(`caps the answer at ${SUGGEST_CAP}`, () => {
    const all = Array.from({ length: 12 }, (_, i) =>
      candidate(`s${i}`, { source: 'imported', description: 'flaky webhook test' }));
    expect(SUGGEST_CAP).toBe(5);
    expect(rankSkillSuggestions('flaky webhook test', all)).toHaveLength(SUGGEST_CAP);
  });

  it('returns summaries, never bodies', () => {
    const withBody = {
      ...candidate('attached', { source: 'imported' }),
      body: '# Secret playbook\n\nStep one of eighty.\n',
    } as SuggestCandidate;
    const out = rankSkillSuggestions('anything', [withBody]);
    expect(out).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain('Secret playbook');
    for (const s of out) {
      expect(Object.keys(s).sort()).toEqual(['description', 'id', 'name', 'why']);
    }
  });

  it('stays well under 1k tokens even against a catalogue of essays', () => {
    const essay = 'This skill does a great many things, at length, in prose. '.repeat(40);
    const all = Array.from({ length: 12 }, (_, i) =>
      candidate(`skill-number-${i}`, { source: 'imported', description: essay }));
    const bytes = Buffer.byteLength(JSON.stringify(rankSkillSuggestions('anything', all)), 'utf8');
    // ~4 bytes per token: 4,000 bytes is the 1k-token ceiling with room to spare.
    expect(bytes).toBeLessThan(4_000);
  });

  it('says WHY each suggestion is there', () => {
    const all = [
      candidate('attached', { source: 'imported' }),
      candidate('needed'),
      candidate('holder', { installed: true, requires: ['needed'], worksWith: ['friend'] }),
      candidate('friend'),
      candidate('matcher', { description: 'flaky webhook triage' }),
    ];
    const why = Object.fromEntries(rankSkillSuggestions('flaky webhook', all).map((s) => [s.id, s.why]));
    expect(why.attached).toMatch(/project/i);
    expect(why.needed).toMatch(/required by holder/i);
    expect(why.matcher).toMatch(/match/i);
    expect(why.friend).toMatch(/works with holder/i);
  });

  it('breaks ties deterministically, by id', () => {
    const all = [candidate('zebra', { source: 'imported' }), candidate('alpha', { source: 'imported' })];
    expect(ids(rankSkillSuggestions('', all))).toEqual(['alpha', 'zebra']);
    expect(ids(rankSkillSuggestions('', [...all].reverse()))).toEqual(['alpha', 'zebra']);
  });

  it('survives a hostile catalogue: __proto__ names pollute nothing', () => {
    const all = [
      candidate('holder', { installed: true, requires: ['__proto__'], worksWith: ['constructor'] }),
      candidate('__proto__'),
    ];
    const out = rankSkillSuggestions('', all);
    expect(ids(out)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
