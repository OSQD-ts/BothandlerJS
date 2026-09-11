import { TtlLru } from "./internal/lru.js";
import { safeSummary } from "./internal/text.js";
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
/* Distinct query strings held per actor. Same argument as PATH_CAP: enough to tell a
   sweep from a person changing a filter twice, and bounded so a single actor cannot make
   the registry grow without limit. */
const QUERY_CAP = 64;
/* Distinct methods held per actor. There are only nine worth naming, and the cap stops a
   client inventing verbs from growing the set. */
const METHOD_CAP = 12;
/* Path shapes watched per actor for a numeric walk. Four is enough to catch an actor
   working through `/user/#` while also reading `/article/#`, and small enough that the
   memory is three numbers times four rather than a list of every id seen. */
const WALK_CAP = 4;
/* Identities remembered per actor. A client that has honestly claimed a dozen different
   names is already the finding; counting further costs memory and says nothing new. */
const IDENTITY_CAP = 12;
/* How much of a path shape is kept as the key for a numeric walk.
   The client chooses the path, so without this the key is as long as the path: measured at
   4,292 characters from a single request, and four of those per actor across twenty
   thousand actors is roughly four hundred megabytes of somebody else's text. A shape
   longer than this is not something anybody walks, and the prefix is enough to name it in
   the evidence. */
const TEMPLATE_CHARS = 120;
/* Path segments examined for a numeric walk. Deeper than this is not a shape anybody
   walks, and the work is per request on a value the client chooses. */
const MAX_WALK_SEGMENTS = 24;
/* And a length bound, checked before the split allocates a string per segment. */
const MAX_WALK_PATH_CHARS = 512;
/* Query parameters folded into a signature, for the same reason. */
const MAX_QUERY_KEYS = 24;
/* Hoisted: a literal in a hot loop is recompiled on some engines and re-tested from index
   zero on others. */
