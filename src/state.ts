import { TtlLru } from "./internal/lru.js";
import type { Clock } from "./internal/clock.js";
import type { ActorSnapshot, RequestFacts } from "./types.js";

/**
 * Per-actor behavioural memory.
 *
 * Everything here is bounded by construction. An actor's history is a fixed-size
 * ring of timestamps and a capped set of paths, and the registry holding actors is
 * itself a bounded LRU. There is no configuration that makes any of it grow without
 * limit, because every key in this file is attacker-chosen.
 *
 * This state is deliberately **process-local**. The alternative — a network
 * round-trip per request to read a shared series — would put a store on the critical
 * path of every request to buy accuracy for signals that are, by design, only ever
 * allowed to raise suspicion rather than block. Shared counting is available where
 * it actually pays for itself: see the `CounterStore` used by rate limiting.
 */

/**
 * Per-actor caps.
 *
 * These are a memory budget, and the arithmetic is worth doing explicitly because it
 * is what stops a bot-detection library from becoming the reason a service falls
 * over. At the defaults — 20,000 tracked actors — one actor costs roughly 32 arrival
 * timestamps (256 bytes), 64 path hashes, and up to 4 User-Agent strings, which lands
 * a full registry in the low tens of megabytes rather than the hundreds.
 *
 * Paths are stored as 32-bit hashes rather than strings for the same reason: 64 URLs
 * per actor, kept as strings, is kilobytes per actor and gigabytes per registry.
 * Hashes collide, so `distinctPaths` is a slight undercount — entirely acceptable for
 * a signal that is only ever allowed to be `weak`.
 */
const TIMESTAMP_RING = 32;
const PATH_CAP = 64;
const UA_CAP = 4;

/**
 * The ceilings a detector's thresholds have to live under.
 *
 * Exported because they are not an implementation detail to anyone configuring a
 * threshold: an actor's arrival count and distinct-User-Agent count both saturate
 * here, so a threshold above them can never be reached and the detector is silently
 * switched off. That is the failure this library refuses to ship elsewhere — a
 * control that looks configured and is not — so the detectors check against these and
 * refuse to be built that way.
 */
export const MAX_TRACKED_ARRIVALS = TIMESTAMP_RING;
export const MAX_TRACKED_PATHS = PATH_CAP;
export const MAX_TRACKED_USER_AGENTS = UA_CAP;

export class ActorState {
  readonly key: string;
  readonly firstSeen: number;
  lastSeen: number;
  /** Total requests seen in this actor's lifetime within the registry window. */
  total = 0;
  /** Assessments *this process* concluded were `confirmed-bot`. */
  confirmations = 0;
  /**
   * Confirmations other replicas had already recorded when this instance first saw the
   * actor, or `undefined` when nothing shared them.
   *
   * Kept apart from the local count rather than added into it, so that the two facts
   * stay distinguishable: what we saw, and what we were told. `priorConfirmations` is
   * their sum, which is the number a rule means when it says
   * `minPriorConfirmations: 1`.
   */
  sharedConfirmations: number | undefined;
  /** Epoch ms until which a valid human clearance token stands. */
  clearedUntil = 0;
  /**
   * Challenges issued to this actor that no solution ever came back for.
   *
   * Incremented when one is issued and cleared when one is solved, so it is the number
   * *outstanding* rather than a lifetime total: an actor challenged five times that
   * solved the fifth reads zero, and one challenged five times that solved none reads
   * five.
   *
   * The distinction is the whole signal. A person who abandons one challenge is
   * ordinary — a slow phone, a lost tab, a change of mind. A client that has been asked
   * five times and never once come back is not abandoning; it is unable or unwilling,
   * and both of those are facts about software.
   */
  unsolvedChallenges = 0;

  private readonly timestamps = new Float64Array(TIMESTAMP_RING);
  private ringLength = 0;
  private ringNext = 0;
  private readonly paths = new Set<number>();
  private pathsOverflowed = false;
  private pathsSaturatedAtTotal = 0;
  private readonly userAgents = new Set<string>();

  constructor(key: string, now: number) {
    this.key = key;
    this.firstSeen = now;
    this.lastSeen = now;
  }

  /** Records an arrival. Called exactly once per request, by the engine. */
  record(facts: RequestFacts): void {
    this.total++;
    this.lastSeen = facts.timestamp;
    this.timestamps[this.ringNext] = facts.timestamp;
    this.ringNext = (this.ringNext + 1) % TIMESTAMP_RING;
    if (this.ringLength < TIMESTAMP_RING) this.ringLength++;

