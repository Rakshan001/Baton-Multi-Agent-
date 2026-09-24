// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The skill graph: two declared relations (`requires`, `works-with`) and the
 * walk over them.
 *
 * Frontmatter reaches this code from GitHub imports and pasted uploads, so
 * every test here is written against a HOSTILE author: a cycle, a name nobody
 * has imported, `__proto__` as a dependency. None of those may hang, throw, or
 * stop a skill installing — a relation is a hint about other skills, never a
 * gate on this one.
 */
import { describe, expect, it } from 'vitest';
import { bundledSkills, type SkillDef } from '../src/skills/catalog.js';
import { parseRelations, resolveRequires } from '../src/skills/graph.js';
import { parseFrontmatter } from '../src/util/frontmatter.js';

/** A minimal SkillDef; only the graph fields matter here. */
function skill(id: string, over: Partial<SkillDef> = {}): SkillDef {
  return {
    id,
    name: id,
    description: `The ${id} skill.`,
    tags: [],
    produces: [],
    body: `# ${id}\n`,
    references: [],
    source: 'bundled',
    requires: [],
    worksWith: [],
    ...over,
  };
}

describe('parseRelations — frontmatter into graph fields', () => {
  it('reads requires and works-with off real YAML frontmatter', () => {
    const { data } = parseFrontmatter(
      '---\nname: bug-fix\nrequires:\n  - systematic-debugging\nworks-with:\n  - code-review\n  - test-writer\n---\n\n# Bug fix\n',
    );
    expect(parseRelations(data)).toEqual({
      requires: ['systematic-debugging'],
      worksWith: ['code-review', 'test-writer'],
    });
  });

  it('defaults both to empty arrays when the frontmatter says nothing', () => {
    const { data } = parseFrontmatter('---\nname: bug-fix\n---\n\n# Bug fix\n');
    expect(parseRelations(data)).toEqual({ requires: [], worksWith: [] });
    expect(parseRelations({})).toEqual({ requires: [], worksWith: [] });
  });

  it('ignores a relation that is not a list of names', () => {
    // `requires: {}` and `works-with: 3` are author mistakes, not a reason to
    // refuse the skill.
    expect(parseRelations({ requires: {}, 'works-with': 3 })).toEqual({ requires: [], worksWith: [] });
    expect(parseRelations({ requires: ['  spaced  ', '', '  '] })).toEqual({ requires: ['spaced'], worksWith: [] });
  });

  it('gives every bundled skill both fields as arrays', async () => {
    const all = await bundledSkills();
    expect(all.length).toBeGreaterThan(0);
    for (const s of all) {
      expect(Array.isArray(s.requires), `${s.id}.requires`).toBe(true);
      expect(Array.isArray(s.worksWith), `${s.id}.worksWith`).toBe(true);
    }
  });
});

describe('resolveRequires', () => {
  it('returns the root plus its transitive requires, each exactly once', () => {
    const all = [
      skill('a', { requires: ['b'] }),
      skill('b', { requires: ['c'] }),
      skill('c'),
    ];
    const r = resolveRequires('a', all);
    expect(r.ids).toEqual(['a', 'b', 'c']);
    expect(r.missing).toEqual([]);
  });

  it('includes the root exactly once when a diamond points back at it', () => {
    const all = [
      skill('root', { requires: ['left', 'right'] }),
      skill('left', { requires: ['shared'] }),
      skill('right', { requires: ['shared', 'root'] }),
      skill('shared'),
    ];
    const r = resolveRequires('root', all);
    expect(r.ids.filter((id) => id === 'root')).toHaveLength(1);
    expect([...r.ids].sort()).toEqual(['left', 'right', 'root', 'shared']);
  });

  it('terminates on a cycle instead of hanging', () => {
    const all = [skill('a', { requires: ['b'] }), skill('b', { requires: ['a'] })];
    const started = Date.now();
    const r = resolveRequires('a', all);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(r.ids).toEqual(['a', 'b']);
    expect(r.missing).toEqual([]);
  });

  it('reports an unknown name instead of throwing, and still resolves the rest', () => {
    const all = [skill('a', { requires: ['gone', 'b'] }), skill('b')];
    const r = resolveRequires('a', all);
    expect(r.ids).toEqual(['a', 'b']);          // the install can still proceed
    expect(r.missing).toEqual(['gone']);
  });

  it('reports an unknown root rather than inventing it', () => {
    const r = resolveRequires('nope', [skill('a')]);
    expect(r.ids).toEqual([]);
    expect(r.missing).toEqual(['nope']);
  });

  it('reports each unknown name once, however many skills ask for it', () => {
    const all = [
      skill('a', { requires: ['gone', 'b'] }),
      skill('b', { requires: ['gone'] }),
    ];
    expect(resolveRequires('a', all).missing).toEqual(['gone']);
  });

  it('treats __proto__ as a plain name: no pollution, no phantom skill', () => {
    const all = [skill('a', { requires: ['__proto__', 'constructor', 'toString'] })];
    const r = resolveRequires('a', all);
    expect(r.ids).toEqual(['a']);
    expect([...r.missing].sort()).toEqual(['__proto__', 'constructor', 'toString']);
    // Nothing inherited may read back as a skill...
    expect(resolveRequires('constructor', all).ids).toEqual([]);
    expect(resolveRequires('toString', all).ids).toEqual([]);
    // ...and nothing may have leaked onto Object.prototype.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'a')).toBe(false);
  });

  it('resolves a skill actually named __proto__ like any other', () => {
    const all = [skill('a', { requires: ['__proto__'] }), skill('__proto__')];
    const r = resolveRequires('a', all);
    expect(r.ids).toEqual(['a', '__proto__']);
    expect(r.missing).toEqual([]);
  });
});
