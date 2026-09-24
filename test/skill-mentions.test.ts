// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The undeclared-mention check: a skill whose text tells an agent to follow
 * another skill that is not in its `requires`.
 *
 * The failure it exists to catch is silent — the referenced skill is simply not
 * installed, no error is raised, and the agent invents something worse — so the
 * only thing that makes it real is that this function never cries wolf. Hence
 * the negative cases below outnumber the positive ones: a fenced example, a
 * longer id that merely contains a shorter one, the skill naming itself.
 */
import { describe, expect, it } from 'vitest';
import { undeclaredMentions } from '../src/skills/lint.js';

const KNOWN = ['bug-fix', 'systematic-debugging', 'code-review', 'verify-before-done'];

describe('undeclaredMentions', () => {
  it('flags a skill the body points at but does not declare', () => {
    expect(undeclaredMentions({
      id: 'bug-fix',
      body: 'Reproduce first, then follow the systematic-debugging process.\n',
      known: KNOWN,
    })).toEqual(['systematic-debugging']);
  });

  it('says nothing when the mention is already declared', () => {
    expect(undeclaredMentions({
      id: 'bug-fix',
      body: 'Follow systematic-debugging, then code-review the diff.\n',
      known: KNOWN,
      requires: ['systematic-debugging', 'code-review'],
    })).toEqual([]);
  });

  it('never flags the skill naming itself', () => {
    expect(undeclaredMentions({
      id: 'bug-fix',
      body: 'The bug-fix skill is invoked with /bug-fix. Use bug-fix for bugs.\n',
      known: KNOWN,
    })).toEqual([]);
  });

  it('ignores a mention inside a fenced code block', () => {
    const body = [
      'Run it like this:',
      '```bash',
      'baton skills install systematic-debugging',
      '```',
      'Then review the diff.',
    ].join('\n');
    expect(undeclaredMentions({ id: 'bug-fix', body, known: KNOWN })).toEqual([]);
  });

  it('ignores a tilde fence too, and resumes flagging after it closes', () => {
    const body = [
      '~~~',
      'install systematic-debugging',
      '~~~',
      'Afterwards, run code-review.',
    ].join('\n');
    expect(undeclaredMentions({ id: 'bug-fix', body, known: KNOWN })).toEqual(['code-review']);
  });

  it('treats an unclosed fence as fencing everything after it', () => {
    const body = 'Intro.\n```\ncode-review\nsystematic-debugging\n';
    expect(undeclaredMentions({ id: 'bug-fix', body, known: KNOWN })).toEqual([]);
  });

  it('still flags a mention in inline backticks — prose is where it matters', () => {
    expect(undeclaredMentions({
      id: 'bug-fix',
      body: 'Follow the `systematic-debugging` skill first.\n',
      known: KNOWN,
    })).toEqual(['systematic-debugging']);
  });

  it('matches on word boundaries that count a hyphen as part of the name', () => {
    const known = [...KNOWN, 'debugging'];
    // "debugging" lives inside "systematic-debugging"; only the longer id is
    // actually mentioned.
    expect(undeclaredMentions({
      id: 'bug-fix',
      body: 'Use systematic-debugging here.\n',
      known,
    })).toEqual(['systematic-debugging']);
    // ...and a longer word that merely starts with an id is not that id.
    expect(undeclaredMentions({
      id: 'x',
      body: 'A bug-fixer and a superbug-fix walk into a bar.\n',
      known: KNOWN,
    })).toEqual([]);
    // ...nor is a short id that happens to be one hyphenated piece of a longer
    // name the library does not know. A plain \b boundary would report both.
    expect(undeclaredMentions({ id: 'x', body: 'Run code-review now.\n', known: ['review', 'fix'] })).toEqual([]);
    expect(undeclaredMentions({ id: 'x', body: 'Run bug-fix now.\n', known: ['fix'] })).toEqual([]);
  });

  it('reports each id once, however often it is mentioned', () => {
    expect(undeclaredMentions({
      id: 'x',
      body: 'code-review. code-review! Then code-review again.\nAnd bug-fix.\n',
      known: KNOWN,
    })).toEqual(['code-review', 'bug-fix']);   // first-appearance order
  });

  it('flags a mention whose case differs, under the id it knows', () => {
    expect(undeclaredMentions({
      id: 'x',
      body: 'Then run Code-Review on the branch.\n',
      known: KNOWN,
    })).toEqual(['code-review']);
  });

  it('never invents a skill nobody knows about', () => {
    expect(undeclaredMentions({
      id: 'x',
      body: 'Follow the totally-made-up skill.\n',
      known: KNOWN,
    })).toEqual([]);
  });

  it('treats regex metacharacters in an id as literal text', () => {
    // An id arrives from an upload or a GitHub import: `a.c` must not match
    // "abc", and `c++` must not blow up the regex engine.
    expect(undeclaredMentions({ id: 'x', body: 'abc\n', known: ['a.c'] })).toEqual([]);
    expect(undeclaredMentions({ id: 'x', body: 'a.c\n', known: ['a.c'] })).toEqual(['a.c']);
    expect(undeclaredMentions({ id: 'x', body: 'use c++ here\n', known: ['c++'] })).toEqual(['c++']);
    expect(undeclaredMentions({ id: 'x', body: 'anything\n', known: ['.*'] })).toEqual([]);
  });

  it('handles __proto__ as a plain name, polluting nothing', () => {
    expect(undeclaredMentions({ id: 'x', body: 'see __proto__ for details\n', known: ['__proto__'] }))
      .toEqual(['__proto__']);
    expect(undeclaredMentions({ id: 'x', body: 'see toString\n', known: ['bug-fix'] })).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('is pure: same answer twice, and the caller’s arrays are untouched', () => {
    const known = [...KNOWN];
    const requires = ['code-review'];
    const input = { id: 'bug-fix', body: 'code-review then systematic-debugging\n', known, requires };
    const first = undeclaredMentions(input);
    const second = undeclaredMentions(input);
    expect(first).toEqual(['systematic-debugging']);
    expect(second).toEqual(first);
    expect(known).toEqual(KNOWN);
    expect(requires).toEqual(['code-review']);
  });

  it('says nothing about an empty body or an empty catalogue', () => {
    expect(undeclaredMentions({ id: 'x', body: '', known: KNOWN })).toEqual([]);
    expect(undeclaredMentions({ id: 'x', body: 'bug-fix\n', known: [] })).toEqual([]);
  });
});
