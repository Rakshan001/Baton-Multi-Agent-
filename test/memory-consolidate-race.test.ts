// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { consolidateFacts } from '../src/memory/consolidate.js';
import {
  fingerprintOf, listMemories, localMemoryDir, readJournal, renderFactFile, saveMemory,
  slugifyId, supersedeMemory, type MemoryFact,
} from '../src/memory.js';

/**
 * TWO consolidation passes over ONE store.
 *
 * Nothing serialises the pass across processes: `baton serve` in the main
 * checkout plus another in a worktree, or a daemon that survived a crash, and
 * both read the store, both plan, both write. The pass reads all facts, plans,
 * and then applies the plan as a series of `supersedeMemory` calls, so a plan
 * can be minutes older than the write it produces.
 *
 * Two failures are imaginable there, and only one of them is real:
 *
 *   - **Opposite directions** — daemon A retires x in favour of y while B
 *     retires y in favour of x, leaving neither. NOT reachable, and the last
 *     test here is what says so: `supersedable` compares only `createdAt` and,
 *     on a tie, the id — both immutable, both properties of the PAIR rather
 *     than the snapshot it was seen in. Every plan therefore points the same
 *     way, whatever the two daemons happened to see, and the newest fact of a
 *     group is never a loser in any plan.
 *   - **A reused id** — reachable, and it loses knowledge. The plan names IDS,
 *     and an id is a slug that `saveMemory` only suffixes while a LIVE fact
 *     holds it. Retire a fact and its name is free for the next fact opening
 *     with the same six words, which is exactly what an agent writes when it
 *     records an UPDATE to that knowledge. A second daemon's late write then
 *     archives the new fact under the old plan's decision.
 *
 * Hence the check inside `supersedeMemory`: the planner's own rule — never
 * retire knowledge newer than what replaces it — re-applied against the store
 * as it is at the instant of the write. A lock would not have done this job:
 * the repo's `withLock` is in-process by design, and the second daemon is a
 * second process holding a plan made before the save it is about to destroy.
 */

let root: string;
const g = (args: string[]) => execa('git', args, { cwd: root });

/** Seed a fact FILE directly — how a duplicate pair actually arrives (a git
 *  pull, a second clone, or a store older than the write-time dedupe gate).
 *  `saveMemory` de-dupes on the way in and cannot produce one. */
async function seed(id: string, text: string, createdAt: string): Promise<void> {
  const dir = localMemoryDir(root);
  await mkdir(dir, { recursive: true });
  const f: MemoryFact = {
    id, type: 'convention', fact: text, agent: 'claude', author: 'tester', task: null,
    createdAt, anchors: { commit: null, files: [] }, supersedes: null,
    fingerprint: fingerprintOf(text),
  };
  await writeFile(join(dir, `${id}.md`), renderFactFile(f), 'utf-8');
}

/** One pass, exactly as the daemon runs it: snapshot, plan, then apply. Split
 *  so a test can put something between the two halves — which is the whole
 *  subject here. */
async function plan(startedAt = Date.now()) {
  return consolidateFacts(await listMemories(root), { startedAt });
}
async function apply(ops: Awaited<ReturnType<typeof plan>>): Promise<string[]> {
  const retired: string[] = [];
  for (const op of ops) {
    if (op.op !== 'supersede') continue;
    if (await supersedeMemory(root, op.id, op.supersededBy, op.reason)) retired.push(op.id);
  }
  return retired;
}

const OLD = 'Recall reads the memory budget from src/memory.ts and serves a capped list of facts.';
const REPHRASED = `${OLD} Agents see the capped list.`;
/** New knowledge, recorded later, opening with the same six words — so it
 *  slugs to the same id as OLD. */
