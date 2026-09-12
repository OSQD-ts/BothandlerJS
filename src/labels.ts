import { IpRangeSet } from "./internal/ip.js";
import { TtlLru } from "./internal/lru.js";
import { cleanLabel } from "./state.js";
import type { Clock } from "./internal/clock.js";
import type { RequestFacts } from "./types.js";

/**
 * Naming the traffic you already recognise, without writing the plumbing for it.
 *
 * `labelActor` is the primitive and it is a good one, but on its own it is the beginning
 * of about a hundred and fifty lines that every deployment writes the same way: a format
 * for known address ranges, an `IpRangeSet` per entry, a cache so a name is written once
 * rather than on every request, a bound on that cache, a path for relabelling an actor
 * that later proves to be yours, and — the expensive one — an asynchronous lookup that
 * names a signed-in actor after its account.
 *
 * That last piece is where the bug lives, and an integration reported hitting exactly it:
 * mark the key "in flight", return early for later requests while the flag is set, clear
 * it when the lookup finishes. A lookup that *fails* is fine, because the `catch` clears
 * the flag. A lookup that **hangs** never finishes, so the flag is never cleared, so the
 * actor is never named — and nothing throws, nothing is logged, and the symptom is account
 * ids in the feed where names should be, with no error anywhere to explain it.
 *
 * So the timeout here is not a refinement, it is the feature. Every in-flight lookup is
 * settled one way or another, the flag is cleared in a `finally` that a hang cannot skip,
 * and a lookup that times out is reported rather than absorbed.
 *
 * ## Off the request path, on purpose
 *
 * A name is for whoever reads the dashboard. Nothing in detection reads it and no verdict
 * depends on it, so no request waits for one: the lookup is started and the request goes
 * on without it, and the name is there for the next request from that actor — usually
 * within milliseconds, and never at the cost of one.
 */
export interface LabelSource {
  /** What to call traffic from these addresses. */
  label: string;
  /** Addresses or CIDR ranges, in the form the allowlist takes. */
  cidrs: readonly string[];
  /** Keep this actor's requests out of the live feed. Still analysed, still counted. */
  hideFromFeed?: boolean;
}

export interface LabelOptions {
  /**
   * Address ranges you already know the name of: your CI runners, the office, a partner.
   *
   * Matched in order, so a narrower range listed first wins over a broader one after it.
   */
  sources?: readonly LabelSource[];
  /**
   * Names an actor the library cannot name by address — a signed-in account, a tenant, an
   * API key's owner.
   *
   * Called at most once per actor per `ttlMs`, never on the request path, and never
   * concurrently for the same key. Return `undefined` for "no name", which is cached
   * briefly so an unknown actor is not looked up on every request it makes.
   *
   * It may be slow and it may throw: both are handled. What it must not do is hang
   * forever without the library noticing, which is what `resolveTimeoutMs` is for.
   */
  resolve?: (key: string, facts: RequestFacts) => Promise<string | undefined> | string | undefined;
  /** How long to wait for `resolve` before giving up on that attempt. Default 500ms. */
  resolveTimeoutMs?: number;
  /** How long a resolved name is kept before it is looked up again. Default one hour. */
  ttlMs?: number;
  /** How long to wait before asking again about an actor that resolved to no name. Default one minute. */
  retryAfterMs?: number;
  /**
   * Most resolved names held at once. Default 10,000.
   *
   * These are derived rather than typed, so the oldest is dropped silently when the limit
   * is reached — it can always be derived again. A name somebody typed is kept separately
   * and is never evicted to make room for one of these.
   */
  max?: number;
}

const DEFAULTS = { resolveTimeoutMs: 500, ttlMs: 60 * 60_000, retryAfterMs: 60_000, max: 10_000 };

/** What a source matched, or a resolver returned. `null` means "asked, and there is no name". */
type Resolved = { name: string; hideFromFeed?: boolean } | null;

