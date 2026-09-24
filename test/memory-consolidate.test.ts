// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { factSimilarity, fingerprintOf, type MemoryFact } from '../src/memory.js';
import {
  consolidateFacts,
  MAX_CONTRADICTION_REPORTS,
  sigWords,
  similarity,
  type ConsolidateOp,
} from '../src/memory/consolidate.js';

/**
 * The zero-LLM consolidation pass. It runs for every user whether or not they
 * ever open Settings, so it has to be useful on its own AND incapable of
 * losing knowledge: it emits OPERATIONS, the caller writes, and the only write
 * it can ask for is `supersede`. It never rewrites a sentence an agent or a
 * human wrote, and a pair that contradicts is handed to a person rather than
 * resolved.
 */

const START = Date.parse('2026-09-05T12:00:00.000Z');
const ago = (mins: number) => new Date(START - mins * 60_000).toISOString();

let seq = 0;
function fact(text: string, over: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: `mem-${++seq}`,
    type: 'convention',
    fact: text,
    agent: 'claude',
    author: 'rakshan',
    task: null,
    createdAt: ago(60),
    anchors: { commit: 'abc123', files: [] },
    supersedes: null,
    fingerprint: fingerprintOf(text),
    ...over,
  };
}

const supersedes = (ops: ConsolidateOp[]) => ops.filter((o) => o.op === 'supersede');
const reports = (ops: ConsolidateOp[]) => ops.filter((o) => o.op === 'report');

/** What the caller would do with the plan: retire the superseded facts. */
function apply(facts: MemoryFact[], ops: ConsolidateOp[]): MemoryFact[] {
  const gone = new Set(supersedes(ops).map((o) => o.id));
  return facts.filter((f) => !gone.has(f.id));
}

describe('consolidateFacts — merging', () => {
  it('supersedes the older of two identical facts, by the newer', () => {
    const older = fact('Git calls go through src/util/exec.ts, never a raw shell.', { createdAt: ago(600) });
    const newer = fact('Git calls go through src/util/exec.ts, never a raw shell.', { createdAt: ago(10) });
    const ops = consolidateFacts([older, newer], { startedAt: START });
    expect(supersedes(ops)).toEqual([
      { op: 'supersede', id: older.id, supersededBy: newer.id, reason: expect.stringContaining('duplicate') },
    ]);
  });

  it('merges a near-duplicate that shares the fingerprint', () => {
    const older = fact('Realtime updates flow over SSE, not socket.io, by explicit decision.', { createdAt: ago(600) });
    const newer = fact('Realtime updates flow over SSE, not socket.io — an explicit decision taken early.', { createdAt: ago(5) });
    expect(newer.fingerprint).toBe(older.fingerprint);
    const ops = supersedes(consolidateFacts([older, newer], { startedAt: START }));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ id: older.id, supersededBy: newer.id });
  });

  it('leaves two facts about different things alone', () => {
    const a = fact('The daemon is raw node:http with no framework.');
    const b = fact('The dashboard is built with Vite and served by baton serve.');
    expect(consolidateFacts([a, b], { startedAt: START })).toEqual([]);
  });

  it('does not merge similar text under a different fingerprint — the pass is conservative', () => {
    const a = fact('Demo mode defaults on only for the Vite dev origin.', { createdAt: ago(600) });
    const b = fact('Only the Vite dev origin gets demo mode on by default.', { createdAt: ago(5) });
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(supersedes(consolidateFacts([a, b], { startedAt: START }))).toEqual([]);
  });

  it('collapses a group of three onto the newest, with no chains', () => {
    const oldest = fact('Facts are stored one markdown file per fact under .baton/memory.', { createdAt: ago(900) });
    const middle = fact('Facts are stored one markdown file per fact inside .baton/memory/facts.', { createdAt: ago(300) });
    const newest = fact('Facts are stored one markdown file per fact in .baton/memory/facts, written atomically.', { createdAt: ago(4) });
    const ops = supersedes(consolidateFacts([middle, newest, oldest], { startedAt: START }));
    expect(ops.map((o) => o.id).sort()).toEqual([middle.id, oldest.id].sort());
    for (const o of ops) expect(o.supersededBy).toBe(newest.id);
  });

  it('never emits a delete, and never carries replacement text', () => {
    const older = fact('Memory is always stored in the main repository, never per worktree.', { createdAt: ago(600) });
    const newer = fact('Memory is always stored in the main repository and never in a worktree.', { createdAt: ago(6) });
    const ops = consolidateFacts([older, newer], { startedAt: START });
    expect(ops.length).toBeGreaterThan(0);
    for (const o of ops) {
      expect(['supersede', 'report']).toContain(o.op);
      // The plan can only ever name ids. A field carrying a sentence would be
      // a field that can change what a fact says.
      expect(JSON.stringify(o)).not.toContain(older.fact);
      expect(JSON.stringify(o)).not.toContain(newer.fact);
    }
  });

  it('never supersedes a shared fact with a local-only one', () => {
    const tracked = fact('The MCP surface is budgeted; every tool costs a schema each session.', { createdAt: ago(600) });
    const local = fact('The MCP surface is budgeted, and every tool costs one schema per session.', {
      createdAt: ago(5), localOnly: true, area: 'local',
    });
    // Retiring the tracked fact in favour of a local one would delete it from
    // every other clone, so the pass declines rather than choosing.
    expect(supersedes(consolidateFacts([tracked, local], { startedAt: START }))).toEqual([]);
  });
});

