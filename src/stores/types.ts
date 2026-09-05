/**
 * Shared state, for the two things that genuinely need it across replicas.
 *
 * The library keeps its behavioural series in-process on purpose (see `state.ts`),
 * so this interface is small by design. It exists for the cases where a per-instance
 * answer is actually *wrong* rather than merely less precise:
 *
 * - **Single-use tokens.** A challenge solution accepted twice is a replay. With
 *   per-instance memory a scraper simply retries against another replica until it
 *   lands on one that has not seen the nonce, which defeats the mechanism entirely.
 * - **Rate limiting.** A limit of 100/minute enforced independently by four replicas
 *   is a limit of 400/minute.
 *
 * Every method may reject. Callers treat a rejection as "no answer" and fail *open* —
 * a store outage must degrade detection, never take down the site it protects.
 */
export interface BotHandlerStore {
  /**
   * Adds one to a counter that expires `windowMs` after its first increment, and
   * returns the new value. A fixed window, not a sliding one: it is one round trip
   * instead of several, and the extra precision buys nothing for a mechanism whose
   * job is to bound abuse rather than to measure it.
   */
  increment(key: string, windowMs: number): Promise<number>;

  /**
   * Atomically claims `key`. Returns `true` the first time and `false` for every
   * subsequent call within `ttlMs`.
   *
   * Atomicity is the whole point — a `get` followed by a `set` has a window in which
   * two concurrent replays both succeed. Implementations must use a single
   * check-and-set operation.
   */
  consumeOnce(key: string, ttlMs: number): Promise<boolean>;

  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}
