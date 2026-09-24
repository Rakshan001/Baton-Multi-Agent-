// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Cost is priced per API message at that message's own model, from an
 * exact-id table of Anthropic's published list prices. A model the table does
 * not list has no cost (never a borrowed one), and a message that spent zero
 * tokens costs $0 whatever its model. Synthetic fixtures only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregate, estimateCostUsd, parseSessionUsage, type SessionUsage } from '../src/usage.js';

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'baton-usage-pricing-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

let n = 0;
async function parse(lines: unknown[]) {
  const file = join(dir, `p${n++}.jsonl`);
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
  return parseSessionUsage(file);
}
const msg = (id: string, model: string, usage: Record<string, unknown>) => ({
  type: 'assistant', timestamp: '2026-09-01T00:00:00Z', message: { id, model, usage },
});

const M = 1_000_000;
/** One million of each count, cache writes at the 5-minute tier. */
const million = { inputTokens: M, outputTokens: M, cacheReadTokens: M, cacheWriteTokens: M };

describe('the price table (platform.claude.com/docs/en/about-claude/pricing, 2026-09-24)', () => {
  // in + out + cache read + 5-minute cache write, per million.
  const rows: Array<[string[], number]> = [
    [['claude-fable-5-1', 'claude-mythos-5-1'], 10 + 50 + 0.25 + 12.5],
    [['claude-fable-5', 'claude-mythos-5'], 10 + 50 + 1 + 12.5],
    [['claude-opus-5-5'], 4 + 20 + 0.2 + 5],
    [['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5'], 5 + 25 + 0.5 + 6.25],
    [['claude-opus-4-1', 'claude-opus-4', 'claude-opus-4-0'], 15 + 75 + 1.5 + 18.75],
    [['claude-sonnet-5'], 2 + 10 + 0.2 + 2.5],
    [['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4', 'claude-sonnet-4-0'], 3 + 15 + 0.3 + 3.75],
    [['claude-haiku-4-5'], 1 + 5 + 0.1 + 1.25],
    [['claude-3-5-haiku', 'claude-haiku-3-5'], 0.8 + 4 + 0.08 + 1],
  ];
  for (const [ids, usd] of rows) {
    for (const id of ids) {
      it(`prices ${id}`, () => expect(estimateCostUsd(id, million)).toBeCloseTo(usd, 2));
    }
  }

  it('strips a date suffix and a [1m] suffix, then looks the id up exactly', () => {
    expect(estimateCostUsd('claude-opus-4-1-20250805', million)).toBeCloseTo(110.25, 2);
    expect(estimateCostUsd('claude-opus-4-8[1m]', million)).toBeCloseTo(36.75, 2);
    expect(estimateCostUsd('claude-haiku-4-5-20251001', million)).toBeCloseTo(7.35, 2);
  });

  it('never lends an older row to a model it does not list', () => {
    expect(estimateCostUsd('claude-opus-4-9', million)).toBeNull();
    expect(estimateCostUsd('claude-fable-5-2', million)).toBeNull();
    expect(estimateCostUsd('opus', million)).toBeNull();
  });
});

