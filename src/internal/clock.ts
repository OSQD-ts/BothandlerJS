/**
 * Injectable time. Every stateful detector reads `now()` from here rather than
 * calling `Date.now()`, which is what makes rate, cadence and expiry logic testable
 * without sleeping and without flaky wall-clock assumptions.
 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Test double: time only advances when you say so. */
export class ManualClock implements Clock {
  constructor(private current = 0) {}
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
  set(ms: number): void {
    this.current = ms;
  }
}
