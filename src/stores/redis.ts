import { systemClock } from "../internal/clock.js";
import type { BotHandlerStore } from "./types.js";
import type { Clock } from "../internal/clock.js";

/**
 * The handful of commands this store needs, described structurally.
 *
 * Declaring the shape rather than importing a client keeps `ioredis` and `node-redis`
 * out of this library's dependency tree — you pass whichever you already run. Both
 * satisfy this interface as-is.
 */
export interface RedisLike {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<unknown>;
  /**
   * `SET key value PX ttl [NX]`.
   *
   * Both forms are needed and they are not interchangeable: `consumeOnce` requires
   * `NX` (the atomic claim that makes replay protection work), while `set` must
   * overwrite or it silently keeps the first value written under a key forever.
   */
  set(key: string, value: string, mode: "PX", ttl: number, condition?: "NX"): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
}

export interface RedisStoreOptions {
  /** Prefix for every key. Default `"bh:"`. Change it if the instance is shared. */
  prefix?: string;
  /**
   * Where the window boundary comes from. Defaults to the system clock.
   *
   * Present for the same reason every other stateful piece of this library takes one:
   * a fixed window derived from `Date.now()` cannot be tested without sleeping, and a
   * rate limit is exactly the thing you want to test at the boundary rather than
   * near it. Pass the handler's own clock to keep one notion of time throughout.
   */
  clock?: Clock;
}

/**
 * Redis-backed shared state, for deployments with more than one replica.
 *
 * This is the configuration in which single-use tokens and rate limits actually mean
 * what they say — see {@link BotHandlerStore} for why per-instance memory silently
 * weakens both.
 *
 * Note what is deliberately *not* here: nothing writes per-request behavioural data.
 * Detection stays local and synchronous. A Redis round-trip happens only when a
 * challenge is solved or a rate limit is consulted, so a slow or unavailable Redis
 * costs you those two features and leaves everything else untouched.
 */
export class RedisStore implements BotHandlerStore {
  private readonly prefix: string;
  private readonly clock: Clock;

  constructor(
    private readonly client: RedisLike,
    options: RedisStoreOptions = {},
  ) {
    this.prefix = options.prefix ?? "bh:";
    this.clock = options.clock ?? systemClock;
  }

  async increment(key: string, windowMs: number): Promise<number> {
    const bucket = Math.floor(this.clock.now() / windowMs);
    const full = `${this.prefix}c:${key}:${bucket}`;
    const count = await this.client.incr(full);
    // Only the first increment needs to arm the expiry. Re-arming on every request
    // would turn a fixed window into a sliding one that never expires under load.
    if (count === 1) await this.client.pexpire(full, windowMs);
    return count;
  }

  async consumeOnce(key: string, ttlMs: number): Promise<boolean> {
    const result = await this.client.set(`${this.prefix}n:${key}`, "1", "PX", ttlMs, "NX");
    // `SET … NX` returns "OK" when it wrote and null when the key already existed.
    return result !== null && result !== undefined;
  }

  async get(key: string): Promise<string | undefined> {
    const value = await this.client.get(`${this.prefix}v:${key}`);
    return value ?? undefined;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    // No `NX` here. `set` overwrites by definition, and an earlier version of this
    // method passed `NX` — which made every write after the first a silent no-op.
    await this.client.set(`${this.prefix}v:${key}`, value, "PX", ttlMs);
  }

  async delete(key: string): Promise<void> {
    await this.client.del(`${this.prefix}v:${key}`);
  }
}
