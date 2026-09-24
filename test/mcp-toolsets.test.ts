// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The tool-set resolver: configuration in, tool names out, nothing else.
 *
 * These tests are deliberately all synchronous and all in-memory. That is the
 * property under test as much as any assertion below — a resolver that reached
 * for the filesystem or the clock would resolve differently per session, and a
 * client that caches `tools/list` at connect would never find out.
 */
import { describe, it, expect } from 'vitest';
import { resolveToolSet, ToolSetError, TOOL_SETS, ALL_TOOLS } from '../src/mcp-toolsets.js';

/** A tiny universe, so a test says what it means without 19 tool names in it. */
const ALL = ['a', 'b', 'c', 'd'] as const;

describe('resolveToolSet — the default is every tool', () => {
  it('resolves absent configuration to EVERY tool', () => {
    expect(resolveToolSet(undefined).tools).toEqual([...ALL_TOOLS]);
  });

  it('resolves empty configuration to EVERY tool', () => {
    expect(resolveToolSet([]).tools).toEqual([...ALL_TOOLS]);
    expect(resolveToolSet('').tools).toEqual([...ALL_TOOLS]);
    expect(resolveToolSet('   ').tools).toEqual([...ALL_TOOLS]);
  });

  it('serves the whole catalog by default, so nothing disappears until asked', () => {
    // The wiring is a separate change; until then this is the contract that
    // makes it safe — an unconfigured Baton behaves exactly as it does today.
    expect(ALL_TOOLS.length).toBeGreaterThan(0);
    expect(resolveToolSet(undefined).tools).toHaveLength(ALL_TOOLS.length);
  });
});

describe('resolveToolSet — named, composable groups', () => {
  const sets = {
    one: ['a', 'b'],
    two: ['c'],
    both: ['@one', '@two'],
    overlapping: ['@one', 'b', 'a'],
  };

  it('resolves a named group to its tools', () => {
    expect(resolveToolSet('one', { sets, all: ALL }).tools).toEqual(['a', 'b']);
  });

  it('accepts a group that includes another group', () => {
    expect(resolveToolSet('both', { sets, all: ALL }).tools).toEqual(['a', 'b', 'c']);
  });

  it('lists a tool named twice exactly once, in first-seen order', () => {
    expect(resolveToolSet('overlapping', { sets, all: ALL }).tools).toEqual(['a', 'b']);
    expect(resolveToolSet(['one', 'two', 'one'], { sets, all: ALL }).tools).toEqual(['a', 'b', 'c']);
  });

  it('takes several groups at once', () => {
    expect(resolveToolSet(['two', 'one'], { sets, all: ALL }).tools).toEqual(['c', 'a', 'b']);
  });
});

describe('resolveToolSet — a cycle terminates and is reported', () => {
  const sets = {
    ping: ['a', '@pong'],
    pong: ['b', '@ping'],
    selfish: ['@selfish', 'c'],
  };

  it('does not hang on a two-group cycle, and still resolves the tools', () => {
    const r = resolveToolSet('ping', { sets, all: ALL });
    expect(r.tools).toEqual(['a', 'b']);
    expect(r.cycles.length).toBeGreaterThan(0);
    expect(r.cycles.join(' ')).toContain('ping');
    expect(r.cycles.join(' ')).toContain('pong');
  });

  it('does not hang on a group that includes itself', () => {
    const r = resolveToolSet('selfish', { sets, all: ALL });
    expect(r.tools).toEqual(['c']);
    expect(r.cycles.join(' ')).toContain('selfish');
  });

  it('reports no cycle when there is none', () => {
    expect(resolveToolSet('pong', { sets: { pong: ['b'] }, all: ALL }).cycles).toEqual([]);
  });
});

describe('resolveToolSet — an unknown name is refused loudly', () => {
  const sets = { core: ['a'], handoff: ['b'] };

  it('refuses an unknown group instead of resolving it to nothing', () => {
    expect(() => resolveToolSet('kore', { sets, all: ALL })).toThrow(ToolSetError);
    // Never the empty set: "no tools" reads as a broken Baton, not as a typo.
    let thrown: unknown;
    try { resolveToolSet('kore', { sets, all: ALL }); } catch (e) { thrown = e; }
    expect(String((thrown as Error).message)).toContain('kore');
    expect(String((thrown as Error).message)).toContain('core');
    expect(String((thrown as Error).message)).toContain('handoff');
  });

  it('refuses an unknown group nested inside a known one', () => {
    expect(() => resolveToolSet('core', { sets: { core: ['a', '@nope'] }, all: ALL })).toThrow(/nope/);
  });

  it('refuses a member that is not a tool this server serves', () => {
    expect(() => resolveToolSet('core', { sets: { core: ['a', 'zzz'] }, all: ALL })).toThrow(/zzz/);
  });

  it('names the valid groups even when none is configured', () => {
    expect(() => resolveToolSet('anything', { sets: {}, all: ALL })).toThrow(ToolSetError);
  });
});

