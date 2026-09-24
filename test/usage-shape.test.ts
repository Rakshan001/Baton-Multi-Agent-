// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregate,
  estimateCostUsd,
  parseSessionUsage,
  readableAgents,
  slugForCwd,
  type SessionUsage,
} from '../src/usage.js';
import { taskCell } from '../src/commands/usage.js';
import type { Task } from '../src/store.js';

/**
 * The usage shape has to hold more than one agent, and it has to keep
 * "not measured" apart from "measured, spent nothing". A blank means nobody
 * counted; a zero means somebody counted and the answer was zero. Conflating
 * the two is how a spend table starts lying, so every assertion here is about
 * null vs 0.
 */

function session(over: Partial<SessionUsage> = {}): SessionUsage {
  return {
    sessionId: 's1',
    slug: null,
    agent: 'claude',
    model: 'claude-sonnet-4',
    turns: 2,
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 5,
    cacheWriteTokens: 1,
    totalTokens: 116,
    estCostUsd: 0.5,
    attribution: 'measured',
    firstAt: '2026-09-01T00:00:00Z',
    lastAt: '2026-09-01T01:00:00Z',
    ...over,
  };
}

const unmeasured = (over: Partial<SessionUsage> = {}): SessionUsage =>
  session({
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
    estCostUsd: null,
    ...over,
  });

