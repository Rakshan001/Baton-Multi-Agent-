// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The memory capture nudge.
 *
 * A session that ends without a handoff records nothing: the agent learns
 * something durable at minute three and the knowledge dies with the process.
 * Hermes solves this from inside its own loop (`_memory_nudge_interval`, every
 * ten turns). Baton is not inside anyone's loop — but it ANSWERS the agent's
 * tool calls, and `groundMovedNotice` (mcp-pipeline.ts) already proves an
 * answer can carry a message the agent did not ask for. This rides that same
 * channel.
 *
 * Deliberately NOT a tool. Every registered tool costs a schema in every
 * session's `tools/list` — the permanent context tax `baton/plans/context-cost.md`
 * is spending effort to remove — and a tool the agent must remember to call is
 * exactly the thing an agent about to forget its knowledge will not call.
 *
 * Pure, and time is an argument: the caller owns both the clock and the state,
 * so every firing rule below is a unit test rather than a sleep.
 *
 * The failure mode this guards against is not "too few nudges", it is too
 * many. A reminder on every answer is ignored within a minute and still gets
 * billed on every answer it rode in on — worse than no reminder at all. Hence
 * two independent brakes: one per interval, and never on two answers in a row.
 */

/** How long a session may go without recording anything before it hears about it. */
export const MEMORY_NUDGE_INTERVAL_MS = 15 * 60_000;

/**
 * The reminder itself. It is paid for on every answer it rides, so its length
 * is a budget, not a style choice — one line, and it names the tool, because a
 * nudge the agent has to go looking up is a nudge that costs twice.
 */
export const MEMORY_NUDGE = 'Learned something the next session needs? save_memory it now.';

export interface NudgeState {
  /** When this session began (epoch ms). */
  startedAt: number;
  /** When it last recorded a fact, or null if it never has. */
  lastSavedAt: number | null;
  /** When it was last nudged, or null. */
  lastNudgeAt: number | null;
  /** Did the PREVIOUS answer carry the nudge? Not derivable from the times
   *  above: a quiet agent's next call can land an interval later, and two
   *  reminders on consecutive answers is the shape agents learn to ignore. */
  lastWasNudge: boolean;
}

export function newNudgeState(startedAt: number): NudgeState {
  return { startedAt, lastSavedAt: null, lastNudgeAt: null, lastWasNudge: false };
}

/** The session recorded a fact — the clock the nudge watches starts over. */
export function recordSave(state: NudgeState, at: number): NudgeState {
  return { ...state, lastSavedAt: at, lastWasNudge: false };
}

export interface NudgeDecision {
  /** Text to attach to the answer being sent, or null to send it untouched. */
  notice: string | null;
  /** The state to carry into the next answer. Returned rather than mutated so
   *  the decision stays a pure function of its inputs. */
  state: NudgeState;
}

/**
 * Should the tool answer about to be sent carry the capture reminder?
 *
 * Fires when the session has gone a whole interval without saving anything and
 * without being told — the last save, the last nudge and the session start are
 * all the same kind of evidence that memory is current, so the most recent of
 * them starts the clock. A clock that jumped backwards yields no nudge, which
 * is the right way to be wrong here.
 */
export function memoryNudge(state: NudgeState, now: number): NudgeDecision {
  const since = Math.max(state.startedAt, state.lastSavedAt ?? 0, state.lastNudgeAt ?? 0);
  // This answer carries nothing, so it is the plain answer the back-to-back
  // guard is waiting for. Clearing the flag here is what keeps the guard
  // meaning "not two in a ROW" instead of quietly halving the reminder rate:
  // leave it set and the next answer that comes due is swallowed as well.
  const quiet: NudgeDecision = { notice: null, state: { ...state, lastWasNudge: false } };
  if (now - since < MEMORY_NUDGE_INTERVAL_MS) return quiet;
  // Interval is up, but the previous answer already said it. Spend this one
  // saying nothing and let the next answer carry it.
  if (state.lastWasNudge) return quiet;
  return { notice: MEMORY_NUDGE, state: { ...state, lastNudgeAt: now, lastWasNudge: true } };
}

/**
 * One session's nudge, as the answer channel uses it.
 *
 * The decision above is pure and stays that way; something has to hold the
 * state between two tool answers, and that something belongs here rather than
 * in `startMcpServer` — mcp.ts registers tools, and a nudge that lives in it is
 * a nudge that gets forgotten the way this one already was once.
 *
 * The clock is an argument for the same reason it is above: the wiring is a
 * unit test, not a fifteen-minute sleep.
 */
export interface NudgeChannel {
  /** The reminder this answer should carry, or null. Consumes the decision, so
   *  call it once per answer and only when the answer can actually carry it. */
  notice(): string | null;
  /** The session recorded a fact — restart the clock. */
  saved(): void;
}

export function nudgeChannel(startedAt: number, clock: () => number = Date.now): NudgeChannel {
  let state = newNudgeState(startedAt);
  return {
    notice() {
      const out = memoryNudge(state, clock());
      state = out.state;
      return out.notice;
    },
    saved() {
      state = recordSave(state, clock());
    },
  };
}