    const pathHash = hashString(facts.path);
    if (this.paths.size < PATH_CAP) this.paths.add(pathHash);
    else if (!this.paths.has(pathHash) && !this.pathsOverflowed) {
      this.pathsOverflowed = true;
      // The request count at the moment counting stopped being possible. Without it
      // the only ratio available is `PATH_CAP / total`, which decays towards zero as
      // an actor keeps going — so the heavier the crawl, the more it resembles
      // somebody rereading one page.
      this.pathsSaturatedAtTotal = this.total;
    }

    const ua = facts.headers["user-agent"];
    if (ua !== undefined && this.userAgents.size < UA_CAP) this.userAgents.add(ua);
  }

  /** Distinct paths seen, by hash. Saturates at {@link PATH_CAP}; `pathsSaturated` says whether it did. */
  get distinctPaths(): number {
    return this.paths.size;
  }

  get pathsSaturated(): boolean {
    return this.pathsOverflowed;
  }

  /**
   * Requests seen when {@link distinctPaths} stopped being able to grow, or 0 if it
   * still can. Over that many requests the distinct count is exact, so it is the only
   * window in which a novelty ratio means anything.
   */
  get requestsWhenPathsSaturated(): number {
    return this.pathsSaturatedAtTotal;
  }

  /** Distinct User-Agent strings. More than one from a single actor is unusual for a person. */
  get distinctUserAgents(): number {
    return this.userAgents.size;
  }

  /** Milliseconds since the previous request, or `undefined` when this is the first. */
  sinceLast(now: number): number | undefined {
    if (this.ringLength < 2) return undefined;
    const previousIndex = (this.ringNext - 2 + TIMESTAMP_RING) % TIMESTAMP_RING;
    return now - this.timestamps[previousIndex]!;
  }

  /**
   * Requests received in the last `windowMs`.
   *
   * Saturates at {@link TIMESTAMP_RING}: a very heavy actor is reported as exactly
   * that number, not its true rate, and `ringSaturated` says so. That ceiling is
   * deliberate. This series exists to *describe* an actor cheaply, and precise
   * counting belongs to the rate-limit action, which uses the store and is exact.
   */
  requestsWithin(windowMs: number, now: number): number {
    const cutoff = now - windowMs;
    let count = 0;
    for (let i = 0; i < this.ringLength; i++) {
      if (this.timestamps[i]! > cutoff) count++;
    }
    return count;
  }

  /** True when the ring is full, i.e. `requestsWithin` may be undercounting a heavy actor. */
  get ringSaturated(): boolean {
    return this.ringLength === TIMESTAMP_RING;
  }

  /**
   * Gaps between consecutive arrivals, oldest first. The cadence detector looks at
   * the *variance* of these: a person's gaps are ragged, a `setInterval` loop's are
   * not.
   */
  intervals(): number[] {
    if (this.ringLength < 2) return [];
    const ordered: number[] = [];
    const start = this.ringLength < TIMESTAMP_RING ? 0 : this.ringNext;
    for (let i = 0; i < this.ringLength; i++) {
      ordered.push(this.timestamps[(start + i) % TIMESTAMP_RING]!);
    }
    const gaps: number[] = [];
    for (let i = 1; i < ordered.length; i++) gaps.push(ordered[i]! - ordered[i - 1]!);
    return gaps;
  }

  /**
   * Mean and dispersion of the arrival gaps, in one pass and without allocating.
   *
   * `intervals()` builds two arrays to answer the same question, and the cadence
   * detector asks it on every request from every actor with enough history. Welford's
   * algorithm gives the same numbers in a single walk of the ring with no garbage —
   * and, incidentally, without the catastrophic cancellation that the naive
   * sum-of-squares form suffers when gaps are large and their variance is small,
   * which is precisely the machine-regular case this statistic exists to detect.
   */
  intervalStats(): { count: number; mean: number; coefficientOfVariation: number } {
    if (this.ringLength < 2) return { count: 0, mean: 0, coefficientOfVariation: 0 };

    const start = this.ringLength < TIMESTAMP_RING ? 0 : this.ringNext;
    let previous = this.timestamps[start % TIMESTAMP_RING]!;
    let count = 0;
    let mean = 0;
    let m2 = 0;

    for (let i = 1; i < this.ringLength; i++) {
      const current = this.timestamps[(start + i) % TIMESTAMP_RING]!;
      const gap = current - previous;
      previous = current;
      count++;
      const delta = gap - mean;
      mean += delta / count;
      m2 += delta * (gap - mean);
    }

    if (count === 0 || mean <= 0) return { count, mean, coefficientOfVariation: 0 };
    return { count, mean, coefficientOfVariation: Math.sqrt(m2 / count) / mean };
  }

