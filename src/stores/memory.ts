import { TtlLru } from "../internal/lru.js";
import { systemClock } from "../internal/clock.js";
import type { Clock } from "../internal/clock.js";
import type { BotHandlerStore } from "./types.js";

export interface MemoryStoreOptions {
  /** Maximum distinct counter keys held. Default 100000. */
  maxCounters?: number;
  /** Maximum single-use token keys held. Default 100000. */
  maxTokens?: number;
  /** Maximum general key/value entries held. Default 20000. */
  maxValues?: number;
  clock?: Clock;
}

/**
 * In-process store. The default, and correct for a single instance.
 *
 * Every structure is a bounded LRU, so this cannot be grown without limit by a
 * client sending unbounded distinct keys. That bounding has a consequence worth
 * knowing: under heavy key churn an old single-use token can be evicted before it
 * expires, and a replay of *that* token would then succeed. If replay resistance
 * matters to you — and on more than one replica it definitely does — use
 * {@link RedisStore}.
 */
export class MemoryStore implements BotHandlerStore {
  private readonly counters: TtlLru<{ count: number }>;
  private readonly tokens: TtlLru<{ expiresAt: number }>;
  private readonly values: TtlLru<{ value: string; expiresAt: number }>;
  private readonly clock: Clock;

  constructor(options: MemoryStoreOptions = {}) {
    this.clock = options.clock ?? systemClock;
    // The LRU's own TTL is a ceiling; per-entry windows are enforced by the stored
    // expiry, so one instance can serve several different window lengths.
    this.counters = new TtlLru(options.maxCounters ?? 100_000, 3_600_000, this.clock);
    this.tokens = new TtlLru(options.maxTokens ?? 100_000, 86_400_000, this.clock);
    this.values = new TtlLru(options.maxValues ?? 20_000, 86_400_000, this.clock);
  }

  async increment(key: string, windowMs: number): Promise<number> {
    const now = this.clock.now();
    const bucket = Math.floor(now / windowMs);
    // Bucketing into the key gives a fixed window with no separate expiry
    // bookkeeping: the previous window's key is simply never touched again.
    const bucketKey = `${key}:${bucket}`;
    const entry = this.counters.get(bucketKey) ?? { count: 0 };
    entry.count++;
    this.counters.set(bucketKey, entry);
    return entry.count;
  }

  async consumeOnce(key: string, ttlMs: number): Promise<boolean> {
    const now = this.clock.now();
    const claimed = this.tokens.get(key);
    // The caller's window is honoured rather than discarded in favour of the LRU's
    // own. Ignoring it meant a claim was remembered for a flat hour whatever was
    // asked for: wasteful for the two-minute default, and quietly wrong for anyone
    // configuring a longer challenge lifetime, whose solutions became replayable an
    // hour in while the challenge that produced them was still valid.
    if (claimed !== undefined && claimed.expiresAt > now) return false;
    this.tokens.set(key, { expiresAt: now + ttlMs });
    return true;
  }

  async get(key: string): Promise<string | undefined> {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.clock.now()) {
      this.values.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.values.set(key, { value, expiresAt: this.clock.now() + ttlMs });
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}