describe('resolveToolSet — an inherited Object key is an unknown name, not a crash', () => {
  const sets = { core: ['a'], handoff: ['b'] };
  // The selection is caller-supplied text going straight into object-key
  // position. On a plain object `sets['constructor']` finds Object.prototype's
  // own, which is truthy and not iterable — a raw TypeError instead of the
  // loud refusal the contract promises, and the classic prototype-pollution
  // shape besides.
  const inherited = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf'];

  for (const name of inherited) {
    it(`refuses '${name}' with the same ToolSetError as any other typo`, () => {
      let thrown: unknown;
      try { resolveToolSet(name, { sets, all: ALL }); } catch (e) { thrown = e; }
      expect(thrown, `'${name}' resolved instead of being refused`).toBeInstanceOf(ToolSetError);
      const message = String((thrown as Error).message);
      expect(message).toContain(name);
      expect(message).toContain('core');
      expect(message).toContain('handoff');
    });

    it(`refuses '${name}' when a group includes it`, () => {
      const nested = { core: ['a', `@${name}`] };
      expect(() => resolveToolSet('core', { sets: nested, all: ALL })).toThrow(ToolSetError);
    });

    it(`refuses '${name}' as a tool member, since ALL is a list of names too`, () => {
      expect(() => resolveToolSet('core', { sets: { core: [name] }, all: ALL })).toThrow(ToolSetError);
    });
  }

  it('still resolves a group genuinely NAMED constructor, because it is just a string', () => {
    const own = { constructor: ['a'], core: ['@constructor'] };
    expect(resolveToolSet('constructor', { sets: own, all: ALL }).tools).toEqual(['a']);
    expect(resolveToolSet('core', { sets: own, all: ALL }).tools).toEqual(['a']);
  });

  it('refuses an inherited key against the SHIPPED sets too', () => {
    expect(() => resolveToolSet('constructor')).toThrow(ToolSetError);
    expect(() => resolveToolSet('__proto__')).toThrow(ToolSetError);
    expect(() => resolveToolSet('toString')).toThrow(ToolSetError);
  });
});

/**
 * The same defect the inherited-key tests above cover, one level down.
 *
 * `ToolSetDefinitions` types a group's members as an array of strings, but the
 * whole point of this resolver is that it reads CONFIGURATION — text somebody
 * wrote in a file, which TypeScript never saw. `{"core": "orient"}` is the
 * mistake anyone makes once, and it resolved to the six CHARACTERS of the
 * string; `{"core": 5}` and a null member threw a raw TypeError where the
 * contract at the top of the module promises a loud refusal that names the
 * offender. Both are the shape `resolveToolSet('constructor')` had.
 */
describe('resolveToolSet — a malformed member list is refused, not iterated', () => {
  const malformed = (members: unknown) => ({ core: members }) as unknown as Parameters<typeof resolveToolSet>[1]['sets'];

  it('refuses a group written as a bare string instead of resolving its letters', () => {
    // 'ab' is not "the tools a and b" — it is a configuration mistake.
    expect(() => resolveToolSet('core', { sets: malformed('ab'), all: ALL })).toThrow(ToolSetError);
  });

  it('refuses a number where a member list belongs, with a named error', () => {
    let thrown: unknown;
    try { resolveToolSet('core', { sets: malformed(5), all: ALL }); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(ToolSetError);
    expect(String((thrown as Error).message)).toContain('core');
  });

  it('refuses an object where a member list belongs', () => {
    expect(() => resolveToolSet('core', { sets: malformed({ a: 1 }), all: ALL })).toThrow(ToolSetError);
  });

  it('refuses a non-string member rather than reading .startsWith off null', () => {
    expect(() => resolveToolSet('core', { sets: malformed(['a', null]), all: ALL })).toThrow(ToolSetError);
    expect(() => resolveToolSet('core', { sets: malformed(['a', 7]), all: ALL })).toThrow(ToolSetError);
  });

  it('still accepts a genuinely empty group — configured to serve nothing is not a mistake', () => {
    expect(resolveToolSet('core', { sets: { core: [] }, all: ALL }).tools).toEqual([]);
  });
});

describe('TOOL_SETS — the two shipped groups', () => {
  it('ships exactly core and handoff, and nothing invented beyond them', () => {
    expect(Object.keys(TOOL_SETS).sort()).toEqual(['core', 'handoff']);
  });

  it('resolves both against the real tool list without refusing anything', () => {
    for (const name of Object.keys(TOOL_SETS)) {
      const r = resolveToolSet(name);
      expect(r.tools.length, `${name} resolved to nothing`).toBeGreaterThan(0);
      expect(r.cycles, `${name} has a cycle`).toEqual([]);
      for (const tool of r.tools) expect(ALL_TOOLS).toContain(tool);
    }
  });

  it('gives handoff the coordination floor as well as the relay', () => {
    // handoff includes @core, so an agent picking up a brief can still see who
    // is editing what — a relay without coordination is just a file drop.
    const core = resolveToolSet('core').tools;
    const handoff = resolveToolSet('handoff').tools;
    for (const tool of core) expect(handoff).toContain(tool);
    expect(handoff).toContain('create_handoff');
    expect(handoff.length).toBeGreaterThan(core.length);
  });

  it('is a pure function of its arguments — same input, same output, twice', () => {
    expect(resolveToolSet('handoff')).toEqual(resolveToolSet('handoff'));
  });

  it('hands back a fresh array the caller cannot use to mutate the config', () => {
    const first = resolveToolSet('core');
    first.tools.push('not_a_tool');
    expect(resolveToolSet('core').tools).not.toContain('not_a_tool');
  });
});
