// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The answer channel — the one wrapper every registered MCP tool goes through.
 *
 * Two messages an agent never asked for ride out on tool answers: the ground
 * has moved under your task (`groundMovedNotice`), and you have not recorded
 * anything in a while (`memoryNudge`). Neither is a tool, deliberately — a tool
 * costs a schema in every session's `tools/list`, forever, and a reminder the
 * agent must remember to ask for is exactly what an agent about to forget will
 * not ask for.
 *
 * `memoryNudge` shipped complete and tested and attached to nothing, so no agent
 * was ever nudged. That is what this file exists to keep from recurring: the
 * assertions below are about the ENVELOPE an ordinary tool answer goes out in,
 * not about the firing rules (test/memory-nudge.test.ts owns those).
 */
import { describe, it, expect } from 'vitest';
import { withNotices } from '../src/mcp.js';
import { MEMORY_NUDGE, MEMORY_NUDGE_INTERVAL_MS, nudgeChannel } from '../src/mcp-nudge.js';
import { usePrivateHome } from './helpers/private-home.js';

// src/mcp.ts reaches the skill catalogue, which reads the machine-wide library
// under ~/.baton. Nothing here installs a skill, but importing it must not be
// able to touch a developer's real one.
usePrivateHome();

const T0 = 1_700_000_000_000;

type Answer = { content: { type: string; text: string }[] };

const answer = (text = 'ok'): Answer => ({ content: [{ type: 'text', text }] });

/** The ride-along block, if the answer carries one. */
function riders(res: unknown): Record<string, string> {
  const content = (res as Answer).content;
  const first = content[0]?.text ?? '';
  const parsed = JSON.parse(first) as Record<string, string>;
  return parsed;
}

const quiet = { notice: () => null, saved: () => {} };
const noCancellation = async (): Promise<string | null> => null;

describe('withNotices — what an ordinary tool answer carries out', () => {
  it('leaves an answer untouched when there is nothing to say', async () => {
    const res = await withNotices(async () => answer(), { cancellation: noCancellation, nudge: quiet })();
    expect(res).toEqual(answer());
  });

  it('attaches the capture reminder to an EXISTING tool answer', async () => {
    // A session that has run an interval without saving anything. The next tool
    // it calls — any tool — is the soonest moment it can hear about it.
    const now = T0 + MEMORY_NUDGE_INTERVAL_MS;
    const res = await withNotices(async () => answer('the tool result'), {
      cancellation: noCancellation,
      nudge: nudgeChannel(T0, () => now),
    })();

    expect(riders(res).batonReminder).toBe(MEMORY_NUDGE);
    // The answer the agent actually asked for is still there, and still last —
    // a rider that displaces the result is a rider that broke the tool.
    expect((res as Answer).content).toHaveLength(2);
    expect((res as Answer).content[1]).toEqual({ type: 'text', text: 'the tool result' });
  });

  it('carries a cancellation notice and the reminder in one block, not two', async () => {
    const now = T0 + MEMORY_NUDGE_INTERVAL_MS;
    const res = await withNotices(async () => answer(), {
      cancellation: async () => 'STOP: task gone',
      nudge: nudgeChannel(T0, () => now),
    })();

    expect((res as Answer).content).toHaveLength(2);
    expect(riders(res)).toEqual({ batonNotice: 'STOP: task gone', batonReminder: MEMORY_NUDGE });
  });

  it('refreshes presence before the tool runs, on every call', async () => {
    let touched = 0;
    const call = withNotices(async () => answer(), {
      presence: () => { touched += 1; },
      cancellation: noCancellation,
      nudge: quiet,
    });
    await call();
    await call();
    expect(touched).toBe(2);
  });

  it('spends no nudge on an answer that cannot carry one', async () => {
    // A handler that returns something with no content array has nowhere to put
    // a rider. Consuming the decision anyway would reset the clock and lose the
    // reminder entirely — the failure this whole file is about.
    const now = T0 + MEMORY_NUDGE_INTERVAL_MS;
    const channel = nudgeChannel(T0, () => now);
    const res = await withNotices(async () => ({ notContent: true }), {
      cancellation: noCancellation,
      nudge: channel,
    })();

    expect(res).toEqual({ notContent: true });
    expect(channel.notice()).toBe(MEMORY_NUDGE);   // still owed, not swallowed
  });
});
