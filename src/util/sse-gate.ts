/**
 * Bounded counter for concurrent SSE connections. The event bus intentionally
 * has no listener cap (each stream cleans up on disconnect); this gate bounds
 * the number of streams at the connection layer instead, so a runaway client
 * can't grow the per-publish fan-out without limit.
 */
export class SseGate {
  private n = 0;
  constructor(private readonly max: number) {}

  /** A release function when a slot is free, null when at capacity. */
  tryAcquire(): (() => void) | null {
    if (this.n >= this.max) return null;
    this.n++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.n--;
      }
    };
  }

  get count(): number {
    return this.n;
  }
}