const UPDATE = 'Recall reads the memory budget from the retention policy file instead, which changes how every agent is served knowledge today.';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'baton-consolidate-race-'));
  await g(['init', '-q']);
  await g(['config', 'user.email', 't@t.t']);
  await g(['config', 'user.name', 'T']);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'memory.ts'), 'export const RECALL_LIMIT = 12;\n');
  await writeFile(join(root, 'README.md'), '# t\n');
  await g(['add', '-A']);
  await g(['commit', '-qm', 'init']);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('two consolidation passes, no interlock between them', () => {
  it('a late write cannot retire the NEW fact that re-took the retired id', async () => {
    const slug = slugifyId(OLD);
    // The premise: an update to this knowledge slugs to the same id.
    expect(slugifyId(UPDATE)).toBe(slug);

    await seed(slug, OLD, '2026-08-01T00:00:00.000Z');
    await seed('mem-newer-phrasing', REPHRASED, '2026-08-02T00:00:00.000Z');

    // Both daemons read the same store and reach the same conclusion.
    const daemonA = await plan();
    const daemonB = await plan();
    expect(daemonA.filter((o) => o.op === 'supersede')).toEqual(daemonB.filter((o) => o.op === 'supersede'));

    // A applies first and retires the older duplicate.
    expect(await apply(daemonA)).toEqual([slug]);

    // An agent records the UPDATE. The slug A just freed is taken again — this
    // is a different fact, written after both plans were made.
    const fresh = await saveMemory(root, { fact: UPDATE, type: 'convention', files: ['src/memory.ts'] });
    expect(fresh.id).toBe(slug);

    // B's write arrives late, carrying a decision about a fact that no longer
    // exists. It must not land on the fact now wearing that name.
    expect(await apply(daemonB)).toEqual([]);

    const live = await listMemories(root);
    expect(live.map((f) => f.fact)).toContain(UPDATE);
    expect(live.map((f) => f.id).sort()).toEqual([slug, 'mem-newer-phrasing'].sort());
    // And exactly one retire happened, not two under one name.
    expect((await readJournal(root)).filter((e) => e.op === 'supersede')).toHaveLength(1);
  });

  it('still retires the duplicate exactly once when both passes are honest', async () => {
    await seed('mem-older-dup', OLD, '2026-08-01T00:00:00.000Z');
    await seed('mem-newer-dup', REPHRASED, '2026-08-02T00:00:00.000Z');

    const daemonA = await plan();
    const daemonB = await plan();
    const [a, b] = [await apply(daemonA), await apply(daemonB)];

    // One winner, one no-op — the benign outcome the pass already documents.
    expect([a, b].sort()).toEqual([[], ['mem-older-dup']]);
    expect((await listMemories(root)).map((f) => f.id)).toEqual(['mem-newer-dup']);
  });

  it('leaves every retired fact with a live successor when the snapshots differ', async () => {
    await seed('mem-x', OLD, '2026-08-01T00:00:00.000Z');
    await seed('mem-y', REPHRASED, '2026-08-02T00:00:00.000Z');

    // A plans over {x, y}. Then a third fact lands (a pull, another agent), and
    // B plans over {x, y, z} — genuinely different plans over one store.
    const daemonA = await plan();
    await seed('mem-z', `${REPHRASED} The cap is configurable.`, '2026-08-03T00:00:00.000Z');
    const daemonB = await plan();

    await apply(daemonA);
    await apply(daemonB);

    const live = (await listMemories(root)).map((f) => f.id);
    const journal = await readJournal(root);
    // Nothing vanished: every retired fact leads, by its recorded successor, to
    // a fact still being served.
    for (const entry of journal) {
      let cursor = entry.supersededBy;
      const walked = new Set<string>();
      while (cursor && !live.includes(cursor) && !walked.has(cursor)) {
        walked.add(cursor);
        cursor = journal.find((e) => e.id === cursor)?.supersededBy ?? null;
      }
      expect(cursor && live.includes(cursor)).toBe(true);
    }
    expect(live).toContain('mem-z');
  });
});

describe('consolidateFacts (the direction a supersede can point)', () => {
  it('never plans x→y from one snapshot and y→x from another', () => {
    const text = 'Git calls go through src/util/exec.ts, never a raw shell, because it is hardened.';
    const mk = (id: string, createdAt: string, opts: { local?: boolean; text?: string } = {}): MemoryFact => {
      const fact = opts.text ?? text;
      return {
        id, type: 'convention', fact, agent: null, author: 't', task: null, createdAt,
        anchors: { commit: null, files: [] }, supersedes: null, fingerprint: fingerprintOf(fact),
        ...(opts.local ? { localOnly: true, area: 'local' as const } : { area: 'tracked' as const }),
      };
    };
    // Every axis the winner choice looks at: order, exact TIES, and both areas
    // (a local fact may not retire a tracked one, and must not win one either).
    const universe = [
      mk('mem-a', '2026-08-01T00:00:00.000Z'),
      mk('mem-b', '2026-08-01T00:00:00.000Z', { local: true }),
      mk('mem-c', '2026-08-02T00:00:00.000Z', { local: true }),
      mk('mem-d', '2026-08-02T00:00:00.000Z'),
      mk('mem-e', '2026-08-03T00:00:00.000Z'),
      mk('mem-f', '2026-08-03T00:00:00.000Z', { local: true }),
      mk('mem-g', '2026-08-04T00:00:00.000Z', { text: `${text} It is shell-free.` }),
    ];
    const startedAt = Date.parse('2026-09-01T00:00:00.000Z');

    // Every snapshot two daemons could possibly hold, including ones that
    // disagree about which facts exist.
    const edges = new Map<string, Set<string>>();
    for (let mask = 1; mask < 1 << universe.length; mask++) {
      const subset = universe.filter((_, i) => mask & (1 << i));
      for (const op of consolidateFacts(subset, { startedAt })) {
        if (op.op !== 'supersede') continue;
        (edges.get(op.id) ?? edges.set(op.id, new Set()).get(op.id)!).add(op.supersededBy);
      }
    }

    const opposed: string[] = [];
    for (const [loser, winners] of edges) {
      for (const w of winners) if (edges.get(w)?.has(loser)) opposed.push(`${loser} <-> ${w}`);
    }
    expect(opposed).toEqual([]);
    // The newest fact of the group is a loser in no plan, so no interleaving of
    // plans can empty a group — the survivor is always somebody.
    expect(edges.has('mem-g')).toBe(false);
  });
});
