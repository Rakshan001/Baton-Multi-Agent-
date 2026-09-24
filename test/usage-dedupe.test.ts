// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Claude Code writes one transcript line per content block, and every line of
 * one API message carries the same `message.id` and a copy of its `usage`.
 * Counting each line counts the message several times. Output is the one field
 * that is NOT copied verbatim: it grows as the message streams, so the merge
 * keeps the max of each field, never the first line seen.
 *
 * Synthetic fixtures only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSessionUsage } from '../src/usage.js';

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'baton-usage-dedupe-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

let n = 0;
async function parse(lines: unknown[]) {
  const file = join(dir, `s${n++}.jsonl`);
  await writeFile(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n', 'utf-8');
  return parseSessionUsage(file);
}

const line = (id: string | undefined, usage: Record<string, unknown>, model = 'claude-sonnet-4-5') => ({
  type: 'assistant',
  timestamp: '2026-09-01T00:00:00Z',
  message: { ...(id ? { id } : {}), model, usage },
});

describe('one API message is one turn, however many lines it was written as', () => {
  it('merges lines that share a message.id, keeping the max of each field', async () => {
    const u = await parse([
      line('msg_a', { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 1 }),
      line('msg_a', { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 }),
      line('msg_a', { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 40 }),
    ]);
    expect(u.turns).toBe(1);
    expect(u.inputTokens).toBe(10);
    expect(u.cacheReadTokens).toBe(100);
    expect(u.outputTokens).toBe(40);
  });

  it('keeps the real counts when the last duplicate line is zeroed', async () => {
    const u = await parse([
      line('msg_z', { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 50, cache_creation_input_tokens: 3 }),
      line('msg_z', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    ]);
    expect(u.turns).toBe(1);
    expect([u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens]).toEqual([10, 7, 50, 3]);
  });

  it('counts each id once and sums across ids', async () => {
    const u = await parse([
      line('msg_1', { input_tokens: 10, output_tokens: 2 }),
      line('msg_1', { input_tokens: 10, output_tokens: 4 }),
      line('msg_2', { input_tokens: 20, output_tokens: 3 }),
      line('msg_2', { input_tokens: 20, output_tokens: 6 }),
    ]);
    expect(u.turns).toBe(2);
    expect(u.inputTokens).toBe(30);
    expect(u.outputTokens).toBe(10);
  });

  it('still counts a line with no id as one message of its own', async () => {
    const u = await parse([
      line(undefined, { input_tokens: 10, output_tokens: 2 }),
      line(undefined, { input_tokens: 10, output_tokens: 2 }),
    ]);
    expect(u.turns).toBe(2);
    expect(u.inputTokens).toBe(20);
  });

  it('applies the countOf guard before the max: a string count is absent', async () => {
    const u = await parse([
      line('msg_s', { output_tokens: '9' }),
      line('msg_s', { output_tokens: 7 }),
    ]);
    expect(u.turns).toBe(1);
    expect(u.outputTokens).toBe(7);
  });
});

describe('consumedTokens: what was actually processed, cache reads excluded', () => {
  it('sums input, output and cache writes, leaving cache reads out', async () => {
    const u = await parse([
      line('msg_c', { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5 }),
    ]);
    expect(u.consumedTokens).toBe(35);
    expect(u.totalTokens).toBe(1035);
  });

  it('is null when nothing was reported, not 0', async () => {
    const u = await parse([line('msg_n', { input_tokens: 'x' })]);
    expect(u.consumedTokens).toBeNull();
  });
});
