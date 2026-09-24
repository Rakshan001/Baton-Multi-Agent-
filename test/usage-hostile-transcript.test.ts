// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What a transcript is allowed to put in a token field.
 *
 * `src/usage.ts` is built on one rule: a `null` means the format never reported
 * the number and a `0` means it reported zero. The Claude parser held that rule
 * for an ABSENT field and dropped it for a MALFORMED one — anything that was not
 * `null`/`undefined` was added straight onto the running counter:
 *
 *   - `"500"` made `inputTokens` the STRING `"0500"` and `totalTokens` the
 *     string `"0050010"` — fifty thousand ten — in fields typed `number | null`.
 *   - `1e999` parses to `Infinity`; one such line makes the session, and then
 *     the whole repo's total, non-finite. `JSON.stringify` writes `Infinity` as
 *     `null`, so the dashboard reads the poisoned total as "never measured" and
 *     every real session behind it disappears into a dash.
 *   - `NaN`-producing shapes and negative counts sailed through the same hole.
 *
 * A field a transcript filled with something a token count cannot be was not
 * measured. It has to come back absent, and the counts around it have to
 * survive untouched — one bad line must not cost the good ones.
 *
 * Codex had the same hole one level in: `cached_input_tokens` was checked for
 * `typeof number` but not for finiteness, and `input − Infinity` clamps to a
 * measured-looking `0`.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregate, parseSessionUsage, type SessionUsage } from '../src/usage.js';
import { parseCodexRollout } from '../src/usage/codex.js';

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'baton-usage-hostile-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

let n = 0;
/** Write `lines` as one Claude transcript and parse it. */
async function claude(lines: string[]): Promise<Awaited<ReturnType<typeof parseSessionUsage>>> {
  const file = join(dir, `c${n++}.jsonl`);
  await writeFile(file, lines.join('\n') + '\n', 'utf-8');
  return parseSessionUsage(file);
}

/** An assistant line with an arbitrary `usage` object. */
const turn = (usage: unknown, model = 'claude-sonnet-4-5'): string =>
  JSON.stringify({ type: 'assistant', timestamp: '2026-09-01T00:00:00Z', message: { model, usage } });

describe('a token field that is not a token count is not a measurement', () => {
  it('never lets a string count concatenate onto the counter', async () => {
    const u = await claude([turn({ input_tokens: '500', output_tokens: 10 })]);

    // The transcript did not report a number for input, so input is absent.
    expect(u.inputTokens).toBeNull();
    // And the sibling that WAS a number is untouched — one bad field is not a
    // reason to lose the good one.
    expect(u.outputTokens).toBe(10);
    expect(u.totalTokens).toBe(10);
  });

  it('keeps every count a number or null — never a string', async () => {
    const u = await claude([turn({ input_tokens: '500', output_tokens: {}, cache_read_input_tokens: true })]);

    for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'] as const) {
      const v = u[k];
      expect(v === null || typeof v === 'number', `${k} = ${JSON.stringify(v)}`).toBe(true);
    }
  });

  it('drops an Infinity rather than letting it poison the total', async () => {
    // 1e999 is finite JSON text that parses to Infinity.
    const u = await claude([
      turn({ input_tokens: 100, output_tokens: 5 }),
      '{"type":"assistant","timestamp":"2026-09-01T00:00:01Z","message":{"model":"claude-opus-4","usage":{"input_tokens":1e999,"output_tokens":2}}}',
    ]);

    expect(Number.isFinite(u.inputTokens as number)).toBe(true);
    expect(u.inputTokens).toBe(100); // the one real measurement, intact
    expect(u.outputTokens).toBe(7);
    expect(Number.isFinite(u.totalTokens as number)).toBe(true);
  });

  it('does not let one non-finite session erase the whole repo total', async () => {
    // The shape that made the dashboard read "—" for a repo that plainly spent:
    // JSON.stringify turns a non-finite total into null, which is the wire
    // encoding of "never measured".
    const poisoned = await claude([
      '{"type":"assistant","message":{"model":"claude-opus-4","usage":{"input_tokens":1e999}}}',
    ]);
    const real = await claude([turn({ input_tokens: 1000, output_tokens: 100 })]);

    const totals = aggregate([
      { ...poisoned, slug: null } as SessionUsage,
      { ...real, slug: null } as SessionUsage,
    ]).totals;

    expect(JSON.parse(JSON.stringify(totals)).totalTokens).toBe(1100);
  });

  it('treats a NaN-shaped count as absent', async () => {
    const u = await claude([turn({ input_tokens: 'x', output_tokens: 3 })]);

    expect(u.inputTokens).toBeNull();
    expect(u.outputTokens).toBe(3);
    expect(u.totalTokens).toBe(3);
  });

  it('refuses a negative count instead of subtracting it from real spend', async () => {
    const u = await claude([
      turn({ input_tokens: 1000, output_tokens: 10 }),
      turn({ input_tokens: -900, output_tokens: 1 }),
    ]);

    expect(u.inputTokens).toBe(1000);
    expect(u.outputTokens).toBe(11);
  });

  it('never prices a session off a corrupted count', async () => {
    const u = await claude([turn({ input_tokens: '9999999999', output_tokens: 0 })]);

    // Output measured zero, input was never measured: the estimate is the
    // honest one for what WAS reported, and it is a finite number.
    expect(u.estCostUsd === null || Number.isFinite(u.estCostUsd)).toBe(true);
    expect(u.estCostUsd).toBe(0);
  });
});