describe('cost is summed per message, at each message\'s model', () => {
  it('prices a mixed-model session per message, not at its last model', async () => {
    const u = await parse([
      msg('a', 'claude-opus-5', { input_tokens: M }),
      msg('b', 'claude-sonnet-5', { input_tokens: M }),
    ]);
    expect(u.estCostUsd).toBe(7); // $5 + $2, not 2 × either
  });

  it('ignores a <synthetic> zero-usage last line for model and cost', async () => {
    const u = await parse([
      msg('a', 'claude-opus-5', { input_tokens: M }),
      msg('b', '<synthetic>', { input_tokens: 0, output_tokens: 0 }),
    ]);
    expect(u.model).toBe('claude-opus-5');
    expect(u.estCostUsd).toBe(5);
  });

  it('gives the session no cost when a message with tokens ran an unlisted model', async () => {
    const u = await parse([
      msg('a', 'claude-opus-5', { input_tokens: M }),
      msg('b', 'claude-opus-4-9', { input_tokens: 10 }),
    ]);
    expect(u.estCostUsd).toBeNull();
  });

  it('rounds once at the end, not per message', async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => msg(`m${i}`, 'claude-opus-5', { input_tokens: 800 })); // $0.004 each
    const u = await parse(lines);
    expect(u.estCostUsd).toBe(4);
  });

  it('prices an all-zero file at $0, not null', async () => {
    const u = await parse([msg('a', '<synthetic>', { input_tokens: 0, output_tokens: 0 })]);
    expect(u.totalTokens).toBe(0);
    expect(u.estCostUsd).toBe(0);
  });

  it('prices 1-hour cache writes at the 1-hour rate and the rest at 5 minutes', async () => {
    const u = await parse([
      msg('a', 'claude-opus-5', {
        cache_creation_input_tokens: M,
        cache_creation: { ephemeral_1h_input_tokens: 0.6 * M, ephemeral_5m_input_tokens: 0.4 * M },
      }),
    ]);
    expect(u.estCostUsd).toBe(8.5); // 0.6 × $10 + 0.4 × $6.25
  });

  it('prices cache writes at the 5-minute rate when the split is absent', async () => {
    const u = await parse([msg('a', 'claude-opus-5', { cache_creation_input_tokens: M })]);
    expect(u.estCostUsd).toBe(6.25);
  });

  it('keeps estimateCostUsd\'s existing answer', () => {
    expect(estimateCostUsd('claude-sonnet-4-5', {
      inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 40_000,
    })).toBe(5.25);
  });
});

describe('aggregate: unpriced sessions are counted, and consumed stays null-preserving', () => {
  const s = (over: Partial<SessionUsage>): SessionUsage => ({
    sessionId: 's', slug: null, agent: 'claude', attribution: 'measured', model: 'claude-opus-5', turns: 1,
    inputTokens: 10, outputTokens: 20, cacheReadTokens: 1000, cacheWriteTokens: 5, totalTokens: 1035,
    consumedTokens: 35, estCostUsd: 1, firstAt: null, lastAt: null, ...over,
  });

  it('counts sessions that spent tokens but have no price', () => {
    const { totals, byAgent } = aggregate([
      s({}),
      s({ agent: 'codex', model: 'gpt-5.5', estCostUsd: null }),
      s({ agent: 'antigravity', model: null, inputTokens: null, outputTokens: null, cacheReadTokens: null,
        cacheWriteTokens: null, totalTokens: null, consumedTokens: null, estCostUsd: null }),
    ]);
    expect(totals.unpricedSessions).toBe(1);
    expect(byAgent.claude.unpricedSessions).toBe(0);
    expect(byAgent.codex.unpricedSessions).toBe(1);
    expect(byAgent.antigravity.unpricedSessions).toBe(0); // nothing reported is not "tokens with no price"
  });

  it('sums consumedTokens and never turns a null into 0', () => {
    const { totals, byAgent } = aggregate([
      s({}),
      s({ agent: 'antigravity', consumedTokens: null }),
    ]);
    expect(totals.consumedTokens).toBe(35);
    expect(byAgent.antigravity.consumedTokens).toBeNull();
  });
});

describe('baton usage: the TOTAL line', () => {
  const t = {
    sessions: 3, turns: 9, inputTokens: 10, outputTokens: 20, cacheReadTokens: 1000, cacheWriteTokens: 5,
    totalTokens: 1035, consumedTokens: 35, estCostUsd: 1.5, unpricedSessions: 1,
  };

  it('leads with consumed tokens, keeps cache reads separate, and names what the cost leaves out', async () => {
    const { totalLine } = await import('../src/commands/usage.js');
    const line = totalLine(t);
    expect(line).toContain('used 35');
    expect(line).toContain('cache-read 1.0k');
    expect(line).toContain('≈ $1.50 at API list prices (2026-09-24)');
    expect(line).toContain('(excl. 1 unpriced)');
    expect(totalLine({ ...t, unpricedSessions: 0 })).not.toContain('unpriced');
  });
});
