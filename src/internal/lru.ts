import type { Clock } from "./clock.js";
import { systemClock } from "./clock.js";

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/**
 * Bounded map with per-entry TTL and least-recently-used eviction.
 *
 * The bound is a security property, not a nicety. Every per-actor structure in this
 * library is keyed by something an attacker controls (an IP, a fingerprint), so an
 * unbounded map is a remote OOM waiting to happen. Capacity is enforced on every
 * insert; expiry is checked lazily on read plus a bounded sweep on insert, so a
 * quiet process never keeps a timer alive.
 */
export class TtlLru<V> {
  private readonly entries = new Map<string, Entry<V>>();

  constructor(
    private readonly capacity: number,
    private readonly ttlMs: number,
    private readonly clock: Clock = systemClock,
  ) {
    if (capacity < 1) throw new RangeError("TtlLru capacity must be at least 1");
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Every live value, most recently used last — the Map's own insertion order, which
   * `get` and `set` maintain.
   *
   * Expired entries are skipped rather than deleted, because this is a read: a caller
   * listing what is in the cache should not be the thing that evicts from it, and the
   * next `get` or `set` on that key will clear it anyway.
   */
  values(): V[] {
    const now = this.clock.now();
    const live: V[] = [];
    for (const entry of this.entries.values()) if (entry.expiresAt > now) live.push(entry.value);
    return live;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.clock.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert to move to the end: Map preserves insertion order, so the first
    // key is always the least recently used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    const now = this.clock.now();
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    if (this.entries.size > this.capacity) this.evict(now);
  }

  /** Reads, or creates via `factory` and stores. The common read-modify-write path. */
  getOrCreate(key: string, factory: () => V): V {
    const existing = this.get(key);
    if (existing !== undefined) return existing;
    const created = factory();
    this.set(key, created);
    return created;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  private evict(now: number): void {
    // Sweep a bounded number of expired entries first — reclaiming dead space is
    // always better than evicting a live actor. The cap keeps insert O(1)-ish.
    let scanned = 0;
    for (const [key, entry] of this.entries) {
      if (scanned++ >= 32) break;
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }
}