describe('a session span is its earliest and latest stamp, not its first and last line', () => {
  it('does not report firstAt after lastAt when entries arrive out of order', async () => {
    const u = await claude([
      JSON.stringify({ type: 'assistant', timestamp: '2026-05-05T00:00:00Z', message: { usage: { input_tokens: 1 } } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { usage: { input_tokens: 1 } } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-03-03T00:00:00Z', message: { usage: { input_tokens: 1 } } }),
    ]);

    expect(u.firstAt).toBe('2026-01-01T00:00:00Z');
    expect(u.lastAt).toBe('2026-05-05T00:00:00Z');
    expect(Date.parse(u.firstAt as string)).toBeLessThanOrEqual(Date.parse(u.lastAt as string));
  });

  it('compares stamps as instants, not as strings, across timezone offsets', async () => {
    // 2026-01-01T00:30+05:30 is 2025-12-31T19:00Z — earlier than the Z stamp,
    // though it sorts after it lexicographically.
    const u = await claude([
      JSON.stringify({ type: 'assistant', timestamp: '2025-12-31T20:00:00Z', message: { usage: { input_tokens: 1 } } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:30:00+05:30', message: { usage: { input_tokens: 1 } } }),
    ]);

    expect(Date.parse(u.firstAt as string)).toBeLessThan(Date.parse(u.lastAt as string));
  });
});

describe('codex: a corrupt cached slice must not invent a measured zero', () => {
  it('leaves input absent rather than clamping it to 0', async () => {
    const file = join(dir, 'rollout-hostile.jsonl');
    await writeFile(file, [
      JSON.stringify({ timestamp: '2026-07-03T11:00:00Z', type: 'session_meta', payload: { cwd: '/fixture/repo', session_id: 'sess-1' } }),
      // cached_input_tokens is a number by typeof and garbage by value.
      '{"timestamp":"2026-07-03T11:00:01Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":5000,"cached_input_tokens":1e999,"output_tokens":40,"total_tokens":5040}}}}',
    ].join('\n') + '\n', 'utf-8');

    const u = await parseCodexRollout(file);

    // 5000 − Infinity clamps to 0, which reads as "this session measurably
    // used no uncached input". It did not: nothing usable was reported.
    expect(u.inputTokens).not.toBe(0);
    expect(u.cacheReadTokens).toBeNull();
  });
});