describe('estimateCostUsd', () => {
  it('prices a known Claude model exactly as before', () => {
    expect(
      estimateCostUsd('claude-sonnet-4-5', {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 2_000_000,
        cacheWriteTokens: 40_000,
      }),
    ).toBe(5.25);
  });

  it('returns null, not 0, when the model is unknown', () => {
    expect(estimateCostUsd('gpt-5.5', { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
    expect(estimateCostUsd(null, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
  });

  it('returns null when a priced model has no token counts at all', () => {
    expect(
      estimateCostUsd('claude-opus-4', { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }),
    ).toBeNull();
  });

  it('returns 0 for a priced model that measurably spent nothing', () => {
    // `claude-haiku-4` was used here, but it is not in the price table: under
    // the zero-cost rule it is an unpriced model, and those stay null.
    expect(estimateCostUsd('claude-haiku-4-5', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(0);
  });
});

describe('parseSessionUsage (claude)', () => {
  it('keeps the Claude numbers and reports the agent id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'baton-usage-'));
    const file = join(dir, 'abc123.jsonl');
    await writeFile(
      file,
      [
        'not json at all',
        JSON.stringify({ type: 'user', timestamp: '2026-09-01T00:00:00Z' }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-09-01T00:00:01Z',
          message: {
            model: 'claude-sonnet-4-5',
            usage: {
              input_tokens: 1_000_000,
              output_tokens: 100_000,
              cache_read_input_tokens: 2_000_000,
              cache_creation_input_tokens: 40_000,
            },
          },
        }),
      ].join('\n') + '\n',
    );
    const u = await parseSessionUsage(file);
    expect(u.agent).toBe('claude');
    expect(u.sessionId).toBe('abc123');
    expect(u.turns).toBe(1);
    expect(u.inputTokens).toBe(1_000_000);
    expect(u.outputTokens).toBe(100_000);
    expect(u.cacheReadTokens).toBe(2_000_000);
    expect(u.cacheWriteTokens).toBe(40_000);
    expect(u.totalTokens).toBe(3_140_000);
    expect(u.estCostUsd).toBe(5.25);
    expect(u.model).toBe('claude-sonnet-4-5');
  });
});

describe('aggregate', () => {
  it('groups totals by agent and by model', () => {
    const { totals, byAgent, byModel } = aggregate([
      session({ sessionId: 'a', agent: 'claude', inputTokens: 100, estCostUsd: 1 }),
      session({ sessionId: 'b', agent: 'codex', model: 'gpt-5.5', inputTokens: 200, estCostUsd: null }),
    ]);
    expect(totals.sessions).toBe(2);
    expect(totals.inputTokens).toBe(300);
    expect(Object.keys(byAgent).sort()).toEqual(['claude', 'codex']);
    expect(byAgent.codex.inputTokens).toBe(200);
    expect(byModel['gpt-5.5'].sessions).toBe(1);
  });

  it('gives an agent with no sessions no row at all, rather than a zero row', () => {
    const { byAgent } = aggregate([session({ agent: 'claude' })]);
    expect(byAgent.codex).toBeUndefined();
    expect('antigravity' in byAgent).toBe(false);
  });

  it('leaves a total absent when nothing measured it', () => {
    const { totals, byAgent } = aggregate([unmeasured({ agent: 'antigravity', turns: 7 })]);
    expect(totals.sessions).toBe(1);
    expect(totals.turns).toBe(7);
    expect(totals.inputTokens).toBeNull();
    expect(totals.outputTokens).toBeNull();
    expect(totals.estCostUsd).toBeNull();
    expect(byAgent.antigravity.inputTokens).toBeNull();
  });

  it('sums only the sessions that reported a field, and keeps a measured zero', () => {
    const { totals } = aggregate([
      session({ sessionId: 'a', inputTokens: 100, cacheWriteTokens: null, estCostUsd: 1.5 }),
      session({ sessionId: 'b', inputTokens: 0, cacheWriteTokens: null, estCostUsd: null }),
    ]);
    expect(totals.inputTokens).toBe(100);
    expect(totals.cacheWriteTokens).toBeNull();
    expect(totals.estCostUsd).toBe(1.5);
  });

  it('does not turn an unmeasured agent into a zero beside a measured one', () => {
    const { byAgent } = aggregate([
      session({ agent: 'claude', inputTokens: 100, estCostUsd: 2 }),
      unmeasured({ sessionId: 'g1', agent: 'antigravity' }),
    ]);
    expect(byAgent.claude.estCostUsd).toBe(2);
    expect(byAgent.antigravity.estCostUsd).toBeNull();
    expect(byAgent.antigravity.inputTokens).toBeNull();
  });
});


/**
 * `byTask` is served, not recomputed in the browser.
 *
 * The per-task rollup used to be re-implemented in web/src/features/Activity.tsx,
 * which meant the ONE rule this feature has — a missing measurement is never a
 * `0` — was enforced by two copies of the same loop. These tests pin the
 * daemon's copy, which is now the only one.
 */
describe('aggregate byTask', () => {
  it('rolls sessions up per task, with the repo itself as a slug of null', () => {
    const { byTask } = aggregate([
      session({ sessionId: 'a', slug: 'fix-a', inputTokens: 100, totalTokens: 100, estCostUsd: 1 }),
      session({ sessionId: 'b', slug: 'fix-a', inputTokens: 50, totalTokens: 50, estCostUsd: 0.25 }),
      session({ sessionId: 'c', slug: null, inputTokens: 10, totalTokens: 10, estCostUsd: 0.5 }),
    ]);
    const fixA = byTask.find((t) => t.slug === 'fix-a');
    expect(fixA?.totals.sessions).toBe(2);
    expect(fixA?.totals.inputTokens).toBe(150);
    expect(fixA?.totals.estCostUsd).toBe(1.25);
    expect(byTask.find((t) => t.slug === null)?.totals.totalTokens).toBe(10);
  });

  it('leaves a task whose only session was never measured NULL, not 0', () => {
    const { byTask } = aggregate([
      session({ sessionId: 'a', slug: 'fix-a', inputTokens: 100, totalTokens: 100, estCostUsd: 2 }),
      unmeasured({ sessionId: 'g1', slug: 'fix-b', agent: 'antigravity', turns: 9 }),
    ]);
    const fixB = byTask.find((t) => t.slug === 'fix-b');
    expect(fixB, 'an unmeasured task still gets a row — it just has no numbers').toBeTruthy();
    expect(fixB?.totals.sessions).toBe(1);
    expect(fixB?.totals.turns).toBe(9);
    expect(fixB?.totals.totalTokens).toBeNull();
    expect(fixB?.totals.inputTokens).toBeNull();
    expect(fixB?.totals.estCostUsd).toBeNull();
  });

  it('keeps a measured zero apart from an absent measurement in the same row', () => {
    const { byTask } = aggregate([
      session({ sessionId: 'a', slug: 'fix-a', inputTokens: 0, cacheWriteTokens: null, totalTokens: 0, estCostUsd: 0 }),
      session({ sessionId: 'b', slug: 'fix-a', inputTokens: 0, cacheWriteTokens: null, totalTokens: 0, estCostUsd: null }),
    ]);
    const fixA = byTask.find((t) => t.slug === 'fix-a');
    expect(fixA?.totals.inputTokens).toBe(0);
    expect(fixA?.totals.cacheWriteTokens).toBeNull();
    expect(fixA?.totals.estCostUsd).toBe(0);
  });

  it('lists the agents that worked the task, and orders rows by measured spend', () => {
    const { byTask } = aggregate([
      session({ sessionId: 'a', slug: 'small', totalTokens: 10 }),
      session({ sessionId: 'b', slug: 'big', totalTokens: 900 }),
      session({ sessionId: 'c', slug: 'big', agent: 'codex', model: 'gpt-5.5', totalTokens: 100 }),
      unmeasured({ sessionId: 'd', slug: 'unknown-spend', agent: 'antigravity' }),
    ]);
    expect(byTask.map((t) => t.slug)).toEqual(['big', 'small', 'unknown-spend']);
    expect(byTask[0].agents).toEqual(['claude', 'codex']);
  });

  it('flags a row whose attribution was inferred rather than logged', () => {
    const { byTask } = aggregate([
      session({ sessionId: 'a', slug: 'fix-a' }),
      unmeasured({ sessionId: 'g1', slug: 'fix-b', agent: 'antigravity', attribution: 'inferred' }),
    ]);
    expect(byTask.find((t) => t.slug === 'fix-a')?.inferred).toBe(false);
    expect(byTask.find((t) => t.slug === 'fix-b')?.inferred).toBe(true);
  });

  it('flags a mixed row as inferred — one guessed session makes the row a guess', () => {
    const { byTask } = aggregate([
      session({ sessionId: 'a', slug: 'fix-a' }),
      session({ sessionId: 'g1', slug: 'fix-a', agent: 'antigravity', attribution: 'inferred' }),
    ]);
    expect(byTask.find((t) => t.slug === 'fix-a')?.inferred).toBe(true);
  });
});

/**
 * The roster of agents Baton can read is the daemon's knowledge, and it is
 * served rather than mirrored: the dashboard used to hardcode the same three
 * ids plus the path each is read from, so a fourth parser meant editing the
 * browser too.
 */
describe('readableAgents', () => {
  it('names every agent usageForRepo parses, and where each is read from', () => {
    const roster = readableAgents();
    expect(roster.map((r) => r.agent).sort()).toEqual(['antigravity', 'claude', 'codex']);
    for (const r of roster) expect(r.readFrom, `${r.agent} must say where it reads from`).toMatch(/^~\//);
  });

  it('covers every parser usageForRepo calls', async () => {
    const src = await readFile(new URL('../src/usage.ts', import.meta.url), 'utf-8');
    const body = src.slice(src.indexOf('export async function usageForRepo'));
    const called = [...body.matchAll(/(\w+)Sessions\(root, tasks\)/g)].map((m) => m[1]);
    expect(called.length).toBeGreaterThan(0);
    for (const agent of called) {
      expect(readableAgents().some((r) => r.agent === agent), `${agent} parses sessions but is not in the roster`).toBe(true);
    }
  });
});

describe('slugForCwd', () => {
  const task = (slug: string, worktreePath: string) => ({ slug, worktreePath }) as Task;
  const tasks = [task('fix-a', '/repo/.baton/worktrees/fix-a'), task('fix-b', '/elsewhere/fix-b')];

  it('maps a worktree cwd (or a dir inside it) to its task slug', () => {
    expect(slugForCwd('/repo/.baton/worktrees/fix-a', '/repo', tasks)).toBe('fix-a');
    expect(slugForCwd('/repo/.baton/worktrees/fix-a/src', '/repo', tasks)).toBe('fix-a');
    expect(slugForCwd('/elsewhere/fix-b', '/repo', tasks)).toBe('fix-b');
  });

  it('maps the repo root, or a dir inside it, to the repo itself', () => {
    expect(slugForCwd('/repo', '/repo', tasks)).toBeNull();
    expect(slugForCwd('/repo/src/util', '/repo', tasks)).toBeNull();
  });

  it('refuses a cwd that belongs to another project', () => {
    expect(slugForCwd('/somewhere/else', '/repo', tasks)).toBeUndefined();
    expect(slugForCwd('/repo-other', '/repo', tasks)).toBeUndefined();
  });
});

/**
 * `baton usage` prints one row per session, and the TASK column on that row is
 * an attribution claim. Antigravity's is deduced from the paths the session
 * touched, so it is marked — a deduction printed in the same column as a
 * measured one, unmarked, reads as if somebody had checked.
 */
describe('taskCell', () => {
  it('prints a measured task plainly', () => {
    expect(taskCell(session({ slug: 'fix-a' }))).toBe('fix-a');
    expect(taskCell(session({ slug: null }))).toBe('(repo root)');
  });

  it('keeps the marker when a long slug has to be truncated to fit the column', () => {
    // The column is fixed width. Truncating the CELL would cut the marker off
    // the longest slugs — the ones most likely to be a real worktree — and a
    // dropped marker is an unmarked deduction.
    const cell = taskCell(session({ slug: 'a-very-long-task-slug-that-overflows-the-column', attribution: 'inferred' }));
    expect(cell.endsWith('≈inferred')).toBe(true);
    expect(cell.length).toBeLessThanOrEqual(26);
  });

  it('marks an inferred placement, for the task AND for the repo row', () => {
    expect(taskCell(session({ slug: 'fix-a', attribution: 'inferred' }))).toBe('fix-a ≈inferred');
    expect(taskCell(session({ slug: null, attribution: 'inferred' }))).toBe('(repo root) ≈inferred');
  });
});

describe('the Claude parser holds "not reported" as null, not zero', () => {
  /**
   * Every layer above this was converted to preserve null — `emptyTotals`,
   * `addTo`, `aggregate`, the dashboard — and the parser at the bottom still
   * started every counter at 0. That made the `?? 0` guards above it dead code
   * and turned "this transcript never mentioned cache tokens" into "this
   * session used 0 cache tokens", which `coverageOf` then reports as FULL
   * coverage with no partial tag.
   *
   * The rule the whole feature rests on is "never render a missing measurement
   * as 0", and it was false at the source.
   */
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'baton-claude-usage-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const transcript = async (usage: Record<string, number>) => {
    const file = join(dir, 'session.jsonl');
    await writeFile(file, `${JSON.stringify({
      type: 'assistant', timestamp: '2026-09-06T00:00:00Z',
      message: { model: 'claude-sonnet-5', usage },
    })}\n`, 'utf-8');
    return file;
  };

  it('leaves a counter the transcript never reported as null', async () => {
    const got = await parseSessionUsage(await transcript({ input_tokens: 100, output_tokens: 20 }));
    expect(got.inputTokens).toBe(100);
    expect(got.outputTokens).toBe(20);
    expect(got.cacheReadTokens).toBeNull();
    expect(got.cacheWriteTokens).toBeNull();
  });

  it('keeps a reported zero as zero — measured 0 is not missing', async () => {
    const got = await parseSessionUsage(await transcript({
      input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0,
    }));
    expect(got.cacheReadTokens).toBe(0);
    expect(got.cacheWriteTokens).toBeNull();
  });

  it('reports nothing at all for a transcript with no usage lines', async () => {
    const file = join(dir, 'empty.jsonl');
    await writeFile(file, `${JSON.stringify({ type: 'user', message: {} })}\n`, 'utf-8');
    const got = await parseSessionUsage(file);
    expect(got.totalTokens).toBeNull();
    expect(got.inputTokens).toBeNull();
  });
});