const DIGITS = /^\d+$/;
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
export const MAX_TRACKED_QUERIES = QUERY_CAP;
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
  /**
   * Distinct *parameterised* requests: the path together with its query.
   *
   * Counted apart from `paths` because the two answer different questions and a scraper
   * lives in the gap between them. `/products?page=1` through `?page=200` is one path and
   * two hundred requests, so breadth reads it as somebody rereading a single page — which
   * is exactly what enumerating a catalogue looks like from the path alone.
   */
  private readonly queries = new Set<number>();
  private queriesOverflowed = false;
  /**
   * Which HTTP methods this actor has used.
   *
   * A browser navigating issues GET. Something that has issued nothing but HEAD across a
   * long visit is checking what exists rather than reading it, and that is a fact about
   * the actor rather than about any one of its requests — which is why it is kept here.
   */
  /**
   * What has happened with this actor's marker cookie.
   *
   * Counted rather than listed: the useful questions are all "how often", and a list of
   * marker ids would grow with a client's cookie jar for no benefit. The three drift
   * flags are sticky — once a client has been seen claiming two different browsers under
   * one marker it has done so, and a later request that looks tidy again does not undo
   * it. That is the point of correlating a series rather than judging a request.
   */
  /**
   * When this actor was last challenged, and how it described itself at that moment.
   *
   * Kept so that what a client does *in response* to being challenged can be read. That
   * reaction is better evidence than anything observed passively, because the stimulus
   * was ours: we chose the moment, so a change of identity that follows it within
   * seconds is a reaction to it rather than a coincidence we went looking for.
   */
  /**
   * Answers to challenges that were valid in form but wrong in a way only the series
   * shows: a solution already spent, or one returned faster than the puzzle allows.
   */
  /** Requests for a path no other client had ever asked this site for. */
  private novelPaths = 0;
  private replayedSolutions = 0;
  private implausibleSolves = 0;
  private challengedAt = 0;
  private challengeShape: { b: string; o: string; l: string } | undefined;
  private markerIssues = 0;
  private markerReturns = 0;
  private markerForgeries = 0;
  private driftSeen = { browser: false, platform: false, language: false };
  private driftEvents = 0;
  private readonly methods = new Set<string>();
  /**
   * Numeric walks in progress, by path shape: `/user/#` against the ids requested under it.
   *
   * Three numbers per shape, deliberately — a count, a lowest and a highest — rather than
   * the ids themselves. What separates enumeration from reading is not which ids were
   * asked for but whether they *cover a range*: thirty requests spanning thirty
   * consecutive ids is a walk, and thirty scattered across a hundred thousand is somebody
   * following links. Both are answerable from a count and a span, and only the count and
   * the span survive an actor asking for ten thousand of them.
   */
  private readonly walks = new Map<string, { count: number; min: number; max: number }>();
  /**
   * Every named identity this actor has claimed, and what kind each was.
   *
   * Kept because the interesting question is not what one request said but what the *set*
   * of them says. One address claiming sqlmap and nikto is a scan; one claiming Googlebot
   * and Bingbot is a forgery, since at most one of those can be true of an address. Neither
   * observation exists inside a single request.
   */
  private readonly identities = new Map<string, { category: string; verifiable: boolean }>();
  /**
   * A name somebody gave this actor.
   *
   * Nothing in detection reads it. It exists because an address is not a memory: the
   * person who worked out that `198.51.100.4` is the partner's price feed should be able
   * to write that down where the next person will see it, rather than in a ticket.
   */
  private actorLabel: string | undefined;
  /** Requests from this actor that carried a scanner payload or target. */
  private probePayloads = 0;
  /**
   * What the application answered, for the requests anybody bothered to tell us about.
   *
   * The engine decides *before* the response exists, so this arrives afterwards and only
   * when the adapter reports it. Kept as two counters rather than a list because the one
   * question worth asking is a ratio: an actor whose requests are almost all misses is
   * looking for something rather than reading anything.
   */
  private responsesSeen = 0;
  private missesSeen = 0;
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

    // Sorted, so `?a=1&b=2` and `?b=2&a=1` are one request rather than two — otherwise a
    // client that reorders parameters would look like a sweep for free.
    // Counted before sorting. Sorting two hundred keys and *then* deciding the signature
    // is not worth building is work a client can ask for by sending two hundred keys.
    const keys = Object.keys(facts.query);
    if (keys.length > 0 && keys.length <= MAX_QUERY_KEYS) {
      keys.sort();
      const signature = `${facts.path}?${keys.map((key) => `${key}=${facts.query[key] ?? ""}`).join("&")}`;
      const queryHash = hashString(signature);
      if (this.queries.size < QUERY_CAP) this.queries.add(queryHash);
      else if (!this.queries.has(queryHash)) this.queriesOverflowed = true;
    }

    if (this.methods.size < METHOD_CAP) this.methods.add(facts.method);
    this.noteWalk(facts.path);

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

  /** Distinct path-and-query combinations seen. Saturates at {@link QUERY_CAP}. */
  get distinctQueries(): number {
    return this.queries.size;
  }

  get queriesSaturated(): boolean {
    return this.queriesOverflowed;
  }

  /**
   * Records what the application answered. Called after the response, if at all.
   *
   * 404 and 410 only. A 403 is usually this library's own doing and counting it would
   * make the detector that reads this argue with itself; a 500 is the site's problem and
   * says nothing about the client.
   */
  recordOutcome(status: number): void {
    this.responsesSeen++;
    if (status === 404 || status === 410) this.missesSeen++;
  }

  /** Responses reported for this actor. Zero unless something is reporting them. */
  get responses(): number {
    return this.responsesSeen;
  }

  /** Of those, how many were 404 or 410. */
  get misses(): number {
    return this.missesSeen;
  }

  /** Names this actor, or clears the name when given nothing. Trimmed and bounded. */
  setLabel(label: string | undefined): void {
    this.actorLabel = cleanLabel(label);
  }

  get label(): string | undefined {
    return this.actorLabel;
  }

  /** Records a named identity this actor claimed. Called once per matching signature. */
  noteIdentity(id: string, category: string, verifiable: boolean): void {
    if (this.identities.has(id) || this.identities.size >= IDENTITY_CAP) return;
    this.identities.set(id, { category, verifiable });
  }

  /** Records that this request was for a path the site had never served to anybody. */
  noteNovelPath(): void {
    if (this.novelPaths < 1_000_000) this.novelPaths++;
  }

  /** How many of this actor's requests were for a path nobody else had ever asked for. */
  get novelPathCount(): number {
    return this.novelPaths;
  }

  /** Records something wrong with a submitted solution that only its history reveals. */
  noteChallengeAnomaly(kind: "replay" | "implausible-speed"): void {
    if (kind === "replay") {
      if (this.replayedSolutions < 1_000_000) this.replayedSolutions++;
    } else if (this.implausibleSolves < 1_000_000) this.implausibleSolves++;
  }

  /** Solutions this actor submitted that had already been spent, and ones returned too fast. */
  get challengeAnomalies(): { replays: number; implausible: number } {
    return { replays: this.replayedSolutions, implausible: this.implausibleSolves };
  }

  /** Records that a challenge went out, and the identity claimed as it did. */
  noteChallengeIssued(at: number, shape: { b: string; o: string; l: string } | undefined): void {
    this.challengedAt = at;
    this.challengeShape = shape;
  }

  /** The moment of the last challenge, and the identity claimed then. `at` is 0 for none. */
  get lastChallenge(): { at: number; shape: { b: string; o: string; l: string } | undefined } {
    return { at: this.challengedAt, shape: this.challengeShape };
  }

  /** Records that a marker was handed to this actor on the way out. */
  noteMarkerIssued(): void {
    // Saturating rather than unbounded: the ratio these feed stops being informative
    // long before the number gets large, and a counter on a per-actor record is a
    // counter multiplied by `maxActors`.
    if (this.markerIssues < 1_000_000) this.markerIssues++;
  }

  /** Records what this request's marker cookie turned out to be. */
  noteMarker(returned: boolean, forged: boolean, drift: { browser: boolean; platform: boolean; language: boolean } | undefined): void {
    if (returned && this.markerReturns < 1_000_000) this.markerReturns++;
    if (forged && this.markerForgeries < 1_000_000) this.markerForgeries++;
    if (drift === undefined) return;
    if (drift.browser || drift.platform || drift.language) {
      if (this.driftEvents < 1_000_000) this.driftEvents++;
    }
    this.driftSeen.browser ||= drift.browser;
    this.driftSeen.platform ||= drift.platform;
    this.driftSeen.language ||= drift.language;
  }

  /** Markers handed to this actor, and how many came back. */
  get markers(): { issued: number; returned: number; forged: number } {
    return { issued: this.markerIssues, returned: this.markerReturns, forged: this.markerForgeries };
  }

  /** Which parts of a claimed identity have ever changed under one marker. */
  get identityDrift(): { browser: boolean; platform: boolean; language: boolean; events: number } {
    return { ...this.driftSeen, events: this.driftEvents };
  }

  /** Records that this request carried a scanner payload, so later requests can know. */
  notePayloadProbe(): void {
    this.probePayloads++;
  }

  /** Every identity claimed so far, by id. */
  get claimedIdentities(): ReadonlyMap<string, { category: string; verifiable: boolean }> {
    return this.identities;
  }

  /** How many of this actor's requests carried a scanner payload or target. */
  get payloadProbes(): number {
    return this.probePayloads;
  }

  /**
   * Files a request under the shape of its path, if that path carries a number.
   *
   * The last numeric segment is the one taken to be the identifier: in `/api/v2/orders/42`
   * the version is part of the shape and the order id is what is being walked.
   */
  private noteWalk(path: string): void {
    const step = walkStepOf(path);
    if (step === undefined) return;
    const { template, id: value } = step;

    const existing = this.walks.get(template);
    if (existing !== undefined) {
      existing.count++;
      if (value < existing.min) existing.min = value;
      if (value > existing.max) existing.max = value;
      return;
    }
    if (this.walks.size < WALK_CAP) this.walks.set(template, { count: 1, min: value, max: value });
  }

  /**
   * The path shape this actor has walked hardest, with how far it reached.
   *
   * `span` is inclusive of both ends, so a walk of 1 to 30 spans 30. Comparing the count
   * against it is what separates covering a range from visiting a few points in one.
   */
  densestWalk(): { template: string; count: number; span: number } | undefined {
    let best: { template: string; count: number; span: number } | undefined;
    for (const [template, walk] of this.walks) {
      const span = walk.max - walk.min + 1;
      if (best === undefined || walk.count > best.count) best = { template, count: walk.count, span };
    }
    return best;
  }

  /** Every HTTP method this actor has used, in first-seen order. */
  get methodsSeen(): readonly string[] {
    return [...this.methods];
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
      distinctQueries: this.distinctQueries,
      methodsSeen: this.methodsSeen,
      ...(this.actorLabel === undefined ? {} : { label: this.actorLabel }),
      walk: this.densestWalk(),
      responses: this.responses,
      misses: this.misses,
      queriesSaturated: this.queriesSaturated,
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
  top(limit: number, now: number, offset = 0): ActorSummary[] {
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
    // `offset` is what lets a dashboard page past the busiest few. The sort is total and
    // stable for a given snapshot, so a page boundary falls in the same place twice —
    // but the underlying counts move, so paging deep into a live registry can still show
    // an actor twice or not at all. That is inherent in ranking something that changes,
    // not something an offset can fix.
    const from = Math.max(0, offset);
    return summaries.slice(from, from + Math.max(0, limit));
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

/**
 * One step of a numeric walk: the shape of the path, and the number in it.
 *
 * `/api/v2/orders/42` becomes `/api/v2/orders/#` and `42`. Shared between the per-actor
 * series and the site-wide one, which must agree on what a shape is or their counts
 * cannot be compared.
 *
 * Both bounds are checked without allocating, because both exist to stop a client paying
 * us to do work. `split` allocates a string per segment, so counting separators first is
 * what makes the depth check worth having. Measured on a sixty-segment path: 3.65µs
 * against 199ns for an ordinary one — every request eighteen times dearer, for free,
 * from anyone willing to send a long URL. The concatenation was most of it; the split
 * was the rest.
 */
export function walkStepOf(path: string): { template: string; id: number } | undefined {
  if (path.length > MAX_WALK_PATH_CHARS) return undefined;
  let depth = 0;
  for (let i = 0; i < path.length; i++) {
    if (path.charCodeAt(i) === 47 && ++depth > MAX_WALK_SEGMENTS) return undefined;
  }

  let value: number | undefined;
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "") continue;
    if (DIGITS.test(segment)) {
      const parsed = Number(segment);
      // Ignore anything that is not a plain counter. A timestamp or a very long id is not
      // something anybody walks, and it would make every span meaningless.
      if (Number.isSafeInteger(parsed) && parsed <= 10_000_000) value = parsed;
      parts.push("#");
    } else {
      parts.push(segment);
    }
  }
  if (value === undefined) return undefined;

  // Joined once rather than concatenated per segment, and bounded before it is used as a
  // key. See TEMPLATE_CHARS.
  let template = `/${parts.join("/")}`;
  if (template.length > TEMPLATE_CHARS) template = `${template.slice(0, TEMPLATE_CHARS)}…`;
  return { template, id: value };
}

/**
 * A label as it is kept: quoted, trimmed, bounded, and `undefined` when nothing is left.
 *
 * A label is typed by an operator but printed everywhere — the dashboard, the change log,
 * the warning emitted when it is set — so it is quoted like anything else.
 */
export function cleanLabel(label: string | undefined): string | undefined {
  const trimmed = label === undefined ? undefined : safeSummary(label).trim().slice(0, 120);
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