  snapshot(now: number): ActorSnapshot {
    return {
      key: this.key,
      requests: this.total,
      distinctPaths: this.distinctPaths,
      firstSeen: this.firstSeen,
      lastSeen: this.lastSeen,
      sinceLastMs: this.sinceLast(now),
      priorConfirmations: this.confirmations + (this.sharedConfirmations ?? 0),
      unsolvedChallenges: this.unsolvedChallenges,
      cleared: this.clearedUntil > now,
    };
  }
}

export interface ActorRegistryOptions {
  /** How long an idle actor is remembered. Default 900000 (15 min). */
  windowMs?: number;
  /** Maximum actors tracked concurrently. Default 20000. See the cap arithmetic above. */
  maxActors?: number;
}

/**
 * One actor as a list can show it: the snapshot every rule reads, plus the two
 * behavioural measures a person scanning for the worst offender actually wants.
 */
export interface ActorSummary extends ActorSnapshot {
  /** Requests in the last minute — a rate, where `requests` is a total. */
  recentRate: number;
  distinctUserAgents: number;
  /** Regularity of the gaps between requests. Near zero is metronomic; `undefined` is too few gaps to say. */
  cadenceCv: number | undefined;
}

/** Bounded LRU of {@link ActorState}, keyed by whatever `actorKey` produced. */
export class ActorRegistry {
  private readonly actors: TtlLru<ActorState>;

  constructor(
    private readonly clock: Clock,
    options: ActorRegistryOptions = {},
  ) {
    this.actors = new TtlLru<ActorState>(options.maxActors ?? 20_000, options.windowMs ?? 900_000, clock);
  }

  get size(): number {
    return this.actors.size;
  }

  /** Fetches or creates the state for `key` and records this request against it. */
  /**
   * Called once for each actor this registry has not seen before.
   *
   * The hook exists so `BotHandler` can go and ask the store what other replicas know
   * about a newcomer, without the registry itself learning what a store is. It fires
   * exactly once per actor per instance — not once per request — which is the whole
   * reason this is affordable: the thing `state.ts` refuses to do is a round trip on
   * the request path, not a round trip ever.
   */
  onFirstSight?: (state: ActorState) => void;

  observe(key: string, facts: RequestFacts): ActorState {
    // `get` then `set`, rather than `getOrCreate` then `set`. Both refresh the LRU
    // position, so going through `getOrCreate` first did the same delete-and-reinsert
    // twice on the hot path — once for nothing. The `set` is what must happen either
    // way: it refreshes the TTL as well as the position, so an actor still sending
    // traffic is never the one evicted to make room.
    const existing = this.actors.get(key);
    const state = existing ?? new ActorState(key, facts.timestamp);
    state.record(facts);
    this.actors.set(key, state);
    if (existing === undefined) this.onFirstSight?.(state);
    return state;
  }

  /** Reads without recording. Used by the clearance path, which must not inflate rates. */
  peek(key: string): ActorState | undefined {
    return this.actors.get(key);
  }

  /**
   * The busiest actors the registry is currently holding, most requests first.
   *
   * The registry knows about far more actors than any feed does — up to `maxActors`,
   * each with its rate series, its path breadth and its confirmations — while a
   * dashboard's ring holds a few hundred *requests*, which on a busy origin is a few
   * seconds. "Who is hitting me hardest right now" is a question only this can answer,
   * and until this method existed nothing could ask it.
   *
   * A read, and only a read: it neither records a request against an actor nor moves
   * one up the LRU, so watching the list cannot change what it lists.
   */
  top(limit: number, now: number): ActorSummary[] {
    const summaries = this.actors.values().map((state) => {
      const cadence = state.intervalStats();
      return {
        ...state.snapshot(now),
        recentRate: state.requestsWithin(60_000, now),
        distinctUserAgents: state.distinctUserAgents,
        // Undefined rather than zero when there are too few gaps to say anything: a
        // coefficient of variation over one interval is not a measurement, and zero is
        // the value that means "perfectly metronomic".
        cadenceCv: cadence.count >= 3 ? cadence.coefficientOfVariation : undefined,
      };
    });
    summaries.sort((a, b) => b.requests - a.requests);
    return summaries.slice(0, Math.max(0, limit));
  }

  forget(key: string): void {
    this.actors.delete(key);
  }

  clear(): void {
    this.actors.clear();
  }

  /** Marks an actor as holding valid human clearance until `until`. */
  clearUntil(key: string, until: number): void {
    const state = this.actors.getOrCreate(key, () => new ActorState(key, this.clock.now()));
    state.clearedUntil = Math.max(state.clearedUntil, until);
    this.actors.set(key, state);
  }
}

/**
 * FNV-1a, 32-bit. Not cryptographic and not meant to be — it identifies repeat visits
 * to the same path within one actor's short window, where a collision costs one
 * undercounted path in a `weak` signal.
 */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
