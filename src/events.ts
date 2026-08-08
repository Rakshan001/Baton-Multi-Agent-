// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Transport-agnostic event bus for everything "live" in Baton: the SSE
 * endpoint subscribes to it today, and a socket.io (or anything else)
 * transport could subscribe tomorrow without touching the emitters.
 *
 * A small ring buffer of recent events (with monotonic ids) lets an SSE
 * client reconnect with Last-Event-ID and replay what it missed.
 */
import { EventEmitter } from 'node:events';
import type { StatusRow } from './board.js';

export type BatonEvent =
  | { type: 'status.changed'; rows: StatusRow[] }
  | { type: 'task.created'; slug: string; task: string }
  | { type: 'task.removed'; slug: string }
  | { type: 'task.merged'; slug: string; report?: unknown }
  | { type: 'commit.created'; slug: string; sha: string; message: string }
  | { type: 'agent.started'; slug: string; agent: string }
  | { type: 'agent.stopped'; slug: string; agent: string }
  | { type: 'agent.output'; slug: string; line: string; stream: 'out' | 'err' }
  | { type: 'file.edited'; slug: string; path: string; at: string }
  | { type: 'signal.overlap'; path: string; slugs: string[] }
  | { type: 'kb.rebuilt'; project: string }
  | { type: 'handoff.created'; slug: string; toAgent: string }
  | { type: 'agent.connected'; agent: string }
  | { type: 'skill.installed'; skill: string; agent: string }
  | { type: 'junk.cleaned'; count: number }
  /** A code review was recorded. Per-axis counts only — the axes are separate
   *  by design, so no combined total rides on the event. */
  | { type: 'review.completed'; slug: string; standards: number; spec: number; security: number }
  /** A verdict on a task, not a set of findings — the moment a task leaves
   *  `review` for `done` or goes back to `active`. */
  | { type: 'task.reviewed'; slug: string; verdict: 'approve' | 'reject'; actor: string }
  | { type: 'terminal.started'; slug: string; agent: string }
  | { type: 'terminal.exited'; slug: string; agent: string }
  | { type: 'terminal.output'; slug: string; data: string /* base64 */ }
  | { type: 'memory.updated' }
  /* --- presence + federated claims (src/federation.ts) ---
     Live-plane only: these are never persisted and never reach git. A member
     that vanishes leaves via TTL, not via a message, so `member.left` is emitted
     by the host's sweep rather than by the departing member. */
  | { type: 'member.joined'; memberId: string; memberName: string }
  | { type: 'member.left'; memberId: string; memberName: string }
  | { type: 'member.presence'; online: number }
  | { type: 'claim.opened'; memberId: string; relPath: string; projectId: string | null }
  | { type: 'claim.released'; memberId: string; relPath: string; projectId: string | null }
  /** Two members on one path. `sameBranch` false = information, not a warning:
   *  divergent branches meet at merge, not in a working tree. Advisory either
   *  way — nothing is blocked, which is why this is an event and not an error. */
  | { type: 'claim.conflict'; relPath: string; projectId: string | null; sameBranch: boolean; memberIds: string[] }
  /* --- pipeline claims, arbitrated by the hub (§1.1, §7.6) ---
     Not to be confused with `claim.opened` above. That is a FILE claim: advisory,
     live-plane only, TTL'd, and two members holding one path is a warning. This
     is a TASK claim: persisted in tasks.json, exclusive, and two members holding
     one task is the failure the pipeline exists to prevent — so it is decided by
     one writer (the hub) rather than pooled from whoever reports in.
     `by` is the member the hub resolved from the token, never anything the
     caller said about itself. */
  | { type: 'task.claimed'; slug: string; agent: string; by: string }
  | { type: 'task.unclaimed'; slug: string; by: string }
  /* Cancellation (§8). Carries the whole set rather than one event per slug:
     cancelling a phase is ONE decision, and fanning it out as N events would
     let a client render half a cancellation if the stream dropped mid-burst.
     `stranded` rides along because it is the consequence nobody predicts — a
     dashboard that learns about the cancel but not the stranding shows a board
     with tasks that will never start and no reason why. */
  | { type: 'task.cancelled'; slugs: string[]; stranded: string[]; scope: string; by: string; reason?: string }
  /* --- owner controls (Phase 6) ---
     Every one of these is an owner acting ON someone, so every one carries who
     did it. They exist as events precisely so the action lands in the same
     stream everything else does — an owner cannot warn, disconnect or remove a
     member without it being visible to the room.

     `member.warned` deliberately carries NO message text: the bus fans every
     event to every subscriber, so the payload here is readable by the whole
     hub — and the warning text is private owner↔member correspondence. The
     fact of the warning is public; the words reach the target through their
     own heartbeat response (federation.warningsFor). */
  | { type: 'member.warned'; memberId: string; memberName: string; by: string }
  | { type: 'member.disconnected'; memberId: string; memberName: string; by: string }
  | { type: 'member.revoked'; memberId: string; memberName: string; by: string }
  | { type: 'claim.cleared'; memberId: string; relPath: string; projectId: string | null; by: string }
  /* --- teams (Phase 8, src/teams.ts) ---
     ONE event type with an `action`, not four. Every consumer of these does the
     same thing — refetch the roster and note who did it — so four types would
     be four subscriptions that can each be forgotten separately. The federated
     claim plane emits nothing here: teams group and filter, they never move a
     claim, and an event suggesting otherwise would be the first step toward
     believing they do. */
  | {
      type: 'team.changed';
      action: 'created' | 'updated' | 'removed' | 'assigned';
      teamId: string;
      teamName: string;
      /** Set for `assigned` only — who was moved. */
      memberId?: string;
      by: string;
    };

