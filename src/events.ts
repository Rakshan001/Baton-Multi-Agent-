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
  | { type: 'terminal.started'; slug: string; agent: string }
  | { type: 'terminal.exited'; slug: string; agent: string }
  | { type: 'terminal.output'; slug: string; data: string /* base64 */ };

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
    this.on('event', fn);
    return () => this.off('event', fn);
  }

  onType(type: BatonEventType, fn: (e: StampedEvent) => void): () => void {
    this.on(type, fn);
    return () => this.off(type, fn);
  }
}

export const bus = new BatonBus();
