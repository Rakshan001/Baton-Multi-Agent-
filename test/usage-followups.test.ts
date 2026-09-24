// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Phase 9a review follow-ups. Synthetic fixtures only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimateCostUsd, parseSessionUsage, PRICES_AS_OF, usageForRepo } from '../src/usage.js';
import { parseCodexRollout } from '../src/usage/codex.js';
import { parseAntigravityTranscript } from '../src/usage/antigravity.js';
import { parseSession, readLines } from '../src/handoff/claude-session.js';
import { fmt } from '../src/commands/usage.js';

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'baton-usage-followups-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

let n = 0;
async function file(text: string, name = `f${n++}.jsonl`): Promise<string> {
  const f = join(dir, name);
  await writeFile(f, text, 'utf-8');
  return f;
}

/** A raw U+2028 / U+2029 inside a JSON string — valid JSON, one line. */
const SEP = 'a b c';

describe('line splitting: only \\n ends a line', () => {
  it('readLines keeps U+2028/U+2029 inside a line, strips a trailing \\r, keeps a final unterminated line', async () => {
    const f = await file(`one${SEP}\r\ntwo\nthree`);
    const got: string[] = [];
    for await (const l of readLines(f)) got.push(l);
    expect(got).toEqual([`one${SEP}`, 'two', 'three']);
  });

  it('claude: a usage line with U+2028 in a string is counted', async () => {
    const f = await file(`{"type":"assistant","timestamp":"2026-09-01T00:00:00Z","message":{"id":"m1","model":"claude-sonnet-5","content":[{"type":"text","text":"${SEP}"}],"usage":{"input_tokens":7,"output_tokens":3}}}\n`);
    const u = await parseSessionUsage(f);
    expect(u.inputTokens).toBe(7);
    expect(u.outputTokens).toBe(3);
  });

  it('codex: a token_count line with U+2028 in a string is counted', async () => {
    const f = await file(`{"type":"event_msg","payload":{"type":"token_count","note":"${SEP}","info":{"last_token_usage":{"input_tokens":5,"output_tokens":2}}}}\n`);
    const u = await parseCodexRollout(f);
    expect(u.turns).toBe(1);
    expect(u.inputTokens).toBe(5);
  });

  it('antigravity: a step with U+2028 in a string is counted', async () => {
    const d = join(dir, 'brain', 'sess', '.system_generated', 'logs');
    await mkdir(d, { recursive: true });
    const f = join(d, 'transcript.jsonl');
    await writeFile(f, `{"source":"MODEL","type":"PLANNER_RESPONSE","created_at":"2026-09-01T00:00:00Z","content":"${SEP}"}\n`, 'utf-8');
    expect((await parseAntigravityTranscript(f)).turns).toBe(1);
  });

  it('handoff parseSession: a tool call on a line with U+2028 is seen', async () => {
    const f = await file(`{"type":"assistant","message":{"content":[{"type":"text","text":"${SEP}"},{"type":"tool_use","name":"Edit","input":{"file_path":"/x/y.ts"}}]}}\n`);
    expect((await parseSession(f)).filesEdited).toEqual(['/x/y.ts']);
  });
});

describe('zero tokens cost $0 only where a price could apply', () => {
  const zeros = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  it('$0 for a priced Claude model, a null model and <synthetic>', () => {
    expect(estimateCostUsd('claude-sonnet-5', zeros)).toBe(0);
    expect(estimateCostUsd(null, zeros)).toBe(0);
    expect(estimateCostUsd('<synthetic>', zeros)).toBe(0);
  });
  it('no cost for an unpriced model (Codex/GPT) even at all-zero counts', () => {
    expect(estimateCostUsd('gpt-5.5', zeros)).toBeNull();
  });
  it('a Codex rollout with all-zero counts has no cost, not $0.00', async () => {
    const f = await file(`{"type":"turn_context","payload":{"model":"gpt-5.5"}}\n{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":0,"output_tokens":0}}}}\n`);
    expect((await parseCodexRollout(f)).estCostUsd).toBeNull();
  });
});

describe('antigravity bare tokenCount', () => {
  it('counts toward consumedTokens (they are not cache reads)', async () => {
    const d = join(dir, 'brain', 'tok', '.system_generated', 'logs');
    await mkdir(d, { recursive: true });
    const f = join(d, 'transcript.jsonl');
    await writeFile(f, '{"source":"MODEL","type":"PLANNER_RESPONSE","tokenCount":1200}\n{"source":"MODEL","type":"PLANNER_RESPONSE","tokenCount":800}\n', 'utf-8');
    const u = await parseAntigravityTranscript(f);
    expect(u.totalTokens).toBe(2000);
    expect(u.consumedTokens).toBe(2000);
  });
});

describe('claude cwd', () => {
  it('comes from the first line of any kind that logged one', async () => {
    const f = await file([
      '{"type":"user","cwd":"/repo/first","message":{}}',
      '{"type":"assistant","cwd":"/repo/later","message":{"id":"m1","model":"claude-sonnet-5","usage":{"input_tokens":1}}}',
    ].join('\n') + '\n');
    expect((await parseSessionUsage(f)).cwd).toBe('/repo/first');
  });
});

describe('RepoUsage.pricesAsOf', () => {
  it('carries the price-table date', async () => {
    const home = process.env.HOME;
    process.env.HOME = dir; // no agent logs under here: nothing real is read
    try {
      expect((await usageForRepo(join(dir, 'repo'), [])).pricesAsOf).toBe(PRICES_AS_OF);
    } finally {
      process.env.HOME = home;
    }
  });
});

describe('baton usage fmt', () => {
  it('prints billions with a B unit', () => {
    expect(fmt(2_430_300_000)).toBe('2.43B');
    expect(fmt(2_430_300)).toBe('2.4M');
    expect(fmt(null)).toBe('—');
  });
});
