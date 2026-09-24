// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import {
  MEMORY_NUDGE,
  MEMORY_NUDGE_INTERVAL_MS,
  memoryNudge,
  newNudgeState,
  nudgeChannel,
  recordSave,
  type NudgeState,
} from '../src/mcp-nudge.js';

/**
 * The capture nudge. A session that dies without a handoff currently records
 * nothing, and Baton is not inside the agent's loop — but it answers the
 * agent's tool calls, and `groundMovedNotice` already proves an answer can
 * carry a message the agent did not ask for. This is that channel, used for
 * memory, and it is a pure decision so every firing rule is a unit test.
 */

const T0 = 1_700_000_000_000; // fixed epoch — nothing here reads a clock
const MIN = 60_000;

describe('memoryNudge — when an answer should carry a capture reminder', () => {
  it('does not nudge a session that has barely started', () => {
    const s = newNudgeState(T0);
    expect(memoryNudge(s, T0 + 5 * MIN).notice).toBeNull();
  });

  it('nudges once the session has run an interval with nothing saved', () => {
    const s = newNudgeState(T0);
    const out = memoryNudge(s, T0 + MEMORY_NUDGE_INTERVAL_MS + 1);
    expect(out.notice).toBe(MEMORY_NUDGE);
    expect(out.state.lastNudgeAt).toBe(T0 + MEMORY_NUDGE_INTERVAL_MS + 1);
  });

  it('keeps the reminder to a few dozen characters and names the tool', () => {
    // It is paid for on every answer it rides, so its length is a budget, not
    // a style preference.
    expect(MEMORY_NUDGE.length).toBeLessThanOrEqual(80);
    expect(MEMORY_NUDGE).toContain('save_memory');
  });

  it('never fires on two answers in a row, however long the gap', () => {
    const first = memoryNudge(newNudgeState(T0), T0 + MEMORY_NUDGE_INTERVAL_MS);
    expect(first.notice).toBe(MEMORY_NUDGE);
    // A quiet agent can return an interval later; the very next answer still
    // must not carry it. Two nudges back to back read as noise and get ignored.
    const second = memoryNudge(first.state, T0 + 10 * MEMORY_NUDGE_INTERVAL_MS);
    expect(second.notice).toBeNull();
    const third = memoryNudge(second.state, T0 + 10 * MEMORY_NUDGE_INTERVAL_MS);
    expect(third.notice).toBe(MEMORY_NUDGE);
  });

  it('lets the very next answer carry it once an ordinary answer has intervened', () => {
    // The guard is "never on two answers in a ROW". An answer that carried no
    // reminder is not a reminder, so it must clear the guard — otherwise every
    // second eligible nudge is swallowed and the session hears half of them.
    const first = memoryNudge(newNudgeState(T0), T0 + MEMORY_NUDGE_INTERVAL_MS);
    expect(first.notice).toBe(MEMORY_NUDGE);
    const quiet = memoryNudge(first.state, T0 + MEMORY_NUDGE_INTERVAL_MS + MIN);
    expect(quiet.notice).toBeNull();          // inside the interval: nothing to say
    const due = memoryNudge(quiet.state, T0 + 2 * MEMORY_NUDGE_INTERVAL_MS);
    expect(due.notice).toBe(MEMORY_NUDGE);    // the PREVIOUS answer was not a nudge
  });

  it('fires every interval, not every other one', () => {
    let s: NudgeState = newNudgeState(T0);
    const fired: number[] = [];
    for (let i = 1; i <= 240; i++) {
      const now = T0 + i * MIN;
      const out = memoryNudge(s, now);
      s = out.state;
      if (out.notice) fired.push(now);
    }
    // Four hours of one-a-minute answers is sixteen due intervals. Anything
    // near half of that is the back-to-back guard leaking across quiet answers.
    expect(fired.length).toBe(16);
    for (let i = 1; i < fired.length; i++) {
      expect(fired[i] - fired[i - 1]).toBe(MEMORY_NUDGE_INTERVAL_MS);
    }
  });

  it('fires at most once per interval', () => {
    let s: NudgeState = newNudgeState(T0);
    const fired: number[] = [];
    // One tool answer a minute for four hours.
    for (let i = 1; i <= 240; i++) {
      const now = T0 + i * MIN;
      const out = memoryNudge(s, now);
      s = out.state;
      if (out.notice) fired.push(now);
    }
    expect(fired.length).toBeGreaterThan(1);
    for (let i = 1; i < fired.length; i++) {
      expect(fired[i] - fired[i - 1]).toBeGreaterThanOrEqual(MEMORY_NUDGE_INTERVAL_MS);
    }
  });

  it('does not nudge a session that saved memory recently', () => {
    const s = recordSave(newNudgeState(T0), T0 + 3 * MEMORY_NUDGE_INTERVAL_MS);
    expect(memoryNudge(s, T0 + 3 * MEMORY_NUDGE_INTERVAL_MS + MIN).notice).toBeNull();
  });

  it('a save resets the window that a nudge would have opened', () => {
    const nudged = memoryNudge(newNudgeState(T0), T0 + MEMORY_NUDGE_INTERVAL_MS);
    const saved = recordSave(nudged.state, T0 + MEMORY_NUDGE_INTERVAL_MS + MIN);
    // Two intervals after the nudge, but only one minute after the save.
    expect(memoryNudge(saved, T0 + 2 * MEMORY_NUDGE_INTERVAL_MS).notice).toBeNull();
  });

  it('is pure: same input, same answer, and the caller’s state is not mutated', () => {
    const s = newNudgeState(T0);
    const frozen = JSON.stringify(s);
    const a = memoryNudge(s, T0 + MEMORY_NUDGE_INTERVAL_MS + 1);
    const b = memoryNudge(s, T0 + MEMORY_NUDGE_INTERVAL_MS + 1);
    expect(a).toEqual(b);
    expect(JSON.stringify(s)).toBe(frozen);
  });

  it('never nudges on a clock that went backwards', () => {
    const s = newNudgeState(T0);
    expect(memoryNudge(s, T0 - 10 * MEMORY_NUDGE_INTERVAL_MS).notice).toBeNull();
  });
});

