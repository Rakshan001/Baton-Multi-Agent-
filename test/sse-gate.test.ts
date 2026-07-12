import { describe, it, expect } from 'vitest';
import { SseGate } from '../src/util/sse-gate.js';

describe('SseGate', () => {
  it('grants up to max slots, rejects beyond, and frees on release', () => {
    const gate = new SseGate(2);
    const a = gate.tryAcquire();
    const b = gate.tryAcquire();
    expect(a).toBeTypeOf('function');
    expect(b).toBeTypeOf('function');
    expect(gate.tryAcquire()).toBeNull();
    expect(gate.count).toBe(2);
    b!();
    expect(gate.count).toBe(1);
    expect(gate.tryAcquire()).toBeTypeOf('function');
  });

  it('release is idempotent', () => {
    const gate = new SseGate(1);
    const rel = gate.tryAcquire()!;
    rel();
    rel();
    expect(gate.count).toBe(0);
  });
});