export class LabelResolver {
  private readonly sources: ReadonlyArray<{ label: string; hideFromFeed: boolean; ranges: IpRangeSet }>;
  private readonly resolve: LabelOptions["resolve"];
  private readonly resolveTimeoutMs: number;
  private readonly retryAfterMs: number;
  private readonly cache: TtlLru<Resolved>;
  /**
   * Keys with a lookup in flight.
   *
   * Cleared in a `finally`, which is the whole point — see the note on hanging lookups
   * above. A `Map` rather than a `Set` so the pending promise can be awaited by tests
   * without exposing a second mechanism for it.
   */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    options: LabelOptions,
    private readonly clock: Clock,
    private readonly onName: (key: string, name: string, hideFromFeed: boolean) => void,
    private readonly onFailure: (error: unknown) => void,
  ) {
    const bad: string[] = [];
    this.sources = (options.sources ?? []).map((source) => {
      const ranges = new IpRangeSet(source.cidrs);
      // A mistyped CIDR that matches nothing is a label that never appears, which reads as
      // the feature not working. Collected and reported by the caller rather than thrown:
      // one bad range should not stop a handler from starting.
      if (ranges.invalid.length > 0) bad.push(`${source.label}: ${ranges.invalid.join(", ")}`);
      return { label: cleanLabel(source.label) ?? source.label, hideFromFeed: source.hideFromFeed === true, ranges };
    });
    this.invalid = bad;
    this.resolve = options.resolve;
    this.resolveTimeoutMs = options.resolveTimeoutMs ?? DEFAULTS.resolveTimeoutMs;
    this.retryAfterMs = options.retryAfterMs ?? DEFAULTS.retryAfterMs;
    this.cache = new TtlLru<Resolved>(Math.max(1, options.max ?? DEFAULTS.max), options.ttlMs ?? DEFAULTS.ttlMs, clock);
  }

  /** Ranges that could not be parsed, for the caller to warn about. */
  readonly invalid: readonly string[];

  get active(): boolean {
    return this.sources.length > 0 || this.resolve !== undefined;
  }

  /** The name for an address from a configured source, if one covers it. */
  private fromSources(ip: string): Resolved {
    for (const source of this.sources) {
      if (source.ranges.contains(ip)) return { name: source.label, ...(source.hideFromFeed ? { hideFromFeed: true } : {}) };
    }
    return null;
  }

  /**
   * Names this actor if it can, and starts a lookup if it cannot.
   *
   * Returns immediately, always. The address check is a range lookup and is answered here;
   * anything needing the resolver is started and left to finish on its own.
   */
  see(key: string, facts: RequestFacts): void {
    const known = this.cache.get(key);
    if (known !== undefined) return;

    const bySource = this.fromSources(facts.ip);
    if (bySource !== null) {
      this.cache.set(key, bySource);
      this.onName(key, bySource.name, bySource.hideFromFeed === true);
      return;
    }
    if (this.resolve === undefined) {
      this.cache.set(key, null);
      return;
    }
    // Asked recently and given no name, or the last attempt failed. Either way, not again
    // yet: without this, an actor nobody can name is looked up on every request it makes,
    // which turns a busy unknown client into a denial-of-service against your own
    // account lookup.
    if (this.heldOff(key) || this.inFlight.has(key)) return;

    // The entry is registered here, and removed by the `finally` below rather than by one
    // inside `lookup`. The difference is not style. An `async` function runs its body
    // synchronously up to its first `await`, so a resolver that throws *synchronously* —
    // a null dereference, a bad config read — finishes the whole try/catch/finally before
    // `lookup()` has even returned a promise to assign. A `finally` inside it would then
    // delete an entry that had not been created yet, and the `set` on the next line would
    // put it back for ever: the key stuck in flight, the actor never named, and nothing
    // logged. Which is precisely the bug this class was written to stop happening.
    //
    // A promise's `finally` callback is always a microtask, so this one cannot run before
    // the `set` above it has.
    this.inFlight.set(
      key,
      this.lookup(key, facts).finally(() => {
        this.inFlight.delete(key);
      }),
    );
  }

  private async lookup(key: string, facts: RequestFacts): Promise<void> {
    try {
      // Raced against a timer rather than merely awaited. A resolver that never settles
      // is the failure this class exists to prevent, and `await` on its own would hold
      // this key's entry in `inFlight` for the life of the process.
      const name = await Promise.race([
        Promise.resolve(this.resolve?.(key, facts)),
        new Promise<typeof TIMED_OUT>((resolve) => {
          const timer = setTimeout(() => resolve(TIMED_OUT), this.resolveTimeoutMs);
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);

      if (name === TIMED_OUT) {
        // Said out loud, because the alternative is the exact silence being fixed here:
        // ids where names should be, and nothing anywhere to say why.
        this.onFailure(new Error(`Naming actor "${key}" timed out after ${this.resolveTimeoutMs}ms. It keeps its key until the lookup is tried again.`));
        this.holdOff(key);
        return;
      }
      const clean = cleanLabel(typeof name === "string" ? name : undefined);
      if (clean === undefined) {
        // Asked, and there is no name. Cached briefly so that an actor nobody can name is
        // not looked up again on its every request.
        this.holdOff(key);
        return;
      }
      this.cache.set(key, { name: clean });
      this.onName(key, clean, false);
    } catch (error) {
      this.onFailure(error);
      this.holdOff(key);
    }
  }

  /** Remembers that this key has no name *for now*, so it is asked about again later. */
  private holdOff(key: string): void {
    const until = this.clock.now() + this.retryAfterMs;
    this.pending.set(key, until);
  }

  private readonly pending = new Map<string, number>();

  /** Whether this key is inside its back-off window. Also prunes as it goes. */
  private heldOff(key: string): boolean {
    const until = this.pending.get(key);
    if (until === undefined) return false;
    if (this.clock.now() >= until) {
      this.pending.delete(key);
      return false;
    }
    return true;
  }

  /** For tests: settles every lookup currently in flight. */
  async settle(): Promise<void> {
    await Promise.all([...this.inFlight.values()]);
  }
}

const TIMED_OUT = Symbol("timed-out");