describe('consolidateFacts — contradiction is a human’s call', () => {
  it('reports a negated twin instead of merging it', () => {
    const a = fact('The daemon serves the dashboard on port 7077.', { createdAt: ago(600) });
    const b = fact('The daemon does not serve the dashboard on port 7077.', { createdAt: ago(5) });
    const ops = consolidateFacts([a, b], { startedAt: START });
    expect(supersedes(ops)).toEqual([]);
    expect(reports(ops)).toHaveLength(1);
    expect(reports(ops)[0]).toMatchObject({ op: 'report', kind: 'contradiction' });
    expect([...(reports(ops)[0] as { ids: string[] }).ids].sort()).toEqual([a.id, b.id].sort());
  });

  it('reports the same claim carrying a different value, rather than picking one', () => {
    const a = fact('Recall serves at most 12 facts to an agent.', { createdAt: ago(600) });
    const b = fact('Recall serves at most 20 facts to an agent.', { createdAt: ago(5) });
    expect(a.fingerprint).toBe(b.fingerprint); // short tokens drop out — it LOOKS like a duplicate
    const ops = consolidateFacts([a, b], { startedAt: START });
    expect(supersedes(ops)).toEqual([]);
    expect(reports(ops)).toHaveLength(1);
  });

  it('still merges a near-duplicate that agrees about its numbers', () => {
    const a = fact('The fact store is capped at 500 facts.', { createdAt: ago(600) });
    const b = fact('The fact store is capped at 500 facts in total.', { createdAt: ago(5) });
    expect(supersedes(consolidateFacts([a, b], { startedAt: START }))).toHaveLength(1);
  });
});

