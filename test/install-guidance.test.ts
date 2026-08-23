// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Two guarantees about how setup talks to people, both learned the hard way.
 *
 * 1. The dashboard is a viewer, never a mode. Setup used to ask "how will
 *    agents use this knowledge base — dashboard, or headless over MCP?", which
 *    reads like a switch that turns machinery off. It never was: the answer
 *    reached exactly one `console.log` branch, while the graph, the KB, the MCP
 *    servers, the git hooks, the skills and the agent wiring all ran either
 *    way. A question whose answer changes nothing still costs the reader a
 *    decision, and this one charged them for it by implying they might be
 *    giving something up. The closing text now states both truths at once, so
 *    the guarantee lives here rather than in a comment someone can delete.
 *
 * 2. Baton is a CLI, not a library. `npm i batonhq` inside a project makes npm
 *    reconcile that project's whole dependency tree — which, in a repo with
 *    native modules, means recompiling them. That is how a perfectly healthy
 *    install ends in a node-gyp backtrace that names Baton in the path and
 *    looks, to the person reading it, exactly like Baton's fault.
 */
import { describe, it, expect } from 'vitest';
import { closingLines, batonAsDependency } from '../src/commands/setup.js';

describe('closingLines', () => {
  const lines = (graphOk = true) => closingLines('/tmp/demo', 'demo is ready', 7077, graphOk).join('\n');

  it('offers the dashboard', () => {
    expect(lines()).toContain('baton serve');
  });

  it('says agents already work over MCP', () => {
    expect(lines()).toMatch(/MCP/);
  });

  // The whole point: neither fact is behind a choice any more.
  it('states both, so neither reads as the thing you gave up', () => {
    const out = lines();
    expect(out).toContain('baton serve');
    expect(out).toMatch(/MCP/);
  });

  it('names the port it actually picked', () => {
    expect(closingLines('/tmp/demo', 'x', 7079, true).join('\n')).toContain('7079');
  });

  it('admits when the graph is missing rather than claiming full readiness', () => {
    expect(lines(false)).toContain('without the knowledge graph');
  });

  it('does not claim a missing graph when the graph is there', () => {
    expect(lines(true)).not.toContain('without the knowledge graph');
  });
});

describe('batonAsDependency', () => {
  it('catches it in dependencies', () => {
    expect(batonAsDependency({ dependencies: { batonhq: '^0.1.0' } })).toMatch(/batonhq/);
  });

  it('catches it in devDependencies', () => {
    expect(batonAsDependency({ devDependencies: { batonhq: '^0.1.0' } })).toMatch(/batonhq/);
  });

  it('points at the two ways that actually work', () => {
    const warning = batonAsDependency({ dependencies: { batonhq: '0.1.0' } }) ?? '';
    expect(warning).toContain('npx batonhq');
    expect(warning).toContain('npm i -g batonhq');
  });

  it('stays quiet for a project that did it right', () => {
    expect(batonAsDependency({ dependencies: { react: '^19.0.0' } })).toBeNull();
  });

  it('stays quiet when there is no package.json at all', () => {
    expect(batonAsDependency(null)).toBeNull();
  });

  // A package.json is arbitrary user input; a malformed one must not throw and
  // take a finished setup down with it.
  it('survives a malformed package.json', () => {
    expect(batonAsDependency('not an object')).toBeNull();
    expect(batonAsDependency({ dependencies: 'nonsense' })).toBeNull();
    expect(batonAsDependency({ dependencies: null })).toBeNull();
  });
});