/**
 * The channel is the stateful half — one per session, wrapped around the pure
 * decision above so `startMcpServer` holds no nudge logic of its own. The clock
 * is still an argument, for the same reason: every rule is a unit test.
 */
describe('nudgeChannel — the per-session ride-along', () => {
  it('stays quiet until the session has run an interval without saving', () => {
    let now = T0;
    const channel = nudgeChannel(T0, () => now);
    expect(channel.notice()).toBeNull();
    now = T0 + MEMORY_NUDGE_INTERVAL_MS - 1;
    expect(channel.notice()).toBeNull();
    now = T0 + MEMORY_NUDGE_INTERVAL_MS;
    expect(channel.notice()).toBe(MEMORY_NUDGE);
  });

  it('carries the state forward, so it never fires on two answers in a row', () => {
    let now = T0 + MEMORY_NUDGE_INTERVAL_MS;
    const channel = nudgeChannel(T0, () => now);
    expect(channel.notice()).toBe(MEMORY_NUDGE);
    now = T0 + 10 * MEMORY_NUDGE_INTERVAL_MS;
    expect(channel.notice()).toBeNull();
    expect(channel.notice()).toBe(MEMORY_NUDGE);
  });

  it('resumes on schedule after an ordinary answer, not an interval late', () => {
    let now = T0 + MEMORY_NUDGE_INTERVAL_MS;
    const channel = nudgeChannel(T0, () => now);
    expect(channel.notice()).toBe(MEMORY_NUDGE);
    now = T0 + MEMORY_NUDGE_INTERVAL_MS + MIN;
    expect(channel.notice()).toBeNull();      // an ordinary answer, no reminder
    now = T0 + 2 * MEMORY_NUDGE_INTERVAL_MS;
    expect(channel.notice()).toBe(MEMORY_NUDGE);
  });

  it('a recorded save silences it', () => {
    let now = T0 + MEMORY_NUDGE_INTERVAL_MS;
    const channel = nudgeChannel(T0, () => now);
    channel.saved();
    expect(channel.notice()).toBeNull();
    now = T0 + 2 * MEMORY_NUDGE_INTERVAL_MS - 1;
    expect(channel.notice()).toBeNull();
    now = T0 + 2 * MEMORY_NUDGE_INTERVAL_MS;
    expect(channel.notice()).toBe(MEMORY_NUDGE);
  });
});