describe('consolidateFacts — safety properties', () => {
  it('is idempotent: applying the plan and re-running writes nothing', () => {
    const facts = [
      fact('Baton stores memory as markdown files with frontmatter, always in the main repo.', { createdAt: ago(900) }),
      fact('Baton stores memory as markdown files with frontmatter, always inside the main repository.', { createdAt: ago(300) }),
      fact('The daemon serves the dashboard on port 7077.', { createdAt: ago(600) }),
      fact('The daemon does not serve the dashboard on port 7077.', { createdAt: ago(5) }),
    ];
    const first = consolidateFacts(facts, { startedAt: START });
    expect(supersedes(first).length).toBe(1);
    const second = consolidateFacts(apply(facts, first), { startedAt: START });
    expect(supersedes(second)).toEqual([]);
    // The contradiction survives — nothing was written, so it is still open.
    expect(reports(second)).toHaveLength(1);
  });

  it('is deterministic: the same store yields the same plan, whatever the input order', () => {
    const facts = [
      fact('Skills are bundled under src/skills/bundled and copied at build time.', { createdAt: ago(900) }),
      fact('Skills are bundled under src/skills/bundled, copied during the build.', { createdAt: ago(300) }),
      fact('Skills are bundled under src/skills/bundled and copied by the build step.', { createdAt: ago(120) }),
    ];
    const a = consolidateFacts(facts, { startedAt: START });
    const b = consolidateFacts([...facts].reverse(), { startedAt: START });
    expect(a).toEqual(b);
  });

  it('never touches a fact edited after the pass started', () => {
    const older = fact('The event bus lives in src/events.ts and every live event goes through it.', { createdAt: ago(600) });
    const inFlight = fact('The event bus lives in src/events.ts, and every live event flows through it.', {
      createdAt: new Date(START + 60_000).toISOString(),
    });
    const ops = consolidateFacts([older, inFlight], { startedAt: START });
    expect(JSON.stringify(ops)).not.toContain(inFlight.id);
    expect(supersedes(ops)).toEqual([]);
  });

  it('completes a store at the 500-fact cap well inside its budget', () => {
    const facts: MemoryFact[] = [];
    for (let i = 0; i < 500; i++) {
      // Half the store is duplicated knowledge, so the merge path does real work.
      const text = i % 2 === 0
        ? `Subsystem ${Math.floor(i / 2)} keeps its state in src/module${Math.floor(i / 2)}.ts and is read at startup.`
        : `Subsystem ${Math.floor(i / 2)} keeps its state in src/module${Math.floor(i / 2)}.ts, read once at startup.`;
      facts.push(fact(text, { createdAt: ago(1000 - i) }));
    }
    consolidateFacts(facts, { startedAt: START }); // warm: measure the pass, not module init
    const t0 = performance.now();
    const ops = consolidateFacts(facts, { startedAt: START });
    const ms = performance.now() - t0;
    expect(supersedes(ops).length).toBe(250);
    /*
     * The design budget is 100 ms at the cap, and the measured warm figure on
     * an idle machine is 10-40 ms. The ASSERTION is an order of magnitude
     * looser on purpose: this suite is timing-sensitive and routinely runs
     * beside builds and other agents, where the same code has been observed
     * taking 700 ms purely waiting for CPU. A tight bound here would fail on
     * machine load rather than on a regression; what it must catch is the
     * accidental O(n²) that turns 40 ms into tens of seconds. The number to
     * judge the pass by is the one logged below, not the bound.
     */
    // eslint-disable-next-line no-console
    console.log(`consolidateFacts: 500 facts in ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(2000);
  });

  it('caps how many disagreements it hands a human, but never caps merge-blocking', () => {
    // A store where everything half-contradicts everything: thousands of
    // tickets is the same as no ticket, so reporting stops — while the pairs
    // that could actually MERGE are still all checked, so nothing is resolved
    // by machine on the way past.
    const facts: MemoryFact[] = [];
    for (let i = 0; i < 200; i++) {
      const text = i % 2 === 0
        ? 'The consolidation pass rewrites a fact when it merges knowledge.'
        : 'The consolidation pass does not rewrite a fact when it merges knowledge.';
      facts.push(fact(text, { createdAt: ago(900 - i) }));
    }
    const ops = consolidateFacts(facts, { startedAt: START });
    expect(reports(ops).length).toBeLessThanOrEqual(MAX_CONTRADICTION_REPORTS);
    expect(reports(ops).length).toBeGreaterThan(0);
    // Same text merges (100 of each phrasing collapse onto their newest); the
    // negated phrasing is never merged into the plain one.
    for (const o of supersedes(ops)) {
      const loser = facts.find((f) => f.id === o.id)!;
      const winner = facts.find((f) => f.id === o.supersededBy)!;
      expect(loser.fact).toBe(winner.fact);
    }
  });

  it('still merges duplicates written in the same second', () => {
    // An agent recording what it learned writes several facts at once, so a
    // timestamp tie is ordinary rather than exotic — and a tie the pass refuses
    // to break leaves the duplicate in the store forever.
    const at = ago(30);
    const a = fact('Anchors are content hashes checked again on every read.', { id: 'mem-aaa', createdAt: at });
    const b = fact('Anchors are content hashes, checked again on every single read.', { id: 'mem-bbb', createdAt: at });
    const ops = supersedes(consolidateFacts([a, b], { startedAt: START }));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ id: 'mem-bbb', supersededBy: 'mem-aaa' });
    // …and it breaks the tie the same way whichever order they arrive in.
    expect(consolidateFacts([b, a], { startedAt: START })).toEqual(consolidateFacts([a, b], { startedAt: START }));
  });

  it('does not retire two facts that disagree with each other into a third', () => {
    // A and B contradict; both look like duplicates of C. Merging both into C
    // silently settles their disagreement, because C states one of the values.
    const c = fact('The recall budget serves 12 facts and 8 previews per call.', { createdAt: ago(4) });
    const a = fact('The recall budget serves 12 facts and 8 previews for each call.', { createdAt: ago(400) });
    const b = fact('The recall budget serves 30 facts and 8 previews for each call.', { createdAt: ago(300) });
    const ops = consolidateFacts([a, b, c], { startedAt: START });
    const retired = supersedes(ops).map((o) => o.id);
    expect(retired).not.toContain(b.id);
    expect(reports(ops).length).toBeGreaterThan(0);
  });

  it('judges duplicates by exactly the measure saveMemory uses', () => {
    // The pass prepares each fact's word set once instead of re-deriving it per
    // comparison. That is only safe while it means the same thing as
    // `factSimilarity` — so prove it rather than assume it.
    const pairs: Array<[string, string]> = [
      ['Git calls go through src/util/exec.ts.', 'Git calls go through src/util/exec.ts.'],
      ['The daemon is raw node:http.', 'The dashboard is built with Vite.'],
      ['Memory lives in the main repo, never a worktree.', 'Memory lives in the main repository and never in a worktree.'],
      ['Recall serves at most 12 facts.', 'Recall serves at most 20 facts.'],
      ['a', ''],
    ];
    for (const [a, b] of pairs) {
      expect(similarity(sigWords(a), sigWords(b))).toBeCloseTo(factSimilarity(a, b), 12);
    }
  });

  it('handles an empty store and a single fact without opinions', () => {
    expect(consolidateFacts([], { startedAt: START })).toEqual([]);
    expect(consolidateFacts([fact('One lonely fact about nothing much.')], { startedAt: START })).toEqual([]);
  });
});