export type BatonEventType = BatonEvent['type'];

export interface StampedEvent {
  id: number;
  event: BatonEvent;
}

const RING_SIZE = 200;

/**
 * High-volume byte streams (raw terminal output) would evict every useful
 * event from the replay ring; they are emitted live but never ringed —
 * terminals keep their own per-session scrollback for late joiners.
 */
const TRANSIENT_TYPES = new Set<BatonEventType>(['terminal.output']);

class BatonBus extends EventEmitter {
  private nextId = 1;
  private ring: StampedEvent[] = [];

  constructor() {
    super();
    // Each SSE connection (dashboard tabs + per-terminal streams) adds one 'event'
    // listener; this is intentional unbounded fan-out, not a leak (onAny returns an
    // unsubscribe that fires on client disconnect). Lift the default cap of 10 so
    // normal multi-tab use doesn't print a spurious MaxListenersExceededWarning.
    this.setMaxListeners(0);
  }

  publish(event: BatonEvent): StampedEvent {
    const stamped: StampedEvent = { id: this.nextId++, event };
    if (!TRANSIENT_TYPES.has(event.type)) {
      this.ring.push(stamped);
      if (this.ring.length > RING_SIZE) this.ring.shift();
    }
    this.emit('event', stamped);
    this.emit(event.type, stamped);
    return stamped;
  }

  /** Events newer than `lastId` — for Last-Event-ID replay on reconnect. */
  since(lastId: number): StampedEvent[] {
    return this.ring.filter((e) => e.id > lastId);
  }

  onAny(fn: (e: StampedEvent) => void): () => void {
    const safe = guard(fn);
    this.on('event', safe);
    return () => this.off('event', safe);
  }

  onType(type: BatonEventType, fn: (e: StampedEvent) => void): () => void {
    const safe = guard(fn);
    this.on(type, safe);
    return () => this.off(type, safe);
  }
}

/**
 * A subscriber that throws must not take down the publisher: publish() is called
 * from fs.watch debounce timers and setInterval callbacks, where a propagated
 * exception (e.g. a locked SQLite write) is an uncaughtException — daemon exit.
 * One bad subscriber loses its own event, never the process.
 */
function guard(fn: (e: StampedEvent) => void): (e: StampedEvent) => void {
  return (e) => {
    try {
      fn(e);
    } catch (err) {
      console.error(`baton: event subscriber failed on ${e.event.type}:`, err);
    }
  };
}

export const bus = new BatonBus();
